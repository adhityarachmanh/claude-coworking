// 🧩 Skills (SKILL.md): the instruction files each engine loads when relevant, managed from the app (no terminal).
// Pure rules + file operations only. Claude Code reads .claude/skills (project) and ~/.claude/skills (user).
// OpenCode 2.3.2 reads project .opencode/skills, plus the compatibility roots project .claude/skills and
// project .agents/skills, and the user roots ~/.config/opencode/skills, ~/.claude/skills and ~/.agents/skills.
// Precedence rises with the order returned by skillRoots (a later root wins). The skill id is the directory name,
// never the front matter `name` (OpenCode derives it from the path, case-sensitive). Adding a skill only adds
// instructions: it never grants a permission. Reads/writes touch only these fixed roots; a symlink at a SKILL.md is
// refused. Backups of overwritten files live in the app's data folder, never next to the skill.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_SKILL_BYTES = 256 * 1024;
export const SKILL_FILE = 'SKILL.md';

export class SkillError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const validSkillId = (id) => SKILL_ID.test(String(id ?? ''));

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
  return { ...root, dir, file: p(dir, SKILL_FILE) };
}

const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

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
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = p(root.dir, entry.name, SKILL_FILE);
      if (!existsSync(file)) continue;
      const key = `${root.scope}:${entry.name}`;
      if (seen.has(key)) continue; // a project .claude/skills skill is not listed twice across compat roots
      seen.add(key);
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

/** One skill with its content; a missing SKILL.md is empty (created on save). */
export function readSkill({ engine, projectPath, home, scope, source, id }) {
  const where = skillDir({ engine, projectPath, home, scope, source, id });
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
    const { meta } = parseSkillFrontmatter(readFileSync(where.file, 'utf8'));
    return { id, name: meta.name || id, description: oneLine(meta.description), scope: where.scope, source: where.source, engine: where.engine, file: where.file, content: readFileSync(where.file, 'utf8'), mtime: st.mtimeMs, support, exists: true };
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

const SAFE_FOLDER = /^[a-zA-Z0-9._-]{1,64}$/;
const folderId = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return SAFE_FOLDER.test(raw) && raw !== 'global' ? raw : `x${randomBytes(8).toString('hex')}`;
};

const backupOne = (file, { dataDir, projectPath, scope }) => {
  if (!existsSync(file)) return false;
  const root = path.resolve(skillBackupRoot(dataDir));
  const folder = scope === 'user' ? 'global' : (folderId(path.basename(projectPath ?? '')) ?? 'project');
  const dir = path.resolve(root, folder);
  if (path.dirname(dir) !== root) throw new Error('backup folder outside the backup root');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows: ACLs, not modes
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
  let name = `${stamp}-${randomBytes(2).toString('hex').slice(0, 3)}-${SKILL_FILE}`;
  for (let i = 0; i < 4 && existsSync(p(dir, name)); i++) name = `${stamp}-${randomBytes(2).toString('hex').slice(0, 3)}-${SKILL_FILE}`;
  writeFileSync(p(dir, name), readFileSync(file), { mode: 0o600 });
  return true;
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
 * file changed meanwhile (Claude, OpenCode or a hand edit) is refused with 409 instead of being overwritten. The
 * previous SKILL.md is backed up first. A rename (`previous` different from `id`) removes the old directory.
 */
export function saveSkill({ engine, projectPath, home, scope, source, id, previous = null, name, description, content, dataDir, baseMtime }) {
  const where = skillDir({ engine, projectPath, home, scope, source, id });
  if (!oneLine(description)) throw new SkillError(400, 'Deskripsi wajib: model memakainya untuk memilih kapan skill ini dipakai.');
  if (typeof content !== 'string') throw new SkillError(400, 'Isi skill harus teks.');
  if (Buffer.byteLength(content) > MAX_SKILL_BYTES) throw new SkillError(413, 'Isi skill terlalu besar (maks 256 KB).');
  let current = 0;
  try {
    const st = lstatSync(where.file);
    if (st.isSymbolicLink()) throw new SkillError(409, 'SKILL.md adalah symlink; buka file aslinya di editor.');
    if (!st.isFile()) throw new SkillError(409, 'SKILL.md bukan file biasa.');
    current = st.mtimeMs;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (Math.abs(current - (Number(baseMtime) || 0)) > 1) throw new SkillError(409, 'SKILL.md sudah berubah sejak dibuka (diedit di tempat lain). Muat ulang dulu.');
  const backedUp = backupOne(where.file, { dataDir, projectPath, scope });
  const lines = ['---', `name: ${oneLine(name) || id}`, `description: ${oneLine(description)}`, '---', '', content.trimEnd(), ''];
  writeAtomic(where.file, lines.join('\n'));
  if (previous && previous !== id && validSkillId(previous)) {
    const old = skillDir({ engine, projectPath, home, scope, source, id: previous });
    rmSync(old.dir, { recursive: true, force: true });
  }
  return { id, scope: where.scope, source: where.source, backedUp };
}

/** Deletes <root>/<id>/ entirely (SKILL.md + support files), backing up the SKILL.md first. */
export function deleteSkill({ engine, projectPath, home, scope, source, id, dataDir }) {
  const where = skillDir({ engine, projectPath, home, scope, source, id });
  const backedUp = backupOne(where.file, { dataDir, projectPath, scope });
  rmSync(where.dir, { recursive: true, force: true });
  return { ok: true, backedUp };
}
