// 🧩 Skills (SKILL.md): the instruction files each engine loads when relevant, managed from the app (no terminal).
// Pure rules + file operations only. Claude Code reads .claude/skills (project) and ~/.claude/skills (user).
// OpenCode 2.3.2 reads project .opencode/skills, plus the compatibility roots project .claude/skills and
// project .agents/skills, and the user roots ~/.config/opencode/skills, ~/.claude/skills and ~/.agents/skills.
// Precedence rises with the order returned by skillRoots (a later root wins). The skill id is the directory name,
// never the front matter `name` (OpenCode derives it from the path, case-sensitive). Adding a skill only adds
// instructions: it never grants a permission. Reads/writes touch only these fixed roots: a symlink at the root, at the
// skill folder or at the SKILL.md is refused, and the real path must stay inside the project (or the home folder for a
// user-scope root), so a linked folder can never make a save or a recursive delete land outside it. Backups of
// overwritten files live in the app's data folder, never next to the skill.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Windows reserves these device names (with any extension) for every folder: a skill directory named "con" would be
// unusable and confuse tooling, so the id is refused (same list as src/file-view.js).
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
export const MAX_SKILL_BYTES = 256 * 1024;
export const SKILL_FILE = 'SKILL.md';

export class SkillError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const validSkillId = (id) => {
  const s = String(id ?? '');
  return SKILL_ID.test(s) && !DEVICE_NAME.test(s);
};

/**
 * "---\nname: x\ndescription: y\n---\nbody" → { meta, body }. Simple `key: value` front matter, quotes stripped.
 * A file with no front matter yields an empty meta and the whole text as body (never throws).
 */
export function parseSkillFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!m) return { meta: {}, body: String(text) };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

const p = (...parts) => path.join(...parts);

/**
 * The directories each engine looks in, in rising precedence. `scope` is 'user' for the roots that steer every
 * project on this laptop (written from the laptop only) and 'project' otherwise. `source` is a short Indonesian
 * label for the UI; `engine` says which engine actually reads the root.
 */
export function skillRoots({ engine, projectPath, home = os.homedir() }) {
  const claudeProject = { source: '.claude/skills (project)', scope: 'project', dir: p(projectPath, '.claude', 'skills'), engine: 'claude' };
  const claudeUser = { source: '~/.claude/skills (semua project)', scope: 'user', dir: p(home, '.claude', 'skills'), engine: 'claude' };
  if (engine === 'opencode') {
    return [
      // OpenCode compatibility roots (read by OpenCode) first, then its own, in rising precedence.
      { source: '.claude/skills (project, kompat)', scope: 'project', dir: p(projectPath, '.claude', 'skills'), engine: 'opencode' },
      { source: '.agents/skills (project, kompat)', scope: 'project', dir: p(projectPath, '.agents', 'skills'), engine: 'opencode' },
      { source: '~/.claude/skills (kompat)', scope: 'user', dir: p(home, '.claude', 'skills'), engine: 'opencode' },
      { source: '~/.agents/skills (kompat)', scope: 'user', dir: p(home, '.agents', 'skills'), engine: 'opencode' },
      { source: '~/.config/opencode/skills (semua project)', scope: 'user', dir: p(home, '.config', 'opencode', 'skills'), engine: 'opencode' },
      { source: '.opencode/skills (project)', scope: 'project', dir: p(projectPath, '.opencode', 'skills'), engine: 'opencode' },
    ];
  }
  return [claudeProject, claudeUser];
}

/** One skill's own directory for a root the caller picked (source + scope), refusing anything outside the root. */
export function skillDir({ engine, projectPath, home, scope, source, id }) {
  if (!validSkillId(id)) throw new SkillError(400, 'Nama skill: huruf kecil, angka dan minus (maks 64), mis. git-release.');
  const root = skillRoots({ engine, projectPath, home }).find((r) => r.scope === scope && r.source === source);
  if (!root) throw new SkillError(400, 'Lokasi skill tidak dikenal.');
  const dir = path.resolve(root.dir, String(id));
  if (path.dirname(dir) !== path.resolve(root.dir)) throw new SkillError(400, 'Nama skill tidak valid.');
  return { ...root, projectPath, home, dir, file: p(dir, SKILL_FILE) };
}

const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

/**
 * The SKILL.md text: front matter (the skill's own keys, with name/description updated) then the body. Unknown keys
 * (`license`, `allowed-tools`, …) are kept in their original order instead of being lost on save.
 */
const skillText = (meta, { id, name, description }, body) =>
  [
    '---',
    ...meta.map(([k, v]) => `${k}: ${k === 'name' ? oneLine(name) || id : k === 'description' ? oneLine(description) : oneLine(v)}`),
    '---',
    '',
    String(body ?? '').replace(/^\s*\n/, '').trimEnd(),
    '',
  ].join('\n');

/** Front matter keys in order: the loaded ones (name/description replaced), plus name/description when missing. */
const frontmatterKeys = (meta) => {
  const base = meta && typeof meta === 'object' ? meta : {};
  const keys = Object.keys(base);
  for (const k of ['name', 'description']) if (!keys.includes(k)) keys.push(k);
  return keys.map((k) => [k, base[k]]);
};

const samePath = (a, b) => {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/**
 * The real path must sit inside a known boundary (the project folder, or the home folder for a user-scope root). The
 * boundary is resolved first (it always exists), so a symlink/junction at the root, at the skill folder or at an
 * ancestor cannot make a read, a write or a recursive delete land outside it. The folder itself may be missing (it is
 * created on save): in that case its nearest existing ancestor is resolved, so a link there is still caught.
 */
function assertInside(realBase, target) {
  let realTarget;
  try {
    realTarget = realpathSync(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const parent = path.dirname(target);
    if (samePath(parent, target)) throw new SkillError(409, 'Folder skill tidak aman: di luar lokasi yang diizinkan.');
    realTarget = path.join(assertInside(realBase, parent), path.basename(target));
  }
  const rel = path.relative(realBase, realTarget);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) throw new SkillError(409, 'Folder skill tidak aman: di luar lokasi yang diizinkan.');
  return realTarget;
}

/** A real, resolvable boundary: the project folder, or the home folder for a root that steers every project. */
const boundaryOf = ({ scope, projectPath, home }) => {
  const base = scope === 'user' ? (home ?? os.homedir()) : projectPath;
  if (!base || !existsSync(base)) throw new SkillError(409, 'Lokasi project tidak ditemukan.');
  return realpathSync(base);
};

/**
 * Checks one operation's paths (the target skill folder, and the old folder when renaming) against the boundary. The
 * SKILL.md file itself is checked for a symlink in read/save.
 */
function guardContainment(where, old) {
  assertInside(boundaryOf(where), where.dir);
  if (old) assertInside(boundaryOf(old), old.dir);
}

/**
 * The skills of both scopes for one engine: [{ id, name, description, scope, source, engine, dir, file, hasSupport }].
 * A directory is a skill when it holds a SKILL.md; the id is the directory name. A broken or oversized SKILL.md is
 * listed with an empty description instead of hiding the rest.
 */
export function listSkills({ engine, projectPath, home = os.homedir() }) {
  const out = [];
  const seen = new Set();
  for (const root of skillRoots({ engine, projectPath, home })) {
    let entries;
    try {
      entries = readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue; // root not there: nothing to list
    }
    let base;
    try {
      base = boundaryOf({ scope: root.scope, projectPath, home });
    } catch {
      continue; // project/home gone: nothing to list from this root
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = p(root.dir, entry.name, SKILL_FILE);
      if (!existsSync(file)) continue;
      const key = `${root.scope}:${entry.name}`;
      if (seen.has(key)) continue; // a project .claude/skills skill is not listed twice across compat roots
      seen.add(key);
      // A folder that resolves outside the project/home (a symlink or junction) is not a skill here.
      try {
        assertInside(base, p(root.dir, entry.name));
      } catch {
        continue;
      }
      let name = entry.name;
      let description = '';
      let hasSupport = false;
      try {
        const st = statSync(file);
        if (st.size <= MAX_SKILL_BYTES) {
          const { meta } = parseSkillFrontmatter(readFileSync(file, 'utf8'));
          name = meta.name || entry.name;
          description = oneLine(meta.description);
        }
        hasSupport = readdirSync(p(root.dir, entry.name)).some((f) => f !== SKILL_FILE);
      } catch {
        // unreadable: keep it listed with what we know
      }
      out.push({ id: entry.name, name, description, scope: root.scope, source: root.source, engine: root.engine, dir: p(root.dir, entry.name), file, hasSupport });
    }
  }
  return out;
}

/** One skill with its body (front matter stripped); a missing SKILL.md is empty (created on save). */
export function readSkill({ engine, projectPath, home, scope, source, id }) {
  const where = skillDir({ engine, projectPath, home, scope, source, id });
  guardContainment(where);
  let support = [];
  try {
    support = readdirSync(where.dir).filter((f) => f !== SKILL_FILE).map((f) => {
      try {
        return { name: f, bytes: statSync(p(where.dir, f)).size };
      } catch {
        return { name: f, bytes: 0 };
      }
    });
  } catch {
    // no directory yet: no support files
  }
  try {
    const st = lstatSync(where.file);
    if (st.isSymbolicLink()) throw new SkillError(409, 'SKILL.md adalah symlink; buka file aslinya di editor.');
    if (!st.isFile()) throw new SkillError(409, 'SKILL.md bukan file biasa.');
    if (st.size > MAX_SKILL_BYTES) throw new SkillError(413, 'SKILL.md terlalu besar untuk diedit di sini (maks 256 KB).');
    const { meta, body } = parseSkillFrontmatter(readFileSync(where.file, 'utf8'));
    // The blank line after the closing `---` belongs to the front matter, not the body: strip one so an
    // unchanged read→save round-trips to the same file. `metaKeys` keeps unknown keys in order for save.
    return { id, name: meta.name || id, description: oneLine(meta.description), metaKeys: frontmatterKeys(meta), scope: where.scope, source: where.source, engine: where.engine, file: where.file, content: body.replace(/^\r?\n/, ''), mtime: st.mtimeMs, support, exists: true };
  } catch (err) {
    if (err instanceof SkillError) throw err;
    if (err.code === 'ENOENT') return { id, name: id, description: '', scope: where.scope, source: where.source, engine: where.engine, file: where.file, content: '', mtime: 0, support, exists: false };
    throw err;
  }
}

// ---------- backups (in the app's data folder, never next to the skill) ----------

export const skillBackupRoot = (dataDir) => {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('dataDir is required for skill backups');
  return p(dataDir, 'skills-backups');
};

const SAFE_FOLDER = /^(?=.*[a-zA-Z0-9])[a-zA-Z0-9._-]{1,64}$/;
const folderId = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return SAFE_FOLDER.test(raw) && raw !== 'global' ? raw : `x${randomBytes(8).toString('hex')}`;
};

// How many backups of one skill folder are kept (oldest are pruned as new ones arrive).
const MAX_BACKUPS = 20;

const pruneBackups = (dir) => {
  try {
    const names = readdirSync(dir).filter((f) => f.includes('--')).sort();
    for (const name of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) rmSync(p(dir, name), { force: true });
  } catch {
    // pruning is best effort: never fail a save because an old copy could not be removed
  }
};

/**
 * Copies one file into the app's backup folder (never next to the skill). A symlink is skipped (its target could be a
 * secret elsewhere on the laptop) and a file over MAX_SKILL_BYTES is not copied whole. Returns whether a copy was made.
 */
const backupOne = (file, { dataDir, projectPath, scope }) => {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_SKILL_BYTES) return false;
  const root = path.resolve(skillBackupRoot(dataDir));
  const folder = scope === 'user' ? 'global' : (folderId(path.basename(projectPath ?? '')) ?? 'project');
  const dir = path.resolve(root, folder);
  if (path.dirname(dir) !== root) throw new SkillError(409, 'Folder backup tidak aman.');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows: ACLs, not modes
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
  const base = path.basename(file);
  let name = `${stamp}--${randomBytes(2).toString('hex').slice(0, 3)}--${base}`;
  for (let i = 0; i < 4 && existsSync(p(dir, name)); i++) name = `${stamp}--${randomBytes(2).toString('hex').slice(0, 3)}--${base}`;
  writeFileSync(p(dir, name), readFileSync(file), { mode: 0o600 });
  pruneBackups(dir);
  return true;
};

/** Backs up every file of an old skill folder before a rename removes it, so nothing is lost. */
const backupDir = (dir, opts) => {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  let any = false;
  for (const name of names) any = backupOne(p(dir, name), opts) || any;
  return any;
};

// ---------- write / delete ----------

function writeAtomic(file, data) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // new file: 0600
  }
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    try {
      chmodSync(tmp, mode);
    } catch {
      // Windows: ACLs, not modes
    }
    try {
      renameSync(tmp, file);
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      rmSync(file, { force: true }); // Windows will not replace a file another process holds open
      renameSync(tmp, file);
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Creates or replaces <root>/<id>/SKILL.md. `baseMtime` is the mtime the editor loaded (0 = file did not exist): a
 * file changed meanwhile (Claude, OpenCode or a hand edit) is refused with 409 instead of being overwritten. A rename
 * (`previous` different from `id`) writes the new directory, backs up the old SKILL.md, then removes the old directory.
 */
export function saveSkill({ engine, projectPath, home, scope, source, id, previous = null, previousScope, previousSource, name, description, content, dataDir, baseMtime }) {
  const where = skillDir({ engine, projectPath, home, scope, source, id });
  if (!oneLine(description)) throw new SkillError(400, 'Deskripsi wajib: model memakainya untuk memilih kapan skill ini dipakai.');
  if (typeof content !== 'string') throw new SkillError(400, 'Isi skill harus teks.');
  if (previous && !validSkillId(previous)) throw new SkillError(400, 'Nama skill sebelumnya tidak valid.');
  // A rename may also move the skill to another root (project ↔ user): the old file lives under its own scope/source.
  // The old directory is removed when the name or the root changes.
  const oldScope = previousScope ?? scope;
  const oldSource = previousSource ?? source;
  const movesRoot = previousScope !== undefined && (oldScope !== scope || oldSource !== source);
  const renaming = Boolean(previous) && (previous !== id || movesRoot);
  const old = renaming ? skillDir({ engine, projectPath, home, scope: oldScope, source: oldSource, id: previous }) : null;
  guardContainment(where, old);
  // The mtime guard follows the file the editor loaded: the old one when renaming, this one otherwise.
  const guard = old ?? where;
  let current = 0;
  let priorMeta = {};
  try {
    const st = lstatSync(guard.file);
    if (st.isSymbolicLink()) throw new SkillError(409, 'SKILL.md adalah symlink; buka file aslinya di editor.');
    if (!st.isFile()) throw new SkillError(409, 'SKILL.md bukan file biasa.');
    current = st.mtimeMs;
    priorMeta = parseSkillFrontmatter(readFileSync(guard.file, 'utf8')).meta; // keep unknown keys (license, allowed-tools, …)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (Math.abs(current - (Number(baseMtime) || 0)) > 1) throw new SkillError(409, 'SKILL.md sudah berubah sejak dibuka (diedit di tempat lain). Muat ulang dulu.');
  // A rename that also moves roots must not silently overwrite a different skill that already uses the target name.
  if (old && path.resolve(old.file) !== path.resolve(where.file) && existsSync(where.file)) throw new SkillError(409, `Skill "${id}" sudah ada di lokasi tujuan. Pilih nama lain atau hapus dulu.`);
  // Size is checked on the final file (front matter included), so a saved skill can always be reopened.
  const text = skillText(frontmatterKeys(priorMeta), { id, name, description }, content);
  if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw new SkillError(413, 'Isi skill terlalu besar (maks 256 KB, termasuk nama dan deskripsi).');
  // A rename backs up the whole old folder (SKILL.md + support files) before removing it; a plain save backs up the
  // file it replaces.
  const backedUp = old
    ? (backupDir(old.dir, { dataDir, projectPath, scope: old.scope }) || backupOne(guard.file, { dataDir, projectPath, scope: old.scope }))
    : backupOne(guard.file, { dataDir, projectPath, scope });
  writeAtomic(where.file, text);
  if (old) rmSync(old.dir, { recursive: true, force: true });
  return { id, scope: where.scope, source: where.source, backedUp };
}

/** Deletes <root>/<id>/ entirely (SKILL.md + support files), backing up the SKILL.md first. */
export function deleteSkill({ engine, projectPath, home, scope, source, id, dataDir }) {
  const where = skillDir({ engine, projectPath, home, scope, source, id });
  guardContainment(where);
  const backedUp = backupOne(where.file, { dataDir, projectPath, scope });
  rmSync(where.dir, { recursive: true, force: true });
  return { ok: true, backedUp };
}
