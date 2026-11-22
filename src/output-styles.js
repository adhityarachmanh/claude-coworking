// Output styles (Claude Code): built-in names, custom Markdown files (`<project>/.claude/output-styles`,
// `<user>/.claude/output-styles`), and the style a project actually uses. Pure reads here; writes live below.
// The style names are case-sensitive (docs: `concise` is not Concise, it means Default), so every comparison is exact.
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { settingsFile, userConfigDir } from './permissions.js';

export const OUTPUT_STYLE_LIMITS = Object.freeze({ bytes: 64 * 1024, name: 60, description: 300, slug: 60 });
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const MAX_BACKUPS = 20;

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

const unquote = (value) => {
  const text = String(value ?? '').trim();
  if (/^".*"$/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  return /^'.*'$/.test(text) ? text.slice(1, -1) : text;
};

/**
 * `---\nname: x\ndescription: y\nkeep-coding-instructions: true\n---\nbody` → fields plus the instructions body.
 * A BOM or blank lines before the front matter are tolerated (Claude Code's YAML parser does the same). A file
 * without a usable front matter keeps its whole text as the body and an empty name (the caller falls back to the
 * file name), so one malformed style never breaks the list.
 */
export function parseStyleFile(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
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
    const info = lstatSync(file);
    if (info.isSymbolicLink() || info.size > 256 * 1024) return null; // a huge file is not an instruction file
    const parsed = parseStyleFile(readFileSync(file, 'utf8'));
    const slug = path.basename(file, '.md');
    return {
      name: parsed.name || slug,
      slug,
      description: parsed.description,
      keepCodingInstructions: parsed.keepCodingInstructions,
      mtime: info.mtimeMs,
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

// ---------- writing custom styles (project or user), with containment and backups ----------

const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** `"Diagrams first"` → `diagrams-first`; also the file name Claude Code derives from a style without a name field. */
export const styleSlug = (name) => String(name ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, OUTPUT_STYLE_LIMITS.slug);

const rootFor = ({ projectPath, userDir }, scope) => {
  const root = styleRoots({ projectPath, userDir }).find((entry) => entry.scope === scope);
  if (!root) throw new OutputStyleError(400, 'Lokasi gaya tidak dikenal.');
  return root.dir;
};

/** Creates the folder when needed and refuses a symlink/junction root: a write may never land outside the scope. */
function safeRoot(dir) {
  mkdirSync(dir, { recursive: true });
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new OutputStyleError(409, 'Folder gaya berupa symlink; ubah langsung di folder aslinya.');
  let real;
  try {
    real = realpathSync(dir);
  } catch (err) {
    throw new OutputStyleError(409, `Folder gaya tidak bisa dibaca (${err.code ?? err.message}).`);
  }
  if (!samePath(real, path.resolve(dir))) throw new OutputStyleError(409, 'Folder gaya menunjuk ke luar folder project; ubah langsung di folder aslinya.');
  return real;
}

/** A file that exists inside the root must be a regular file, not a link that could point anywhere else. */
function safeFile(realRoot, file) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (info.isSymbolicLink()) throw new OutputStyleError(409, 'File gaya berupa symlink; ubah langsung di file aslinya.');
  if (!info.isFile()) throw new OutputStyleError(409, 'File gaya bukan berkas biasa.');
  const real = realpathSync(file);
  if (!samePath(path.dirname(real), realRoot)) throw new OutputStyleError(409, 'File gaya menunjuk ke luar folder project; ubah langsung di file aslinya.');
  return info;
}

const cleanName = (name) => {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > OUTPUT_STYLE_LIMITS.name) {
    throw new OutputStyleError(400, `Nama gaya 1–${OUTPUT_STYLE_LIMITS.name} karakter.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(clean) || /[\\/:*?"<>|]/.test(clean)) {
    throw new OutputStyleError(400, 'Nama gaya tidak boleh mengandung / \\ : * ? " < > | atau baris baru.');
  }
  if (BUILTIN_STYLES.some((style) => style.name.toLowerCase() === clean.toLowerCase())) {
    throw new OutputStyleError(400, `"${clean}" adalah gaya bawaan; pilih nama lain untuk gaya kustom.`);
  }
  return clean;
};

const styleText = ({ name, description, keepCodingInstructions, body }) => {
  const lines = ['---', `name: ${JSON.stringify(name)}`];
  if (description) lines.push(`description: ${JSON.stringify(description)}`);
  if (keepCodingInstructions) lines.push('keep-coding-instructions: true');
  lines.push('---', '');
  const instructions = String(body ?? '');
  return `${lines.join('\n')}\n${instructions.endsWith('\n') ? instructions : `${instructions}\n`}`;
};

export const outputStyleBackupRoot = (dataDir) => {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('dataDir is required for output style backups');
  return path.join(dataDir, 'output-style-backups');
};

/** Copies the old file into the app's data folder (never next to the style); keeps the last 20 per file. */
function backupStyle(file, { dataDir, scope, slug }) {
  const root = outputStyleBackupRoot(dataDir);
  mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // `~` cannot appear in a slug, so `foo` and `foo-bar` never share a backup prefix/quotient.
  const prefix = `${scope}~${slug}~`;
  const dest = path.join(root, `${prefix}${stamp}-${randomBytes(3).toString('hex')}.md`);
  writeFileSync(dest, readFileSync(file));
  const mine = readdirSync(root).filter((name) => name.startsWith(prefix)).sort();
  for (const name of mine.slice(0, Math.max(0, mine.length - MAX_BACKUPS))) unlinkSync(path.join(root, name));
  return dest;
}

/** One custom style, ready for the editor: frontmatter fields, body, and the mtime used as an optimistic lock. */
export function readStyle({ projectPath, userDir = userConfigDir(), scope, slug }) {
  if (scope !== 'project' && scope !== 'user') throw new OutputStyleError(400, 'Lokasi gaya tidak dikenal.');
  if (!SLUG.test(String(slug ?? ''))) throw new OutputStyleError(400, 'Nama berkas gaya tidak valid.');
  const root = safeRoot(rootFor({ projectPath, userDir }, scope));
  const file = path.join(root, `${slug}.md`);
  const info = safeFile(root, file);
  if (!info) throw new OutputStyleError(404, 'Gaya tidak ditemukan.');
  const parsed = parseStyleFile(readFileSync(file, 'utf8'));
  return {
    name: parsed.name || slug,
    slug,
    description: parsed.description,
    keepCodingInstructions: parsed.keepCodingInstructions,
    body: parsed.body,
    scope,
    mtime: info.mtimeMs,
  };
}

/**
 * Creates a style (no `slug`) or edits one (`slug` identifies the old file; a new name moves the file). The old file
 * is backed up first; a file that changed since the editor read it (mtime) is never overwritten.
 * @returns {{ style: object, backedUp: string|null }}
 */
export function saveStyle({
  projectPath,
  userDir = userConfigDir(),
  dataDir,
  scope,
  slug,
  name,
  description = '',
  keepCodingInstructions = false,
  body = '',
  mtime,
}) {
  const clean = cleanName(name);
  const descriptionText = oneLine(description);
  if (descriptionText.length > OUTPUT_STYLE_LIMITS.description) {
    throw new OutputStyleError(400, `Deskripsi gaya maksimal ${OUTPUT_STYLE_LIMITS.description} karakter.`);
  }
  if (typeof body !== 'string') throw new OutputStyleError(400, 'Isi gaya harus berupa teks.');
  if (Buffer.byteLength(body, 'utf8') > OUTPUT_STYLE_LIMITS.bytes) {
    throw new OutputStyleError(413, `Isi gaya maksimal ${OUTPUT_STYLE_LIMITS.bytes / 1024} KB.`);
  }
  const oldSlug = slug == null || slug === '' ? null : String(slug);
  if (oldSlug && !SLUG.test(oldSlug)) throw new OutputStyleError(400, 'Nama berkas gaya tidak valid.');
  const nextSlug = styleSlug(clean);
  if (!SLUG.test(nextSlug)) throw new OutputStyleError(400, 'Nama gaya tidak menghasilkan nama berkas yang sah.');
  const root = safeRoot(rootFor({ projectPath, userDir }, scope));
  const oldFile = oldSlug ? path.join(root, `${oldSlug}.md`) : null;
  const nextFile = path.join(root, `${nextSlug}.md`);
  // The display name is what the picker and selection use: another file with the same name would make one of them
  // invisible, so it is refused even when the file names (slugs) differ.
  const taken = listMarkdown(root).some((style) => style.slug !== oldSlug && style.name === clean);
  if (taken) throw new OutputStyleError(409, `Nama gaya "${clean}" sudah dipakai file lain.`);
  let backedUp = null;
  if (oldFile) {
    const info = safeFile(root, oldFile);
    if (!info) throw new OutputStyleError(404, 'Gaya tidak ditemukan.');
    if (mtime != null && Number(mtime) !== info.mtimeMs) {
      throw new OutputStyleError(409, 'File gaya sudah berubah di tempat lain. Muat ulang dulu, lalu coba lagi.');
    }
    if (oldSlug !== nextSlug) {
      if (safeFile(root, nextFile)) throw new OutputStyleError(409, 'Nama gaya itu sudah dipakai file lain.');
    }
    backedUp = backupStyle(oldFile, { dataDir, scope, slug: oldSlug });
  } else {
    if (safeFile(root, nextFile)) throw new OutputStyleError(409, 'Nama gaya itu sudah dipakai file lain.');
  }
  const text = styleText({ name: clean, description: descriptionText, keepCodingInstructions: keepCodingInstructions === true, body });
  const temp = path.join(root, `.${nextSlug}-${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(temp, text);
  renameSync(temp, nextFile);
  if (oldFile && oldSlug !== nextSlug) unlinkSync(oldFile);
  return {
    style: { name: clean, slug: nextSlug, description: descriptionText, keepCodingInstructions: keepCodingInstructions === true, body, scope },
    backedUp,
  };
}

/** Deletes one custom style after backing it up; the file must be the one the editor read (`mtime`). */
export function deleteStyle({ projectPath, userDir = userConfigDir(), dataDir, scope, slug, mtime }) {
  if (scope !== 'project' && scope !== 'user') throw new OutputStyleError(400, 'Lokasi gaya tidak dikenal.');
  if (!SLUG.test(String(slug ?? ''))) throw new OutputStyleError(400, 'Nama berkas gaya tidak valid.');
  const root = safeRoot(rootFor({ projectPath, userDir }, scope));
  const file = path.join(root, `${slug}.md`);
  const info = safeFile(root, file);
  if (!info) throw new OutputStyleError(404, 'Gaya tidak ditemukan.');
  if (mtime != null && Number(mtime) !== info.mtimeMs) {
    throw new OutputStyleError(409, 'File gaya sudah berubah di tempat lain. Muat ulang dulu, lalu coba lagi.');
  }
  const backedUp = backupStyle(file, { dataDir, scope, slug });
  unlinkSync(file);
  return { backedUp };
}

/**
 * The project's own choice, written to `.claude/settings.local.json` (the file Claude Code's own command writes).
 * Only `outputStyle` changes: every other key, the indentation and the file mode stay as they were. `default` is a
 * real style name Claude Code lists, so it is written as-is — removing the key would only reveal a project/user
 * setting (`outputStyle: "Concise"`) that Claude would then use while the UI claimed Default.
 */
export function saveSelection({ projectPath, userDir = userConfigDir(), name }) {
  if (name !== 'default' && (typeof name !== 'string' || !name.trim() || name.length > 200)) {
    throw new OutputStyleError(400, 'Nama gaya tidak valid.');
  }
  const file = settingsFile(projectPath, 'local', userDir);
  let data = {};
  let indent = 2;
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink()) throw new OutputStyleError(409, `${path.basename(file)} berupa symlink; ubah langsung di file aslinya.`);
    const text = readFileSync(file, 'utf8');
    try {
      data = text.trim() ? JSON.parse(text.replace(/^\uFEFF/, '')) : {};
    } catch (err) {
      throw new OutputStyleError(409, `${path.basename(file)} bukan JSON yang valid (${err.message}). Perbaiki file itu dulu; Adhitron tidak akan menimpanya.`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new OutputStyleError(409, `${path.basename(file)} harus berisi objek JSON ({ … }).`);
    }
    indent = text.match(/^[{[]\r?\n([ \t]+)/)?.[1] ?? 2;
  } catch (err) {
    if (err instanceof OutputStyleError) throw err;
    if (err.code !== 'ENOENT') throw new OutputStyleError(500, `Tidak bisa membaca ${path.basename(file)}: ${err.code ?? err.message}`);
    mkdirSync(path.dirname(file), { recursive: true });
  }
  if (name === 'default') data.outputStyle = 'default';
  else data.outputStyle = name;
  const temp = path.join(path.dirname(file), `.settings-${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(temp, `${JSON.stringify(data, null, indent)}\n`);
  renameSync(temp, file);
  return { name, file };
}
