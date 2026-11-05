// Read-only file viewer (📄 Lihat file): one text file, normally inside a project folder. A laptop-confirmed path
// outside the project is allowed only under temp or the user's Desktop/Documents/Downloads/Pictures (see
// resolveOutsideFile). Every path is checked twice:
// lexically (resolve) and on disk (realpath), so `..`, symlinks/junctions, UNC/device paths and NTFS streams are refused.
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

export const MAX_VIEW_BYTES = 512 * 1024;
// 👁 Pratinjau: images come back whole (base64) up to this size, shown as <img> (never as text)
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
const MAX_PATH = 1024;
// A bare file name Claude wrote in prose ("server.test.mjs") is looked up below the project, bounded.
const FIND_SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'target']);
const FIND_MAX_DEPTH = 8;
const FIND_MAX_ENTRIES = 20000;

/** An error meant for the user, with the HTTP status it is sent with. */
export class FileViewError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Windows reserved device names (CON, NUL, COM1…), with or without an extension: they are not files.
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

// Files that usually hold secrets. Shown on the laptop only after a click; never sent to a phone.
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker']);
const SECRET_EXT = /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i;
const SECRET_NAME = /^(\.npmrc|\.pypirc|\.netrc|_netrc|\.pgpass|\.git-credentials|\.htpasswd|credentials(\.(json|ya?ml|ini|xml|toml|txt|csv))?|.*credentials\.json|secrets?\.(json|ya?ml|toml|env)|service-account.*\.json|\.dockercfg)$/i;
const ENV_SAFE = /^\.env\.(example|sample|template|dist|defaults)$/i;

/** True for `.env*`, `*.pem`, `id_*` (not `.pub`), credential files and anything under ~/.ssh-like folders. */
export function isSecretPath(relPath) {
  const parts = String(relPath).split(/[\\/]+/).filter(Boolean);
  const name = parts.at(-1) ?? '';
  if (parts.slice(0, -1).some((p) => SECRET_DIRS.has(p.toLowerCase()))) return true;
  if (/^\.env($|\.)/i.test(name)) return !ENV_SAFE.test(name);
  if (/^id_[\w-]+$/i.test(name)) return true; // id_rsa, id_ed25519 (id_rsa.pub has a dot: public)
  return SECRET_EXT.test(name) || SECRET_NAME.test(name);
}

const LANGS = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'ts', json: 'json', jsonc: 'json',
  css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
  md: 'md', markdown: 'md', txt: 'text', log: 'text',
  py: 'py', rb: 'rb', php: 'php', java: 'java', kt: 'kotlin', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'cs', swift: 'swift', dart: 'dart', lua: 'lua',
  sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'ps1', psm1: 'ps1', bat: 'bat', cmd: 'bat',
  sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', env: 'env', dockerfile: 'dockerfile',
};

/** Highlighter language for a file name ('text' when unknown). */
export function languageOf(file) {
  const name = path.basename(String(file)).toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name.startsWith('.env')) return 'env';
  if (name === 'makefile') return 'sh';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return LANGS[ext] ?? 'text';
}

/** `child` is `root` itself or below it (case-insensitive on Windows, like path.relative there). */
function inside(root, child) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Validates a client path and returns { abs, rel } inside the project, or throws FileViewError. */
/** Files named `name` below `root` (relative paths), breadth-first, bounded; stops after 6 hits. */
async function findByName(root, name) {
  const want = process.platform === 'win32' ? name.toLowerCase() : name;
  const hits = [];
  let seen = 0;
  let level = [''];
  for (let depth = 0; depth <= FIND_MAX_DEPTH && level.length && hits.length < 6; depth++) {
    const next = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await readdir(path.join(root, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (++seen > FIND_MAX_ENTRIES) return hits;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!FIND_SKIP.has(e.name) && !e.name.startsWith('.')) next.push(rel);
        } else if (e.isFile() && (process.platform === 'win32' ? e.name.toLowerCase() : e.name) === want) hits.push(rel);
      }
    }
    level = next;
  }
  return hits;
}

export async function resolveProjectFile(projectPath, input) {
  try {
    return await resolveExact(projectPath, input);
  } catch (err) {
    // "server.test.mjs" in Claude's prose: not at the root, but maybe exactly one file of that name below it.
    const name = typeof input === 'string' ? input.trim() : '';
    if (!(err instanceof FileViewError) || err.status !== 404 || /[\\/]/.test(name) || !/^[\w.@+-]+\.\w+$/.test(name)) throw err;
    const hits = await findByName(path.resolve(projectPath), name);
    if (hits.length === 1) return resolveExact(projectPath, hits[0]); // the same checks again (symlinks, secrets…)
    if (hits.length > 1) throw new FileViewError(404, `Ada beberapa file bernama ${name}: ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', …' : ''}. Buka lewat path lengkapnya.`);
    throw err;
  }
}

async function resolveExact(projectPath, input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new FileViewError(400, 'Path file kosong.');
  if (raw.length > MAX_PATH || raw.includes('\0')) throw new FileViewError(400, 'Path file tidak valid.');
  // UNC (\\server\share, //server), device namespaces (\\?\, \\.\, \??\): never touched.
  if (/^([\\/]{2}|\\\?\?\\)/.test(raw)) throw new FileViewError(400, 'Path jaringan/perangkat tidak diizinkan.');
  // A colon is only allowed as a drive letter (C:\…): anything else is an NTFS stream (file.txt:secret) or junk.
  if (raw.replace(/^[A-Za-z]:(?=[\\/])/, '').includes(':')) throw new FileViewError(400, 'Path file tidak valid.');
  if (raw.split(/[\\/]+/).some((part) => DEVICE_NAME.test(part.replace(/[. ]+$/, '')))) throw new FileViewError(400, 'Path file tidak valid.');

  const root = path.resolve(projectPath);
  const abs = path.resolve(root, raw);
  if (!inside(root, abs) || abs === root) throw new FileViewError(403, 'File di luar folder project.');

  let realRoot;
  let real;
  try {
    realRoot = await realpath(root);
    real = await realpath(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new FileViewError(404, 'File tidak ditemukan (mungkin sudah dihapus atau dipindah).');
    throw new FileViewError(400, 'File tidak bisa dibaca.');
  }
  // A symlink / junction inside the project that points elsewhere is still "outside".
  if (!inside(realRoot, real)) throw new FileViewError(403, 'File di luar folder project (lewat symlink).');
  return { abs: real, rel: path.relative(realRoot, real).split(path.sep).join('/') };
}

/**
 * A local absolute file outside the project, but only under the user's home or the OS temp folder. The client asks
 * first; the server still enforces it so a stray request cannot read arbitrary files. Secrets keep the same gate.
 */
async function resolveOutsideFile(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw || raw.length > MAX_PATH || raw.includes('\0')) throw new FileViewError(400, 'Path file tidak valid.');
  if (/^([\\/]{2}|\\\?\?\\)/.test(raw)) throw new FileViewError(400, 'Path jaringan/perangkat tidak diizinkan.');
  if (!path.isAbsolute(raw)) throw new FileViewError(403, 'File di luar project harus memakai path lengkap.');
  if (raw.replace(/^[A-Za-z]:(?=[\\/])/, '').includes(':')) throw new FileViewError(400, 'Path file tidak valid.');
  if (raw.split(/[\\/]+/).some((part) => DEVICE_NAME.test(part.replace(/[. ]+$/, '')))) throw new FileViewError(400, 'Path file tidak valid.');

  let real;
  try {
    real = await realpath(path.resolve(raw));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new FileViewError(404, 'File tidak ditemukan (mungkin sudah dihapus atau dipindah).');
    throw new FileViewError(400, 'File tidak bisa dibaca.');
  }
  // Not all of home: AppData/.config hold the app's own keys and shell history. Keep the user-facing folders and temp.
  const home = homedir();
  const candidates = [tmpdir(), ...['Desktop', 'Documents', 'Downloads', 'Pictures'].map((name) => (home ? path.join(home, name) : null))];
  const roots = await Promise.all(
    candidates.filter(Boolean).map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return null;
      }
    }),
  );
  if (!roots.filter(Boolean).some((root) => inside(root, real))) {
    throw new FileViewError(403, 'File di luar project hanya bisa dibuka dari folder Temp, Desktop, Documents, Downloads, atau Pictures.');
  }
  return { abs: real, rel: real.split(path.sep).join('/') };
}

/**
 * Reads a text file of the project for the viewer.
 * @param {{ allowSecret?: boolean, reveal?: boolean, allowOutside?: boolean }} opts allowSecret: false refuses
 *   secret files (phones); true returns them only with `reveal` (the laptop confirms with a click first), else
 *   without content. allowOutside: the laptop already confirmed a path outside the project (temp/user folders only).
 */
export async function readProjectFile(projectPath, input, { allowSecret = false, reveal = false, allowOutside = false } = {}) {
  let resolved;
  try {
    resolved = await resolveProjectFile(projectPath, input);
  } catch (err) {
    if (!allowOutside || !(err instanceof FileViewError) || err.status !== 403) throw err;
    resolved = await resolveOutsideFile(input);
  }
  const { abs, rel } = resolved;
  const secret = isSecretPath(rel) || isSecretPath(String(input));
  if (secret && !allowSecret) throw new FileViewError(403, 'File ini mungkin berisi rahasia (kunci/kredensial) dan hanya bisa dilihat dari laptop.');
  const info = await stat(abs);
  if (!info.isFile()) throw new FileViewError(400, 'Itu folder, bukan file.');
  const base = { path: rel, size: info.size, mtime: info.mtimeMs, language: languageOf(rel), secret };
  if (secret && !reveal) return { ...base, content: null, truncated: false };
  const ext = path.extname(rel).slice(1).toLowerCase();
  if (IMAGE_TYPES[ext]) {
    if (info.size > MAX_IMAGE_BYTES) throw new FileViewError(413, `Gambar terlalu besar untuk dipratinjau (maks ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`);
    const { readFile } = await import('node:fs/promises');
    return { ...base, language: 'image', content: null, image: { mime: IMAGE_TYPES[ext], data: (await readFile(abs)).toString('base64') }, truncated: false };
  }

  const length = Math.min(info.size, MAX_VIEW_BYTES);
  const buf = Buffer.alloc(length);
  const fh = await open(abs, 'r');
  let read = 0;
  try {
    while (read < length) {
      const { bytesRead } = await fh.read(buf, read, length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
  } finally {
    await fh.close();
  }
  const bytes = buf.subarray(0, read);
  if (bytes.includes(0)) throw new FileViewError(415, 'File biner (gambar, arsip, program) tidak bisa ditampilkan.');
  let content = bytes.toString('utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // BOM
  const truncated = info.size > read;
  // A cut in the middle of a multi-byte character decodes as U+FFFD: drop that last partial character.
  if (truncated) content = content.replace(/\uFFFD$/, '');
  return { ...base, content, truncated };
}
