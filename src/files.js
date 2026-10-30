// File index of a project for `@file` mentions in the composer (cached briefly per project).
import { readdirSync } from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.next', '.nuxt', '.output', 'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'storage', 'target', 'bin', 'obj']);
const MAX_FILES = 20000;
const CACHE_MS = 30000;
const cache = new Map(); // project path -> { at, files }

function walk(root) {
  const files = [];
  const stack = [''];
  while (stack.length && files.length < MAX_FILES) {
    const rel = stack.pop();
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.env.example') continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) stack.push(child);
      } else files.push(child);
    }
  }
  return files;
}

/** Best matches for a partial path: filename hits first, then path hits, shortest first. */
export function searchFiles(projectPath, query, limit = 20) {
  let entry = cache.get(projectPath);
  if (!entry || Date.now() - entry.at > CACHE_MS) {
    entry = { at: Date.now(), files: walk(projectPath) };
    cache.set(projectPath, entry);
  }
  const q = String(query ?? '').toLowerCase().replace(/\\/g, '/');
  if (!q) return entry.files.filter((f) => !f.includes('/')).slice(0, limit);
  const scored = [];
  for (const file of entry.files) {
    const lower = file.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : lower.includes(q) ? 2 : -1;
    if (score >= 0) scored.push([score, file.length, file]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, limit).map((s) => s[2]);
}
