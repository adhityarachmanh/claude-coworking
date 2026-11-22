// Output styles (Claude Code): built-in names, custom Markdown files (`<project>/.claude/output-styles`,
// `<user>/.claude/output-styles`), and the style a project actually uses. Pure reads here; writes live below.
// The style names are case-sensitive (docs: `concise` is not Concise, it means Default), so every comparison is exact.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { settingsFile, userConfigDir } from './permissions.js';

export const OUTPUT_STYLE_LIMITS = Object.freeze({ bytes: 64 * 1024, name: 60, description: 300, slug: 60 });

export const BUILTIN_STYLES = Object.freeze([
  { name: 'default', description: 'Bawaan Claude Code' },
  { name: 'Proactive', description: 'Langsung mengerjakan, sedikit bertanya' },
  { name: 'Concise', description: 'Jawaban singkat, langsung ke hasil' },
  { name: 'Explanatory', description: 'Menjelaskan alasan di balik perubahan' },
  { name: 'Learning', description: 'Menjelaskan sambil meminta kamu menulis sebagian kode' },
]);

/** A refused read/write; `status` is the HTTP status and the message is shown to the user as it is. */
export class OutputStyleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The two roots Claude Code reads in this app: the project's own styles, then the ones for every project. */
export function styleRoots({ projectPath, userDir = userConfigDir() }) {
  return [
    { scope: 'project', dir: path.join(projectPath, '.claude', 'output-styles') },
    { scope: 'user', dir: path.join(userDir, 'output-styles') },
  ];
}

const unquote = (value) => String(value ?? '').trim().replace(/^["']|["']$/g, '');

/**
 * `---\nname: x\ndescription: y\nkeep-coding-instructions: true\n---\nbody` → fields plus the instructions body.
 * A file without a usable front matter keeps its whole text as the body and an empty name (the caller falls back
 * to the file name), so one malformed style never breaks the list.
 */
export function parseStyleFile(text) {
  const source = String(text ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return { name: '', description: '', keepCodingInstructions: false, body: source };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1]] = unquote(pair[2]);
  }
  return {
    name: meta.name ?? '',
    description: meta.description ?? '',
    keepCodingInstructions: String(meta['keep-coding-instructions'] ?? '').toLowerCase() === 'true',
    body: match[2].replace(/^\r?\n/, ''),
  };
}

/** Reads one Markdown style file; a symlink is invisible to the list (its target may be anywhere). */
const readStyleFile = (file) => {
  try {
    if (lstatSync(file).isSymbolicLink()) return null;
    const parsed = parseStyleFile(readFileSync(file, 'utf8'));
    const slug = path.basename(file, '.md');
    return {
      name: parsed.name || slug,
      slug,
      description: parsed.description,
      keepCodingInstructions: parsed.keepCodingInstructions,
      file,
    };
  } catch {
    return null; // unreadable file: skip it, never fail the whole list
  }
};

const listMarkdown = (dir) => {
  try {
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => readStyleFile(path.join(dir, name)))
      .filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * Every style the picker offers: the five built-in names first, then custom files. A project style wins over a
 * user style with the same name (the project's folder is closer to the working directory, as Claude Code does).
 */
export function listOutputStyles({ projectPath, userDir = userConfigDir() }) {
  const out = BUILTIN_STYLES.map((style) => ({ ...style, slug: style.name, keepCodingInstructions: false, scope: 'builtin', builtin: true }));
  const seen = new Set(BUILTIN_STYLES.map((style) => style.name));
  for (const root of styleRoots({ projectPath, userDir })) {
    for (const style of listMarkdown(root.dir)) {
      if (seen.has(style.name)) continue;
      seen.add(style.name);
      out.push({ ...style, scope: root.scope, builtin: false });
    }
  }
  return out;
}

/** One settings file's `outputStyle`, or null when it does not set one. A non-string value is reported, not guessed. */
function styleOfSettings(file) {
  let text;
  try {
    if (lstatSync(file).isSymbolicLink()) throw new OutputStyleError(409, `${path.basename(file)} berupa symlink; ubah langsung di file aslinya.`);
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof OutputStyleError) throw err;
    if (err.code === 'ENOENT') return null;
    throw new OutputStyleError(500, `Tidak bisa membaca ${path.basename(file)}: ${err.code ?? err.message}`);
  }
  let data;
  try {
    data = text.trim() ? JSON.parse(text.replace(/^\uFEFF/, '')) : {};
  } catch (err) {
    throw new OutputStyleError(409, `${path.basename(file)} bukan JSON yang valid (${err.message}). Perbaiki file itu dulu; Adhitron tidak akan menimpanya.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new OutputStyleError(409, `${path.basename(file)} harus berisi objek JSON ({ … }).`);
  }
  if (data.outputStyle == null) return null;
  if (typeof data.outputStyle !== 'string') return { value: String(data.outputStyle), valid: false };
  return { value: data.outputStyle, valid: true };
}

/**
 * The style Claude Code will use and where that choice came from: local settings win over the project's shared
 * settings, which win over the user's. A value that is not an exact style name gives Default (docs), so it is
 * reported as `unknown` instead of pretending a style is active.
 */
export function currentOutputStyle({ projectPath, userDir = userConfigDir() }) {
  const known = new Set(listOutputStyles({ projectPath, userDir }).map((style) => style.name));
  for (const scope of ['local', 'project', 'user']) {
    const picked = styleOfSettings(settingsFile(projectPath, scope, userDir));
    if (!picked) continue;
    if (picked.valid && known.has(picked.value)) return { name: picked.value, source: scope, unknown: null };
    return { name: 'default', source: scope, unknown: picked.value };
  }
  return { name: 'default', source: 'default', unknown: null };
}
