// gzip for the text assets a phone over a mobile link actually pays for (JS modules, CSS, index.html, JSON, SVG).
//
// Why here and not in a dependency: the page loads >100 ES modules and one 150 KB index.html; without compression a
// cold load and every reconnect (which refetches index.html for the per-start token) move ~1.5 MB. gzip cuts that by
// roughly 4×, which is the difference between usable and painful on a phone away from home.
//
// The cache is keyed by the file's own ETag, so an edited file is never served from a stale entry, and the ETag of a
// compressed answer is the ETag of the COMPRESSED bytes: a client that cached the gzip body and later asks without
// gzip gets a 200, never a wrong 304.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/** Below this the gzip header/footer overhead eats the gain; tiny files go out plain. */
export const MIN_GZIP_BYTES = 1024;
const CACHE_LIMIT = 400;

/** `Accept-Encoding` says gzip (with or without a quality factor). */
export const acceptsGzip = (header) => /(^|,)\s*gzip\s*(;|,|$)/i.test(String(header ?? ''));

/** Text-ish content types that gain from gzip; images/fonts/zip are already compressed. */
export const compressibleType = (type) =>
  /^(text\/|application\/(json|javascript|manifest\+json|xml)|image\/svg\+xml)/i.test(String(type ?? ''));

/** A short, stable ETag for a body (same shape the static handler already used). */
export function etagOf(body) {
  return `"${createHash('sha1').update(body).digest('base64url').slice(0, 22)}"`;
}

/** A bounded cache of gzipped bodies: `key` -> { body, etag }. */
export class GzipCache {
  constructor(limit = CACHE_LIMIT) {
    this.limit = limit;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  /** The compressed body + its own ETag, or null when compression would not help. */
  encode(body, key) {
    const hit = this.map.get(key);
    if (hit) return hit;
    const gz = gzipSync(body, { level: 6 });
    if (gz.length >= body.length) return null; // incompressible: plain is smaller
    const value = { body: gz, etag: etagOf(gz) };
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return value;
  }

  clear() {
    this.map.clear();
  }
}
