import { createHash } from 'node:crypto';
import path from 'node:path';

/** Collapses whitespace and cuts to `max` characters (for labels/bubbles). */
export const truncate = (value, max) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Keeps line breaks; only bounds the total length (for previews). */
export const clip = (value, max) => {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…` : s;
};

export const basename = (p) => (p ? path.basename(String(p)) : '');

export function normalizePath(p) {
  return path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Stable short id for a project folder (case-insensitive on Windows). */
export function projectId(p) {
  const key = normalizePath(p);
  return createHash('sha1')
    .update(process.platform === 'win32' ? key.toLowerCase() : key)
    .digest('hex')
    .slice(0, 10);
}

/** First sentence of a (markdown) message, for speech bubbles. */
export function firstSentence(text, max = 90) {
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*$/gm, ' ') // markdown table rows
    .replace(/^\s*[-=*_]{3,}\s*$/gm, ' ') // rules
    .replace(/[#*`>|_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = plain.match(/^.+?[.!?](\s|$)/);
  return truncate(match ? match[0] : plain, max);
}
