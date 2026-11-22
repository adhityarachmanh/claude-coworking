// bridge/src/chat-run.mjs — jalankan satu giliran chat: susun riwayat, kirim ke provider, alirkan jawaban
// sebagai SSE, lalu simpan pesan & pemakaian. Dites lewat fetchImpl palsu (tanpa jaringan).
import { buildRequest, messageProblem, parseStream, MAX_MESSAGE_CHARS } from './chat.mjs';
import { classify } from './auto.mjs';
import { modelForTier, defaultModelFor, EFFORT_LEVELS } from './providers.mjs';
import { decryptSecret } from './secrets.mjs';
import { makeCallModel } from './client.mjs';
import { runBrowsingTurn } from './browsing.mjs';
import { AttachmentError, attachmentChips, contentBlocks, readAttachments, renderTextBlocks } from './attachments.mjs';

/** System prompt dasar. Browsing menambah instruksi kutipan (lihat browsing.mjs). */
const BASE_SYSTEM = 'Kamu adalah asisten AI di Adhitron Web. Jawab dalam bahasa yang dipakai pengguna, ringkas dan jelas.';

const clampEffort = (e) => (EFFORT_LEVELS.includes(e) ? e : 'default');

/**
 * Bentuk riwayat untuk provider. Pesan user dibangun ulang sebagai array blok netral: blok teks lampiran
 * yang tersimpan (`meta.textBlocks`) disisipkan lagi, diikuti teks ketik. Gambar lama TIDAK dikirim ulang
 * (hemat token; lihat docs/design-adhitron-web.md §4). Pesan user tanpa isi apa pun dilewati agar provider
 * tidak menolak `content` kosong.
 */
const historyFor = (messages) => messages
  .filter((m) => m.role === 'user' || m.role === 'assistant')
  .map((m) => {
    if (m.role === 'assistant') return { role: m.role, content: m.content };
    const blocks = [
      ...(m.meta?.textBlocks ?? []).map((t) => ({ type: 'text', text: t })),
      ...(String(m.content ?? '').trim() ? [{ type: 'text', text: m.content }] : []),
    ];
    return { role: 'user', content: blocks };
  })
  .filter((m) => (typeof m.content === 'string' ? true : m.content.length > 0));

const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;

/**
 * Siapkan parameter giliran: provider, model, effort (Auto dihitung di sini bila aktif).
 * Mengembalikan { provider, apiKey, model, effort } atau { error }.
 */
export async function resolveTurn(env, user, conv, { fetchImpl, text }) {
  if (!conv.provider_id) return { error: 'Pilih provider dulu untuk percakapan ini' };
  const provider = await env.repo.getProvider(user.id, conv.provider_id);
  if (!provider) return { error: 'Provider tidak ditemukan' };
  const apiKey = await decryptSecret(env.encryptionKey, provider.api_key_enc);
  // Auto(LLM) membutuhkan callModel; produksi membuatnya di sini, test boleh menyuntik env.callModel.
  const callModel = env.callModel ?? makeCallModel(provider, apiKey, fetchImpl);

  let effort = clampEffort(conv.effort);
  let model = conv.model;
  // Auto(LLM): hitung effort & tier, lalu petakan tier ke model bila modelAuto aktif.
  if (conv.effort_auto || conv.model_auto) {
    const verdict = await classify({
      kind: provider.kind,
      prompt: text,
      providerModels: provider.models,
      callModel, // disuntik di produksi (client.mjs) & di test
    });
    if (verdict) {
      if (conv.effort_auto) effort = clampEffort(verdict.effort);
      if (conv.model_auto) model = modelForTier(provider.kind, verdict.tier, conv.model_tiers, provider.models);
    }
  }
  if (!model) model = defaultModelFor(provider.kind, provider.models);
  return { provider, apiKey, model, effort };
}

/**
 * Jalankan giliran dan kembalikan Response SSE. Event:
 *   { type:'meta', model, effort }        — apa yang dipakai
 *   { type:'text', text }                 — potongan jawaban
 *   { type:'tool', name, input }          — pemanggilan tool (browsing)
 *   { type:'sources', sources:[…] }       — kutipan bernomor
 *   { type:'done', messageId }            — selesai + id pesan asisten
 *   { type:'error', error }               — gagal (pesan tetap tersimpan bila ada)
 */
export async function runTurn(env, user, conv, request, { fetchImpl }) {
  const body = await request.json().catch(() => null);
  const text = String(body?.text ?? '').trim();
  // Lampiran divalidasi ulang di server sebelum apa pun disimpan; input salah → 400 tanpa efek samping.
  let items;
  try {
    items = readAttachments(body);
  } catch (err) {
    if (err instanceof AttachmentError) {
      return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    throw err;
  }
  const problem = messageProblem(text, items.length > 0);
  if (problem) {
    return new Response(JSON.stringify({ error: problem }), { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
  const resolved = await resolveTurn(env, user, conv, { fetchImpl, text });
  if (resolved.error) {
    return new Response(JSON.stringify({ error: resolved.error }), { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
  const { provider, apiKey, model, effort } = resolved;

  // Blok teks lampiran dirender SEKALI: dipakai untuk giliran ini DAN disimpan, agar id acak anti-injeksi
  // tetap sama saat riwayat dikirim ulang pada giliran lanjutan (docs §4).
  const textBlocks = renderTextBlocks(items);
  const blocks = contentBlocks(items, text, textBlocks);
  // Simpan chip + blok teks yang sudah dirender HANYA bila ada lampiran; isi gambar (base64) TIDAK disimpan.
  const meta = items.length ? { attachments: attachmentChips(items), textBlocks } : null;
  // Simpan pesan user lebih dulu (muncul di riwayat walau stream gagal).
  const userMsg = await env.repo.addMessage(user.id, conv.id, { role: 'user', content: text, meta });
  if (conv.title === 'Percakapan baru') {
    const title = text || items[0]?.name || 'Lampiran';
    await env.repo.updateConversation(user.id, conv.id, { title: title.slice(0, 60) });
  }
  const prior = await env.repo.listMessages(user.id, conv.id);
  const history = historyFor(prior.filter((m) => m.id !== userMsg.id));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Kumpulkan teks dari event yang dikirim, agar pesan parsial tetap tersimpan bila stream putus.
      const collected = { text: '' };
      const send = (event) => {
        if (event.type === 'text' && event.text) collected.text += event.text;
        controller.enqueue(encoder.encode(sse(event)));
      };
      let usedModel = model;
      let cites = null;
      try {
        if (conv.browsing) {
          // Jalur browsing: menjalankan pencarian/`fetch` lalu satu permintaan final dengan sumber.
          const out = await runBrowsingTurn({ env, user, conv, provider, apiKey, model, effort, history, text, content: blocks, fetchImpl, send });
          usedModel = out.model ?? model;
          cites = out.sources;
        } else {
          send({ type: 'meta', model, effort });
          await streamOnce({ provider, apiKey, model, effort, history, content: blocks, fetchImpl, send });
        }
        const meta = { model: usedModel, effort };
        const saved = await env.repo.addMessage(user.id, conv.id, { role: 'assistant', content: collected.text, meta });
        if (cites?.length && saved?.id) {
          await env.repo.addCitations(user.id, saved.id, cites.map((s, i) => ({ idx: i + 1, title: s.title, url: s.url, snippet: s.snippet })));
        }
        send({ type: 'done', messageId: saved?.id ?? null });
      } catch {
        // Jangan bocorkan detail provider ke klien; simpan apa yang sempat ada.
        send({ type: 'error', error: 'Gagal menghubungi provider' });
        if (collected.text) await env.repo.addMessage(user.id, conv.id, { role: 'assistant', content: collected.text, meta: { model: usedModel, effort, incomplete: true } });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' },
  });
}

/**
 * Satu permintaan streaming ke provider (tanpa browsing). Mengembalikan { text }.
 * `send` menerima event SSE yang sudah dinormalkan. `content` (string atau array blok netral) adalah isi
 * pesan user; `text` dipakai bila `content` tidak diberikan (mis. jalur browsing).
 */
export async function streamOnce({ provider, apiKey, model, effort, history, text, content, fetchImpl = globalThis.fetch, send, system = BASE_SYSTEM, tools }) {
  const userContent = content ?? text;
  const { url, headers, body } = buildRequest(provider, apiKey, {
    model, effort, system, messages: [...history, { role: 'user', content: userContent }], tools,
  });
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`provider ${res.status}`);
  const push = parseStream(provider.kind);
  let full = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const ev of push(decoder.decode(value, { stream: true }))) {
      if (ev.type === 'text' && ev.text) { full += ev.text; send({ type: 'text', text: ev.text }); }
      else if (ev.type === 'tool') send({ type: 'tool', name: ev.name, input: ev.input });
    }
  }
  return { text: full };
}

export { BASE_SYSTEM, clampEffort, MAX_MESSAGE_CHARS };