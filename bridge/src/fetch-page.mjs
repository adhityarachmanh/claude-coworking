// bridge/src/fetch-page.mjs — ambil & bersihkan satu halaman web untuk browsing.
// Anti-SSRF: hanya http(s); host privat/loopback/link-local/metadata diblokir; batas ukuran & waktu.
import { isSafeUrl } from './ssrf.mjs';

const UA = 'Mozilla/5.0 (compatible; AdhitronWeb/1.0)';
const TIMEOUT_MS = 12_000;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB cukup untuk halaman teks; lebih dari ini dipotong
const MAX_TEXT = 12_000; // karakter teks bersih yang disimpan

/**
 * Ambil halaman dan kembalikan { url, title, text } (teks bersih), atau null bila diblokir/gagal.
 * @param {string} rawUrl
 * @param {{ fetchImpl?, fetchPageImpl?, allowPrivate? }} [opts]
 */
export async function fetchPage(rawUrl, { fetchImpl = globalThis.fetch, fetchPageImpl, allowPrivate = false } = {}) {
  const url = String(rawUrl ?? '').trim();
  const safety = isSafeUrl(url, { allowPrivate });
  if (!safety.ok) return null;
  if (fetchPageImpl) return fetchPageImpl(safety.url);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(safety.url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const ctype = res.headers.get('content-type') ?? '';
    if (ctype && !/text\/html|text\/plain|application\/xhtml/i.test(ctype)) return null;
    const html = (await res.text()).slice(0, MAX_BYTES);
    return { url: safety.url, title: extractTitle(html), text: htmlToText(html).slice(0, MAX_TEXT) };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Judul halaman (<title>), di-fallback ke host. */
export function extractTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

/** Ubah HTML menjadi teks yang bisa dibaca: buang script/style/komentar, lalu tag, lalu entitas. */
export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim(),
  );
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const decodeEntities = (s) => String(s).replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);