// 🌉 CLI bridge helpers: the safe payload a terminal hook may send and the project that owns its cwd.
// Pure functions only (no I/O): the route and the hook both use them, so the phone card never sees more than a
// short preview, and path matching stays one implementation.
import { realpathSync } from 'node:fs';
import path from 'node:path';

const MAX_DEPTH = 4;
const MAX_KEYS = 40;
const MAX_ITEMS = 20;
const MAX_STRING = 800;
const MAX_TOTAL = 12_000;
const BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);
// C0/C1, bidi overrides and zero-width characters can make a command look different from what runs.
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const normalize = (p) => {
  let resolved = path.resolve(String(p));
  try {
    resolved = realpathSync.native ? realpathSync.native(resolved) : realpathSync(resolved);
  } catch {
    // A folder that is gone still matches textually; the hook will fail on its own.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * A tool_input reduced to what an approval card can show: strings are clipped, arrays/objects bounded, and the
 * whole thing has a character budget. No prompt text (Claude Code's PreToolUse payload has none) and no secrets
 * beyond what the tool itself would display in the terminal.
 */
export function sanitizeToolInput(input, { maxString = MAX_STRING, maxTotal = MAX_TOTAL } = {}) {
  const budget = { left: Math.max(0, Number(maxTotal) || MAX_TOTAL) };
  const clip = (s) => {
    const clean = s.replace(UNSAFE, ' ');
    const take = Math.max(0, Math.min(Number(maxString) || MAX_STRING, budget.left));
    if (!take) return clean ? '… (dipotong)' : '';
    if (clean.length <= take) {
      budget.left -= clean.length;
      return clean;
    }
    budget.left -= take;
    return `${clean.slice(0, take)}… (dipotong, ${clean.length} karakter)`;
  };
  const walk = (value, depth) => {
    if (value == null) return value;
    if (typeof value === 'string') return clip(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'object') return undefined;
    if (depth >= MAX_DEPTH) return '… (terlalu dalam)';
    if (Array.isArray(value)) {
      const out = value.slice(0, MAX_ITEMS).map((item) => walk(item, depth + 1));
      if (value.length > MAX_ITEMS) out.push(`… (${value.length - MAX_ITEMS} item lagi)`);
      return out;
    }
    const out = {};
    let kept = 0;
    for (const [rawKey, item] of Object.entries(value)) {
      const key = String(rawKey).replace(UNSAFE, '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!key || BLOCKED.has(key)) continue;
      if (kept >= MAX_KEYS) {
        out['…'] = '… (field lain dipotong)';
        break;
      }
      if (budget.left <= 0) {
        out['…'] = '… (anggaran preview habis)';
        break;
      }
      budget.left -= key.length;
      out[key] = walk(item, depth + 1);
      kept += 1;
    }
    return out;
  };
  return walk(input ?? {}, 0);
}

/** The project whose folder contains `cwd` (the deepest match), or null when the terminal is outside every project. */
export function projectForCwd(projects, cwd) {
  let wanted;
  try {
    wanted = typeof cwd === 'string' && cwd.trim() ? normalize(cwd) : '';
  } catch {
    return null;
  }
  if (!wanted) return null;
  let best = null;
  let bestLength = -1;
  for (const project of projects ?? []) {
    if (!project?.id || !project.path || project.virtual) continue;
    let root;
    try {
      root = normalize(project.path);
    } catch {
      continue;
    }
    const rel = path.relative(root, wanted);
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (inside && root.length > bestLength) {
      best = project;
      bestLength = root.length;
    }
  }
  return best;
}

/** The hook's stdout: allow/deny with a short reason; anything else makes Claude Code fall back to its own prompt. */
export function hookDecision(decision) {
  if (decision !== 'allow' && decision !== 'deny') return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: decision === 'allow' ? 'Disetujui dari Adhit Office' : 'Ditolak dari Adhit Office',
    },
  };
}
