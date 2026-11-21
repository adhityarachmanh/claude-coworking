// bridge/src/search.mjs — pencarian web untuk browsing chat. Mesin default: DuckDuckGo HTML
// (tanpa API key). Tavily / Brave dipakai bila env menyediakannya. Murni: `fetchImpl` disuntik di test.
//
// Hasil dinormalkan ke { title, url, snippet }. URL dibersihkan (unwrapped dari redirect DDG) dan hanya
// http(s) yang lolos; hasil non-http dibuang.

const UA = 'Mozilla/5.0 (compatible; AdhitronWeb/1.0)';
const TIMEOUT_MS = 12_000;

const withTimeout = (ms) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(t) };
};

/** Pilih mesin dari env: tavily > brave > duckduckgo (default, tanpa key). */
export function pickEngine(env = {}) {
  if (env.TAVILY_API_KEY) return 'tavily';
  if (env.BRAVE_API_KEY) return 'brave';
  return 'duckduckgo';
}

/** Ekstrak URL DDG dari bentuk redirect //duckduckgo.com/l/?uddg=<encoded>. */
export function unwrapDdgUrl(href) {
  const s = String(href ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return u.href;
  } catch { return null; }
}

/**
 * Cari web. Mengembalikan array { title, url, snippet } (maks `limit`).
 * @param {string} query
 * @param {{ fetchImpl?, env?, limit?, searchImpl? }} [opts]
 */
export async function webSearch(query, { fetchImpl = globalThis.fetch, env = {}, limit = 5, searchImpl } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const engine = pickEngine(env);
  if (searchImpl) return (await searchImpl(q, engine, limit)).slice(0, limit);
  if (engine === 'tavily') return searchTavily(q, env.TAVILY_API_KEY, limit, fetchImpl);
  if (engine === 'brave') return searchBrave(q, env.BRAVE_API_KEY, limit, fetchImpl);
  return searchDuckDuckGo(q, limit, fetchImpl);
}

/** DuckDuckGo HTML endpoint (tanpa key). Parse blok hasil: tautan (`result__a`) dan cuplikan
 *  (`result__snippet`) berada di elemen terpisah, jadi keduanya dicocokkan menurut urutan. */
export async function searchDuckDuckGo(query, limit, fetchImpl) {
  const { signal, done } = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetchImpl('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: `q=${encodeURIComponent(query)}`,
      signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    const links = [...html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    const snippets = [...html.matchAll(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripTags(m[1]));
    const out = [];
    for (let i = 0; i < links.length && out.length < limit; i++) {
      const url = unwrapDdgUrl(links[i][1]);
      if (!url || !/^https?:/i.test(url)) continue;
      out.push({ title: stripTags(links[i][2]) || url, url, snippet: snippets[out.length] ?? '' });
    }
    return out;
  } catch { return []; } finally { done(); }
}

async function searchTavily(query, key, limit, fetchImpl) {
  const { signal, done } = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: 'basic' }),
    });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.results ?? []).map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: r.content ?? '' })).filter((r) => /^https?:/i.test(r.url));
  } catch { return []; } finally { done(); }
}

async function searchBrave(query, key, limit, fetchImpl) {
  const { signal, done } = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': key }, signal,
    });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.web?.results ?? []).map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: r.description ?? '' })).filter((r) => /^https?:/i.test(r.url));
  } catch { return []; } finally { done(); }
}

const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();