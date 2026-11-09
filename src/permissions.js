// Saved permission rules of Claude Code (its /permissions dialog): the `permissions.allow / deny / ask`
// lists in its settings files. "Izinkan selalu" on an approval card adds to them (updatedPermissions →
// usually <project>/.claude/settings.local.json); this module reads them per source and edits them.
//
// Edits change only `permissions.<list>`: every other key of the file stays as it was. A missing file is
// created, a file that isn't valid JSON is never overwritten (the user fixes it by hand first).
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A refused read/edit; `status` is the HTTP status, the message is shown to the user as is. */
export class PermissionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const RULE_LISTS = ['allow', 'deny', 'ask'];
export const SCOPES = ['local', 'project', 'user'];
const SCOPE_INFO = {
  local: { label: 'Project lokal', hint: 'Hanya kamu, project ini (.claude/settings.local.json — tidak ikut git). Tempat "Izinkan selalu" menyimpan.' },
  project: { label: 'Project bersama', hint: 'Semua orang di repo ini (.claude/settings.json — ikut git).' },
  user: { label: 'User', hint: 'Semua project di laptop ini (~/.claude/settings.json).' },
};
const MAX_RULE = 500;
const MAX_FILE = 1024 * 1024;
// `Tool` or `Tool(pattern)`: a tool name (Bash, Read, WebFetch, mcp__server__tool…), optionally one
// parenthesised specifier. No control characters; the specifier itself is Claude Code's business.
const RULE = /^[A-Za-z][\w-]*(\([^\u0000-\u001f\u007f]+\))?$/;

/** Claude Code's own config folder: CLAUDE_CONFIG_DIR when set (Claude Code honours it too), else ~/.claude. */
export const userConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

export function settingsFile(projectPath, scope, userDir = userConfigDir()) {
  if (scope === 'local') return path.join(projectPath, '.claude', 'settings.local.json');
  if (scope === 'project') return path.join(projectPath, '.claude', 'settings.json');
  if (scope === 'user') return path.join(userDir, 'settings.json');
  throw new PermissionError('Sumber aturan tidak dikenal.');
}

/** Validates a rule typed by hand; returns it trimmed or throws PermissionError. */
export function cleanRule(input) {
  const rule = String(input ?? '').trim();
  if (!rule) throw new PermissionError('Aturan kosong.');
  if (rule.length > MAX_RULE) throw new PermissionError(`Aturan maksimal ${MAX_RULE} karakter.`);
  if (!RULE.test(rule)) throw new PermissionError('Format aturan: Tool atau Tool(pola) — contoh: Bash(npm run test:*), Read(src/**), WebFetch(domain:example.com), mcp__github.');
  return rule;
}

const checkList = (list) => {
  if (!RULE_LISTS.includes(list)) throw new PermissionError('Daftar harus allow, deny, atau ask.');
  return list;
};

/** Reads one settings file: { exists, data } — or throws PermissionError for unreadable / invalid JSON. */
async function loadSettings(file) {
  let text;
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new PermissionError(`${path.basename(file)} berupa symlink; ubah langsung di file aslinya.`, 409);
    if (info.size > MAX_FILE) throw new PermissionError(`${path.basename(file)} terlalu besar untuk dibaca (> 1 MB).`, 409);
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof PermissionError) throw err;
    if (err.code === 'ENOENT') return { exists: false, data: {}, indent: 2 };
    throw new PermissionError(`Tidak bisa membaca ${path.basename(file)}: ${err.code ?? err.message}`, 500);
  }
  let data;
  try {
    data = text.trim() ? JSON.parse(text.replace(/^﻿/, '')) : {};
  } catch (err) {
    throw new PermissionError(`${path.basename(file)} bukan JSON yang valid (${err.message}). Perbaiki file itu dulu; Adhitron tidak akan menimpanya.`, 409);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PermissionError(`${path.basename(file)} harus berisi objek JSON ({ … }).`, 409);
  return { exists: true, data, indent: text.match(/^[{[]\r?\n([ \t]+)/)?.[1] ?? 2 };
}

/** The rule lists of a parsed settings object; anything malformed is reported, not guessed. */
function rulesOf(data) {
  const perms = data.permissions;
  if (perms != null && (typeof perms !== 'object' || Array.isArray(perms))) throw new PermissionError('"permissions" di file ini bukan objek.', 409);
  const rules = {};
  for (const list of RULE_LISTS) {
    const value = perms?.[list];
    if (value != null && !Array.isArray(value)) throw new PermissionError(`"permissions.${list}" di file ini bukan array.`, 409);
    rules[list] = (value ?? []).filter((r) => typeof r === 'string');
  }
  return rules;
}

/** Shown path: ~ for the home folder, relative inside the project. */
function displayPath(file, projectPath) {
  const rel = path.relative(projectPath, file);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  const home = os.homedir();
  return file.startsWith(home + path.sep) ? `~/${path.relative(home, file).replace(/\\/g, '/')}` : file;
}

/** Every source with its rules. A broken file is reported on its own source, the others still show. */
export async function readPermissions(projectPath, { userDir = userConfigDir() } = {}) {
  const scopes = [];
  for (const scope of SCOPES) {
    const file = settingsFile(projectPath, scope, userDir);
    const entry = { scope, ...SCOPE_INFO[scope], file: displayPath(file, projectPath), exists: false, rules: { allow: [], deny: [], ask: [] } };
    try {
      const { exists, data } = await loadSettings(file);
      entry.exists = exists;
      entry.rules = rulesOf(data);
    } catch (err) {
      if (!(err instanceof PermissionError)) throw err;
      entry.error = err.message;
    }
    scopes.push(entry);
  }
  return { scopes };
}

/** Write-to-temp + rename: Claude Code (or an editor) never sees a half-written file. */
async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text, 'utf8');
  // Windows: a rename over a file another process holds open can fail for a moment (EPERM/EBUSY).
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await rm(tmp, { force: true });
        throw new PermissionError(`Gagal menyimpan ${path.basename(file)}: ${err.code ?? err.message}`, 500);
      }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

// One edit per file at a time (two quick clicks must not lose one of the changes).
const queues = new Map();
function serialized(file, fn) {
  const run = (queues.get(file) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(file, tail);
  tail.then(() => queues.get(file) === tail && queues.delete(file));
  return run;
}

/**
 * Changes one rule. `action`:
 * - add:    { list, rule }       — rule validated, must not be in that list yet
 * - remove: { list, rule }       — rule must be there (removed exactly as stored)
 * - move:   { list, rule, to }   — e.g. allow → deny; removed from `list`, added to `to`
 * Returns the source's rules after the change.
 */
export async function editPermission(projectPath, { scope, action, list, rule, to } = {}, { userDir = userConfigDir() } = {}) {
  if (!SCOPES.includes(scope)) throw new PermissionError('Sumber aturan tidak dikenal.');
  if (!['add', 'remove', 'move'].includes(action)) throw new PermissionError('Aksi tidak dikenal.');
  checkList(list);
  if (action === 'move' && checkList(to) === list) throw new PermissionError('Pilih daftar tujuan yang berbeda.');
  // add: a hand-typed rule is validated; remove/move: the stored text exactly (it may predate our format check).
  const wanted = action === 'add' ? cleanRule(rule) : String(rule ?? '');
  if (!wanted) throw new PermissionError('Aturan kosong.');
  const file = settingsFile(projectPath, scope, userDir);
  return serialized(file, async () => {
    const { exists, data, indent } = await loadSettings(file);
    const rules = rulesOf(data); // validates the shape before anything is changed
    if (action === 'add') {
      if (rules[list].includes(wanted)) throw new PermissionError(`"${wanted}" sudah ada di ${list}.`, 409);
      rules[list].push(wanted);
    } else {
      if (!exists || !rules[list].includes(wanted)) throw new PermissionError(`"${wanted}" tidak ada di ${list} (mungkin sudah diubah).`, 404);
      rules[list] = rules[list].filter((r) => r !== wanted);
      if (action === 'move' && !rules[to].includes(wanted)) rules[to].push(wanted);
    }
    // Only the touched lists change; the other keys of `permissions` (defaultMode, additionalDirectories…)
    // and of the file keep their values and order. A list that was never there and stays empty is not added.
    const perms = data.permissions && typeof data.permissions === 'object' ? data.permissions : (data.permissions = {});
    for (const name of action === 'move' ? [list, to] : [list]) {
      if (perms[name] !== undefined || rules[name].length) perms[name] = rules[name];
    }
    await writeAtomic(file, `${JSON.stringify(data, null, indent)}\n`);
    return { scope, file: displayPath(file, projectPath), rules: rulesOf(data) };
  });
}
