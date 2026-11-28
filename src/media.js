// 🖼 Media of a project: the images and videos already in its folder (screenshots, assets, generated images/videos).
// Read-only discovery; no file content is read here. Bounded so a huge folder (node_modules, dist) cannot stall it.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg']);
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']);
// Folders that never hold user media worth listing (and can be enormous).
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__']);
const MAX_DEPTH = 8;

/** 'image' | 'video' | null from the file name. */
export function mediaKind(name) {
  const ext = String(name ?? '').toLowerCase().split('.').pop();
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  return null;
}

/**
 * The project's media, newest first: [{ path (relative, forward slashes), name, kind, size, mtime }].
 * Hidden folders/files are skipped (they include .git, .claude, .opencode, .venv).
 */
export function findMedia(projectPath, { limit = 60, maxFiles = 4000 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = mediaKind(entry.name);
      if (!kind) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      out.push({ path: path.relative(projectPath, full).split(path.sep).join('/'), name: entry.name, kind, size: st.size, mtime: st.mtimeMs });
    }
  };
  walk(projectPath, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(0, Number(limit) || 60));
}
