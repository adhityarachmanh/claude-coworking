// bridge/src/browsing.mjs — browsing untuk chat: cari web (web_search) + baca halaman (fetch_url),
// lalu minta model menjawab dengan kutipan bernomor. Anti-SSRF: hanya http(s), blokir host privat/loopback.
// M5 memakai jalur "prompted": sumber disisipkan ke satu permintaan final. M6 menambah pencarian & kutipan.
import { streamOnce } from './chat-run.mjs';
import { webSearch } from './search.mjs';
import { fetchPage } from './fetch-page.mjs';

/** Instruksi kutipan saat browsing aktif. */
export const BROWSING_SYSTEM = `Kamu punya hasil pencarian web di bawah. Pakai informasi itu untuk menjawab.
Sertakan kutipan bernomor seperti [1], [2] yang merujuk ke sumber. Jangan mengarang URL atau fakta.`;

/** Susun blok konteks sumber untuk disisipkan ke permintaan. */
export function sourcesBlock(sources) {
  if (!sources.length) return 'Tidak ada hasil pencarian.';
  return sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${s.snippet ?? ''}`.trim()).join('\n\n');
}

/**
 * Jalankan giliran dengan browsing: cari → (opsional) baca halaman teratas → jawab dengan kutipan.
 * Mengembalikan { text, sources, model }.
 */
export async function runBrowsingTurn({ provider, apiKey, model, effort, history, text, fetchImpl, send, searchImpl, fetchPageImpl }) {
  send({ type: 'meta', model, effort, browsing: true });
  const results = await webSearch(text, { fetchImpl, searchImpl });
  const sources = [];
  for (const r of results.slice(0, 5)) {
    let snippet = r.snippet ?? '';
    // Baca halaman teratas untuk snippet yang lebih kaya (best-effort; gagal = pakai snippet hasil pencarian).
    if (sources.length < 3) {
      try {
        const page = await fetchPage(r.url, { fetchImpl, fetchPageImpl });
        if (page?.text) snippet = page.text.slice(0, 800);
      } catch { /* biarkan snippet hasil pencarian */ }
    }
    sources.push({ title: r.title, url: r.url, snippet });
  }
  send({ type: 'sources', sources: sources.map(({ title, url }) => ({ title, url })) });

  const context = `Hasil pencarian web untuk: "${text}"\n\n${sourcesBlock(sources)}`;
  const out = await streamOnce({
    provider, apiKey, model, effort,
    system: `${BROWSING_SYSTEM}\n\n${context}`,
    history, text, fetchImpl, send,
  });
  return { text: out.text, sources, model };
}