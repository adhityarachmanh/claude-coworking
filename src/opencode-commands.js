// OpenCode slash commands: one Markdown file per command in `.opencode/commands` (project) or
// `<config>/opencode/commands` (every project), plus the legacy singular `command/` folder, which OpenCode still
// discovers. A command's path is its name (`team/deploy.md` → `/team/deploy`); the front matter carries metadata and
// the body is the template. Nothing here starts OpenCode: writes are validated, atomic, backed up, and contained.
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openCodeConfigRoot } from './opencode-config.js';

export const COMMAND_LIMITS = Object.freeze({ bytes: 64 * 1024, id: 64, description: 500, agent: 200, model: 200, depth: 4 });

export class CommandError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SEGMENT = /^[A-Za-z0-9][\w.-]{0,63}$/;
const MAX_BACKUPS = 20;

export function validCommandId(id) {
  const text = String(id ?? '');
  const parts = text.split('/');
  return parts.length >= 1 && parts.length <= COMMAND_LIMITS.depth && parts.every((part) => SEGMENT.test(part) && part !== '.' && part !== '..');
}

/** The roots OpenCode reads, in rising precedence: project (canonical, then legacy) and global (canonical, then legacy). */
export function commandRoots({ projectPath, env = process.env }) {
  const global = openCodeConfigRoot(env);
  return [
    { scope: 'project', dir: path.join(projectPath, '.opencode', 'commands'), source: '.opencode/commands (project)' },
    { scope: 'project', dir: path.join(projectPath, '.opencode', 'command'), source: '.opencode/command (project, lama)' },
    { scope: 'user', dir: path.join(global, 'commands'), source: 'commands OpenCode (semua project)' },
    { scope: 'user', dir: path.join(global, 'command'), source: 'command OpenCode (semua project, lama)' },
  ];
}

/**
 * "---\ndescription: x\n---\nbody" → fields, the template body and the raw front block. A file without front matter
 * keeps its whole text as the template. Unknown front matter lines survive a save through `front`.
 */
export function parseCommandFile(text) {
  const source = String(text ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return { description: '', agent: '', model: '', subagent: null, subtask: null, front: null, template: source };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '');
  }
  const bool = (value) => (value === 'true' ? true : value === 'false' ? false : null);
  return {
    description: meta.description ?? '',
    agent: meta.agent ?? '',
    model: meta.model ?? '',
    subagent: bool(meta.subagent),
    subtask: bool(meta.subtask),
    front: match[1],
    template: match[2].replace(/^\r?\n/, ''),
  };
}

const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

const rootFor = ({ projectPath, env, scope, source }) => {
  const roots = commandRoots({ projectPath, env }).filter((root) => root.scope === scope);
  const root = source == null ? roots[0] : roots.find((entry) => entry.source === source);
  if (!root) throw new CommandError(400, 'Lokasi command tidak dikenal.');
  return root.dir;
};

function safeRoot(dir, { create = true } = {}) {
  if (create) mkdirSync(dir, { recursive: true });
  let info;
  try {
    info = lstatSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new CommandError(500, `Tidak bisa membaca folder command: ${err.code ?? err.message}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new CommandError(409, 'Folder command berupa symlink; ubah langsung di folder aslinya.');
  let real;
  try {
    real = realpathSync(dir);
  } catch (err) {
    throw new CommandError(409, `Folder command tidak bisa dibaca (${err.code ?? err.message}).`);
  }
  if (!samePath(real, path.resolve(dir))) throw new CommandError(409, 'Folder command menunjuk ke luar folder project; ubah langsung di folder aslinya.');
  return real;
}

function safeFile(realRoot, file) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (info.isSymbolicLink()) throw new CommandError(409, 'File command berupa symlink; ubah langsung di file aslinya.');
  if (!info.isFile()) throw new CommandError(409, 'File command bukan berkas biasa.');
  const real = realpathSync(file);
  if (!samePath(path.dirname(real), realRoot)) throw new CommandError(409, 'File command menunjuk ke luar folder project; ubah langsung di file aslinya.');
  return info;
}

const fileFor = (dir, id) => path.join(dir, ...String(id).split('/')) + '.md';
const idOf = (root, file) => path.relative(root, file).split(path.sep).join('/').replace(/\.md$/i, '');

/** All `.md` files under one root (depth-limited, hidden folders skipped). */
function walk(dir, base, out, depth = 0) {
  if (depth > COMMAND_LIMITS.depth) return;
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of names) {
    if (entry.name.startsWith('.')) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, base, out, depth + 1);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      try {
        const info = lstatSync(file);
        if (info.size > 256 * 1024) continue;
        out.push({ file, id: idOf(base, file), mtime: info.mtimeMs });
      } catch {
        // unreadable file: skip it, never fail the list
      }
    }
  }
}

/** Every command OpenCode would see; a project command wins over a global one with the same id. */
export function listCommands({ projectPath, env = process.env }) {
  const seen = new Map();
  for (const root of commandRoots({ projectPath, env })) {
    let real;
    try {
      real = safeRoot(root.dir, { create: false });
    } catch {
      continue; // a symlinked legacy root is ignored rather than failing the editor
    }
    if (!real) continue;
    const found = [];
    walk(real, real, found);
    for (const entry of found) {
      if (seen.has(entry.id) || !validCommandId(entry.id)) continue;
      try {
        const parsed = parseCommandFile(readFileSync(entry.file, 'utf8'));
        seen.set(entry.id, {
          id: entry.id,
          description: parsed.description,
          agent: parsed.agent,
          model: parsed.model,
          subagent: parsed.subagent ?? parsed.subtask,
          scope: root.scope,
          source: root.source,
          mtime: entry.mtime,
        });
      } catch {
        // skip unreadable
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** One command with its template, for the editor. */
export function readCommand({ projectPath, env = process.env, scope, source, id }) {
  if (!validCommandId(id)) throw new CommandError(400, 'Nama command tidak valid (huruf/angka, -, _, titik; boleh bersarang dengan /).');
  const dir = rootFor({ projectPath, env, scope, source });
  const root = safeRoot(dir, { create: false });
  if (!root) throw new CommandError(404, 'Command tidak ditemukan.');
  const file = fileFor(root, id);
  const info = safeFile(root, file);
  if (!info) throw new CommandError(404, 'Command tidak ditemukan.');
  const parsed = parseCommandFile(readFileSync(file, 'utf8'));
  return {
    id,
    description: parsed.description,
    agent: parsed.agent,
    model: parsed.model,
    subagent: parsed.subagent ?? parsed.subtask,
    template: parsed.template,
    front: parsed.front,
    scope,
    source: source ?? commandRoots({ projectPath, env }).find((entry) => entry.scope === scope)?.source,
    mtime: info.mtimeMs,
  };
}

export const commandBackupRoot = (dataDir) => {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('dataDir is required for command backups');
  return path.join(dataDir, 'opencode-command-backups');
};

function backupCommand(file, { dataDir, scope, id }) {
  const root = commandBackupRoot(dataDir);
  mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = `${scope}~${id.replace(/\//g, '__')}~`;
  const dest = path.join(root, `${prefix}${stamp}-${randomBytes(3).toString('hex')}.md`);
  writeFileSync(dest, readFileSync(file));
  const mine = readdirSync(root).filter((name) => name.startsWith(prefix)).sort();
  for (const name of mine.slice(0, Math.max(0, mine.length - MAX_BACKUPS))) unlinkSync(path.join(root, name));
  return dest;
}

const cleanText = (value, max, field) => {
  const text = oneLine(value);
  if (text.length > max) throw new CommandError(400, `${field} maksimal ${max} karakter.`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new CommandError(400, `${field} tidak boleh memuat karakter kontrol.`);
  return text;
};

/** Rewrites the known front matter keys, keeping every other line exactly where it was. */
function commandText(front, fields, template) {
  const lines = front == null ? [] : front.split(/\r?\n/);
  const set = (key, value) => {
    const at = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
    if (value == null || value === '') {
      if (at !== -1) lines.splice(at, 1);
      return;
    }
    if (at === -1) lines.push(`${key}: ${value}`);
    else lines[at] = `${key}: ${value}`;
  };
  set('description', fields.description);
  set('agent', fields.agent);
  set('model', fields.model);
  set('subagent', fields.subagent === true ? 'true' : null);
  // An explicit false in the form overrides a legacy `subtask: true`; both keys are then absent (session default).
  if (fields.subagent === true || fields.subagent === false) {
    const at = lines.findIndex((line) => /^subtask:/.test(line));
    if (at !== -1) lines.splice(at, 1);
  }
  const body = String(template ?? '');
  return `---\n${lines.join('\n')}\n---\n\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

/**
 * Creates a command or edits one (`previous` is the old id, so a rename moves the file). The old file is backed up
 * first; a file that changed since the editor read it (`mtime`) is never overwritten.
 */
export function saveCommand({
  projectPath,
  env = process.env,
  dataDir,
  scope,
  source,
  id,
  previous,
  description = '',
  agent = '',
  model = '',
  subagent = null,
  template = '',
  mtime,
}) {
  if (!validCommandId(id)) throw new CommandError(400, 'Nama command tidak valid (huruf/angka, -, _, titik; boleh bersarang dengan /).');
  if (previous != null && !validCommandId(previous)) throw new CommandError(400, 'Nama command lama tidak valid.');
  const dir = rootFor({ projectPath, env, scope, source });
  const root = safeRoot(dir);
  const nextFile = fileFor(root, id);
  const oldFile = previous == null ? null : fileFor(root, previous);
  const descriptionText = cleanText(description, COMMAND_LIMITS.description, 'Deskripsi');
  const agentText = cleanText(agent, COMMAND_LIMITS.agent, 'Agent');
  const modelText = cleanText(model, COMMAND_LIMITS.model, 'Model');
  if (typeof template !== 'string') throw new CommandError(400, 'Isi command harus berupa teks.');
  if (Buffer.byteLength(template, 'utf8') > COMMAND_LIMITS.bytes) throw new CommandError(413, `Isi command maksimal ${COMMAND_LIMITS.bytes / 1024} KB.`);
  let front = null;
  let backedUp = null;
  if (oldFile) {
    const info = safeFile(root, oldFile);
    if (!info) throw new CommandError(404, 'Command tidak ditemukan.');
    if (mtime != null && Number(mtime) !== info.mtimeMs) throw new CommandError(409, 'File command sudah berubah di tempat lain. Muat ulang dulu, lalu coba lagi.');
    front = parseCommandFile(readFileSync(oldFile, 'utf8')).front;
    if (previous !== id && safeFile(root, nextFile)) throw new CommandError(409, 'Nama command itu sudah dipakai file lain.');
    backedUp = backupCommand(oldFile, { dataDir, scope, id: previous });
  } else if (safeFile(root, nextFile)) {
    throw new CommandError(409, 'Nama command itu sudah dipakai file lain.');
  }
  const text = commandText(front, { description: descriptionText, agent: agentText, model: modelText, subagent: subagent === true ? true : subagent === false ? false : null }, template);
  mkdirSync(path.dirname(nextFile), { recursive: true });
  const temp = path.join(path.dirname(nextFile), `.${path.basename(nextFile)}-${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(temp, text);
  renameSync(temp, nextFile);
  if (oldFile && previous !== id) unlinkSync(oldFile);
  return { command: { id, description: descriptionText, agent: agentText, model: modelText, subagent: subagent === true ? true : subagent === false ? false : null, scope, source, mtime: statSync(nextFile).mtimeMs }, backedUp };
}

/** Deletes one command after backing it up; the file must be the one the editor read (`mtime`). */
export function deleteCommand({ projectPath, env = process.env, dataDir, scope, source, id, mtime }) {
  if (!validCommandId(id)) throw new CommandError(400, 'Nama command tidak valid.');
  const dir = rootFor({ projectPath, env, scope, source });
  const root = safeRoot(dir, { create: false });
  if (!root) throw new CommandError(404, 'Command tidak ditemukan.');
  const file = fileFor(root, id);
  const info = safeFile(root, file);
  if (!info) throw new CommandError(404, 'Command tidak ditemukan.');
  if (mtime != null && Number(mtime) !== info.mtimeMs) throw new CommandError(409, 'File command sudah berubah di tempat lain. Muat ulang dulu, lalu coba lagi.');
  const backedUp = backupCommand(file, { dataDir, scope, id });
  unlinkSync(file);
  return { backedUp };
}
