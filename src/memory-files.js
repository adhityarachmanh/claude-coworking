// 🧠 Memory: the instruction files the engine reads every session, editable from the app (no VS Code / terminal).
// Claude Code: CLAUDE.md (project, in git), CLAUDE.local.md (project, private), ~/.claude/CLAUDE.md (every project).
// OpenCode: AGENTS.md (project) and ~/.config/opencode/AGENTS.md (every project).
// Only these fixed paths are ever read or written; writes are atomic and refuse a file changed meanwhile.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_MEMORY_BYTES = 256 * 1024;

export class MemoryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The memory files of `engine` for a project: [{ key, label, hint, path }]. */
export function memoryFiles(engine, projectPath, home = os.homedir()) {
  if (engine === 'opencode') {
    return [
      { key: 'project', label: 'AGENTS.md (project)', hint: 'Instruksi untuk project ini. Biasanya ikut di-commit ke git.', path: path.join(projectPath, 'AGENTS.md') },
      { key: 'user', label: 'AGENTS.md (semua project)', hint: 'Instruksi pribadimu untuk semua project (~/.config/opencode/AGENTS.md).', path: path.join(home, '.config', 'opencode', 'AGENTS.md') },
    ];
  }
  return [
    { key: 'project', label: 'CLAUDE.md (project)', hint: 'Instruksi untuk project ini. Biasanya ikut di-commit ke git, dibaca semua orang di tim.', path: path.join(projectPath, 'CLAUDE.md') },
    { key: 'local', label: 'CLAUDE.local.md (pribadi)', hint: 'Instruksi pribadimu untuk project ini. Tambahkan ke .gitignore.', path: path.join(projectPath, 'CLAUDE.local.md') },
    { key: 'user', label: 'CLAUDE.md (semua project)', hint: 'Instruksi pribadimu untuk semua project (~/.claude/CLAUDE.md).', path: path.join(home, '.claude', 'CLAUDE.md') },
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
    const st = statSync(file.path);
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
    current = statSync(file.path).mtimeMs;
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
