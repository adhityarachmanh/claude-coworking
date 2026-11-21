// bridge/src/chat-run.mjs — jalankan satu giliran chat: susun riwayat, kirim ke provider, alirkan jawaban
// sebagai SSE, lalu simpan pesan & pemakaian. Dites lewat fetchImpl palsu (tanpa jaringan).
import { buildRequest, messageProblem, parseStream, MAX_MESSAGE_CHARS } from './chat.mjs';
import { classify } from './auto.mjs';
import { modelForTier, defaultModelFor, EFFORT_LEVELS } from './providers.mjs';
import { decryptSecret } from './secrets.mjs';
import { makeCallModel } from './client.mjs';
import { runBrowsingTurn } from './browsing.mjs';

/** System prompt dasar. Browsing menambah instruksi kutipan (lihat browsing.mjs). */
const BASE_SYSTEM = 'Kamu adalah asisten AI di Adhitron Web. Jawab dalam bahasa yang dipakai pengguna, ringkas dan jelas.';

const clampEffort = (e) => (EFFORT_LEVELS.includes(e) ? e : 'default');

/** Bentuk riwayat untuk provider: hanya role user/assistant + teks. */
const historyFor = (messages) => messages
  .filter((m) => m.role === 'user' || m.role === 'assistant')
  .map((m) => ({ role: m.role, content: m.content }));

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
      callModel, // disuntik di produksi (client.mjs) & di test
    });
    if (verdict) {
      if (conv.effort_auto) effort = clampEffort(verdict.effort);
      if (conv.model_auto) model = modelForTier(provider.kind, verdict.tier, conv.model_tiers);
    }
  }
  if (!model) model = defaultModelFor(provider.kind);
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
  const problem = messageProblem(text);
  if (problem) {
    return new Response(JSON.stringify({ error: problem }), { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
  const resolved = await resolveTurn(env, user, conv, { fetchImpl, text });
  if (resolved.error) {
    return new Response(JSON.stringify({ error: resolved.error }), { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
  const { provider, apiKey, model, effort } = resolved;

  // Simpan pesan user lebih dulu (muncul di riwayat walau stream gagal).
  const userMsg = await env.repo.addMessage(user.id, conv.id, { role: 'user', content: text });
  if (conv.title === 'Percakapan baru' && text) {
    await env.repo.updateConversation(user.id, conv.id, { title: text.slice(0, 60) });
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
      try {
        if (conv.browsing) {
          // Jalur browsing: menjalankan pencarian/`fetch` lalu satu permintaan final dengan sumber.
          const out = await runBrowsingTurn({ env, user, conv, provider, apiKey, model, effort, history, text, fetchImpl, send });
          usedModel = out.model ?? model;
        } else {
          send({ type: 'meta', model, effort });
          await streamOnce({ provider, apiKey, model, effort, history, text, fetchImpl, send });
        }
        const meta = { model: usedModel, effort };
        const saved = await env.repo.addMessage(user.id, conv.id, { role: 'assistant', content: collected.text, meta });
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
 * `send` menerima event SSE yang sudah dinormalkan.
 */
export async function streamOnce({ provider, apiKey, model, effort, history, text, fetchImpl, send, system = BASE_SYSTEM, tools }) {
  const { url, headers, body } = buildRequest(provider, apiKey, {
    model, effort, system, messages: [...history, { role: 'user', content: text }], tools,
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