// bridge/src/browsing.mjs — browsing untuk chat: cari web (web_search) + baca halaman (fetch_url),
// lalu minta model menjawab dengan kutipan bernomor. Anti-SSRF: hanya http(s), blokir host privat/loopback.
// Impelentasi "prompted": hasil pencarian disisipkan sebagai konteks satu permintaan final, sehingga
// bekerja dengan semua provider tanpa bergantung pada tool-calling native. Kutipan bernomor ([1], [2])
// disimpan sebagai citation agar UI bisa menampilkan chip sumber.
import { streamOnce } from './chat-run.mjs';
import { webSearch } from './search.mjs';
import { fetchPage } from './fetch-page.mjs';

/** Instruksi kutipan saat browsing aktif. */
export const BROWSING_SYSTEM = `Kamu punya hasil pencarian web di bawah. Pakai informasi itu untuk menjawab.
Sertakan kutipan bernomor seperti [1], [2] yang merujuk ke sumber. Jangan mengarang URL atau fakta.`;

/** Batas jumlah giliran browsing (pencarian) per percakapan, untuk meredam penyalahgunaan. */
export const MAX_SEARCHES_PER_CONVERSATION = 20;
/** Berapa hasil pencarian yang dipakai, dan berapa halaman yang benar-benar dibaca. */
export const SEARCH_RESULTS = 5;
export const PAGES_READ = 3;
const SNIPPET_CHARS = 800;

/** Susun blok konteks sumber untuk disisipkan ke permintaan. */
export function sourcesBlock(sources) {
  if (!sources.length) return 'Tidak ada hasil pencarian.';
  return sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${s.snippet ?? ''}`.trim()).join('\n\n');
}

/**
 * Jalankan giliran dengan browsing: cari → (opsional) baca halaman teratas → jawab dengan kutipan.
 * Mengembalikan { text, sources, model }.
 *
 * `env` boleh menyuntikkan `searchImpl` (query, engine, limit) dan `fetchPageImpl` (url) untuk test,
 * plus `searchEngineEnv` untuk memilih mesin (Tavily/Brave/DuckDuckGo).
 */
export async function runBrowsingTurn({ env, user, conv, provider, apiKey, model, effort, history, text, content, fetchImpl, send }) {
  send({ type: 'meta', model, effort, browsing: true });

  // Batas pencarian per percakapan: hitung dari tool_runs, berhenti memakai browsing bila habis.
  const used = await env.repo.countToolRuns(user.id, conv.id, 'web_search');
  if (used >= MAX_SEARCHES_PER_CONVERSATION) {
    send({ type: 'notice', notice: 'Batas pencarian percakapan ini sudah tercapai; menjawab tanpa mencari lagi.' });
  }
  const maySearch = used < MAX_SEARCHES_PER_CONVERSATION;

  let results = [];
  if (maySearch) {
    results = await webSearch(text, {
      fetchImpl, limit: SEARCH_RESULTS,
      env: env.searchEngineEnv ?? {},
      searchImpl: env.searchImpl,
    }).catch(() => []);
    await env.repo.addToolRun(user.id, conv.id, { tool: 'web_search', input: { query: text, engine: null }, status: 'ok' });
  }

  const sources = [];
  for (const r of results.slice(0, SEARCH_RESULTS)) {
    let snippet = r.snippet ?? '';
    // Baca halaman teratas untuk snippet yang lebih kaya (best-effort; gagal = pakai snippet hasil pencarian).
    if (maySearch && sources.length < PAGES_READ) {
      const page = await fetchPage(r.url, { fetchImpl, fetchPageImpl: env.fetchPageImpl }).catch(() => null);
      if (page?.text) snippet = page.text.slice(0, SNIPPET_CHARS);
      await env.repo.addToolRun(user.id, conv.id, { tool: 'fetch_url', input: { url: r.url }, status: page ? 'ok' : 'error' });
    }
    sources.push({ title: r.title, url: r.url, snippet });
  }
  send({ type: 'sources', sources: sources.map((s) => ({ title: s.title, url: s.url })) });

  const context = maySearch
    ? `Hasil pencarian web untuk: "${text}"\n\n${sourcesBlock(sources)}`
    : 'Pencarian web tidak tersedia untuk giliran ini; jawab dari pengetahuanmu dan katakan bila tidak yakin.';
  const out = await streamOnce({
    provider, apiKey, model, effort,
    system: `${BROWSING_SYSTEM}\n\n${context}`,
    history, content, text, fetchImpl, send,
  });
  return { text: out.text, sources, model };
}