// 🧠 Memory: the instruction files the engine reads every session, editable from the app (no VS Code / terminal).
// Claude Code: CLAUDE.md (project, in git), CLAUDE.local.md (project, private), ~/.claude/CLAUDE.md (every project).
// OpenCode: AGENTS.md (project) and ~/.config/opencode/AGENTS.md (every project). Since OpenCode 2.3.1 it *again*
// reads CLAUDE.md in any directory with no AGENTS.md and falls back to ~/.claude/CLAUDE.md when the global AGENTS.md
// is missing (#64474/#64533): those fallbacks are read itself, so they are offered (and writable) whenever OpenCode
// would actually read them, or when they already exist on disk. The last matching file wins: AGENTS.md beats CLAUDE.md.
// Only these fixed paths are ever read or written; writes are atomic and refuse a file changed meanwhile. A symlink
// at one of these paths is refused (read and write): it could point anywhere on the laptop.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_MEMORY_BYTES = 256 * 1024;

export class MemoryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The same encoding Claude Code uses for its project folder (~/.claude/projects/<cwd with non-alnum → '-'>, see
// src/backup.js encodeProjectPath). Kept local so this module imports nothing heavy.
const encodeProjectPath = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');

/**
 * The rules a project declares per file type (`.claude/rules/*.md`) and Claude's own auto memory for this project
 * (`~/.claude/projects/<encoded-cwd>/memory/*.md`, written by Claude from corrections and preferences). Both are
 * Claude Code features; OpenCode has neither, so they are only offered for that engine. Keys are dynamic
 * (`rule:<name>` / `auto:<name>`) so each file can be edited on its own.
 */
function extraClaudeFiles(projectPath, home) {
  const out = [];
  try {
    const rulesDir = path.join(projectPath, '.claude', 'rules');
    for (const f of readdirSync(rulesDir).filter((f) => f.toLowerCase().endsWith('.md') && !f.startsWith('.')).sort()) {
      out.push({ key: `rule:${f.slice(0, -3)}`, label: `Aturan: ${f.slice(0, -3)}`, hint: 'Aturan yang dicakup per tipe file (.claude/rules). Dibaca Claude Code untuk project ini.', scope: 'project', path: path.join(rulesDir, f) });
    }
  } catch {
    // no rules folder: nothing to add
  }
  try {
    const memDir = path.join(home, '.claude', 'projects', encodeProjectPath(projectPath), 'memory');
    for (const f of readdirSync(memDir).filter((f) => f.toLowerCase().endsWith('.md') && !f.startsWith('.')).sort()) {
      const isIndex = f === 'MEMORY.md';
      out.push({ key: `auto:${f.slice(0, -3)}`, label: isIndex ? 'Auto memory (indeks)' : `Auto memory: ${f.slice(0, -3)}`, hint: 'Catatan yang ditulis Claude sendiri dari koreksi/preferensimu (auto memory). Milik project ini saja.', scope: 'project', path: path.join(memDir, f) });
    }
  } catch {
    // no auto memory yet: nothing to add
  }
  return out;
}

/**
 * The memory files of `engine` for a project: [{ key, label, hint, scope, path }].
 * `scope` is 'user' for files that steer every project on this laptop (written from the laptop only, see
 * src/routes/memory.js), 'project' otherwise.
 */
export function memoryFiles(engine, projectPath, home = os.homedir()) {
  if (engine === 'opencode') {
    const projectAgents = path.join(projectPath, 'AGENTS.md');
    const projectClaude = path.join(projectPath, 'CLAUDE.md');
    const userAgents = path.join(home, '.config', 'opencode', 'AGENTS.md');
    const userClaude = path.join(home, '.claude', 'CLAUDE.md');
    const files = [
      { key: 'project', label: 'AGENTS.md (project)', hint: 'Instruksi untuk project ini. Biasanya ikut di-commit ke git. Menang atas CLAUDE.md.', scope: 'project', path: projectAgents },
    ];
    // OpenCode 2.3.1 reads CLAUDE.md in a project that has no AGENTS.md (#64474). Offer it when it is what OpenCode
    // reads, or when it already exists (so an old file can still be edited): a hidden steering file is worse.
    if (!existsSync(projectAgents) || existsSync(projectClaude))
      files.push({ key: 'project-claude', label: 'CLAUDE.md (project, cadangan)', hint: 'Dibaca OpenCode hanya bila AGENTS.md tidak ada. Berguna untuk project yang sudah punya CLAUDE.md.', scope: 'project', path: projectClaude });
    files.push({ key: 'user', label: 'AGENTS.md (semua project)', hint: 'Instruksi pribadimu untuk semua project (~/.config/opencode/AGENTS.md). Menang atas ~/.claude/CLAUDE.md.', scope: 'user', path: userAgents });
    // The global fallback is the same file Claude Code reads (~/.claude/CLAUDE.md), so it is offered the same way.
    if (!existsSync(userAgents) || existsSync(userClaude))
      files.push({ key: 'user-claude', label: 'CLAUDE.md (semua project, cadangan)', hint: 'Dibaca OpenCode hanya bila AGENTS.md global tidak ada — file yang sama dengan Claude Code (~/.claude/CLAUDE.md).', scope: 'user', path: userClaude });
    return files;
  }
  return [
    { key: 'project', label: 'CLAUDE.md (project)', hint: 'Instruksi untuk project ini. Biasanya ikut di-commit ke git, dibaca semua orang di tim.', scope: 'project', path: path.join(projectPath, 'CLAUDE.md') },
    { key: 'local', label: 'CLAUDE.local.md (pribadi)', hint: 'Instruksi pribadimu untuk project ini. Tambahkan ke .gitignore.', scope: 'project', path: path.join(projectPath, 'CLAUDE.local.md') },
    { key: 'user', label: 'CLAUDE.md (semua project)', hint: 'Instruksi pribadimu untuk semua project (~/.claude/CLAUDE.md).', scope: 'user', path: path.join(home, '.claude', 'CLAUDE.md') },
    ...extraClaudeFiles(projectPath, home),
  ];
}

function fileOf(engine, projectPath, key, home) {
  const file = memoryFiles(engine, projectPath, home).find((f) => f.key === key);
  if (!file) throw new MemoryError(400, 'File memory tidak dikenal.');
  return file;
}

/** One file with its content; a missing file is empty (created on save). */
export function readMemory(engine, projectPath, key, home) {
  const file = fileOf(engine, projectPath, key, home);
  try {
    const st = lstatSync(file.path); // lstat: a symlink is seen as one, never followed
    if (st.isSymbolicLink()) throw new MemoryError(409, `${file.label} adalah symlink; buka file aslinya di editor.`);
    if (!st.isFile()) throw new MemoryError(409, `${file.label} bukan file biasa.`);
    if (st.size > MAX_MEMORY_BYTES) throw new MemoryError(413, `${file.label} terlalu besar untuk diedit di sini (maks 256 KB).`);
    return { ...file, exists: true, content: readFileSync(file.path, 'utf8'), mtime: st.mtimeMs };
  } catch (err) {
    if (err instanceof MemoryError) throw err;
    if (err.code === 'ENOENT') return { ...file, exists: false, content: '', mtime: 0 };
    throw err;
  }
}

/**
 * Saves `content`. `baseMtime` is the mtime the editor loaded (0 = file did not exist): a file changed since
 * (an edit in VS Code, Claude writing to it) is refused with 409 instead of being overwritten.
 */
export function writeMemory(engine, projectPath, key, content, baseMtime, home) {
  const file = fileOf(engine, projectPath, key, home);
  if (typeof content !== 'string') throw new MemoryError(400, 'Isi file harus teks.');
  if (Buffer.byteLength(content) > MAX_MEMORY_BYTES) throw new MemoryError(413, 'Isi terlalu besar (maks 256 KB).');
  let current = 0;
  try {
    const st = lstatSync(file.path);
    if (st.isSymbolicLink()) throw new MemoryError(409, `${file.label} adalah symlink; buka file aslinya di editor.`);
    if (!st.isFile()) throw new MemoryError(409, `${file.label} bukan file biasa.`);
    current = st.mtimeMs;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (Math.abs(current - (Number(baseMtime) || 0)) > 1) throw new MemoryError(409, `${file.label} sudah berubah sejak dibuka (diedit di tempat lain). Muat ulang dulu.`);
  mkdirSync(path.dirname(file.path), { recursive: true });
  const tmp = `${file.path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file.path);
  return readMemory(engine, projectPath, key, home);
}
