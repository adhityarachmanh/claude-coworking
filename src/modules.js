// The browser's ES module graph, worked out on the server so index.html can <link rel="modulepreload"> every
// module up front: the phone then fetches them in parallel instead of discovering them level by level.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Static `import … from '…'`, side-effect `import '…'`, `export … from '…'` and dynamic `import('…')`.
// Only literal specifiers are followed; the app uses no computed imports.
const IMPORT_RE = /\b(?:import|export)\s*(?:[\w*${}\s,]+?\s*from\s*)?['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

/**
 * Every module `entry` imports, directly or not, as URL paths in breadth-first order (shallow modules first).
 * Only relative or root-relative specifiers inside `publicDir` count; the entry itself is not listed.
 * @param {string} publicDir absolute path of the folder served at "/"
 * @param {string} entry URL path of the entry module, e.g. "/js/app.js"
 * @returns {string[]}
 */
export function moduleGraph(publicDir, entry) {
  const root = path.resolve(publicDir);
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const url = queue.shift();
    let source;
    try {
      source = readFileSync(path.join(root, url), 'utf8');
    } catch {
      continue; // a missing module is the browser's error to report, not a reason to fail the page
    }
    for (const m of source.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!/^\.{0,2}\//.test(spec)) continue; // bare specifiers / URLs: nothing of ours
      const next = new URL(spec, `http://x${url}`).pathname;
      const file = path.join(root, next);
      if (seen.has(next) || !file.startsWith(root + path.sep) || !existsSync(file)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  seen.delete(entry);
  return [...seen];
}

/** The <link rel="modulepreload"> tags for `urls` (same origin, so CSP script-src 'self' covers them). */
export const preloadTags = (urls) => urls.map((u) => `<link rel="modulepreload" href="${u}" />`).join('\n    ');
