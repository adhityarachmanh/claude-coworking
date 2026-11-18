// Persisted handoff briefs: the context note an engine switch carries (src/handoff.js) survives a server restart
// and can be re-used from 🕘 Riwayat. One small JSON file per project, consumed once — when the new engine's
// session attaches it — so a note is never sent twice. Pure file I/O, no model call, no git.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const MAX_NOTE = 20_000;
const MAX_LIST = 20;

const cleanId = (v) => (typeof v === 'string' && /^[a-z0-9][\w.-]{0,63}$/i.test(v) ? v : null);
const cleanText = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const cleanList = (v) => (Array.isArray(v) ? v.map((x) => cleanText(x, 300)).filter(Boolean).slice(0, MAX_LIST) : []);

/** A stored entry with every field validated; null when the file is not a brief this app wrote. */
function normalize(raw, projectId) {
  if (!raw || typeof raw !== 'object' || raw.version !== VERSION) return null;
  const from = cleanId(raw.from);
  const to = cleanId(raw.to);
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE) : '';
  if (!from || !to || !note) return null;
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  const count = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 10_000) : 0);
  return {
    version: VERSION,
    projectId,
    from,
    to,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    reason: raw.reason === 'resume' ? 'resume' : 'switch',
    note,
    stats: {
      messages: count(stats.messages),
      files: count(stats.files),
      commands: count(stats.commands),
      todos: count(stats.todos),
    },
    brief: {
      files: cleanList(raw.brief?.files),
      commands: cleanList(raw.brief?.commands),
      todos: cleanList(raw.brief?.todos),
    },
  };
}

/**
 * `data/handoff/<projectId>.json`: one brief per project, overwritten by a newer switch and removed once used.
 * All errors degrade to "no brief": a handoff is a convenience, never a reason to fail a request.
 */
export class HandoffStore {
  constructor(dir) {
    this.dir = dir;
  }

  file(projectId) {
    const id = cleanId(projectId);
    return id ? path.join(this.dir, `${id}.json`) : null;
  }

  /** The stored brief for a project, or null (missing/corrupt/foreign file: never thrown to the caller). */
  read(projectId) {
    const file = this.file(projectId);
    if (!file || !existsSync(file)) return null;
    try {
      return normalize(JSON.parse(readFileSync(file, 'utf8')), projectId);
    } catch {
      return null;
    }
  }

  /** Writes `entry` for the project (atomic: a half-written file is never read). Returns the stored entry or null. */
  write(projectId, entry) {
    const file = this.file(projectId);
    const data = normalize({ ...entry, version: VERSION, createdAt: entry?.createdAt ?? Date.now() }, projectId);
    if (!file || !data) return null;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
      return data;
    } catch (err) {
      console.error(`Brief handoff ${projectId} tidak bisa disimpan: ${err.message}`);
      return null;
    }
  }

  /** Reads and removes the brief: the session that attaches it is the one that consumes it. */
  take(projectId) {
    const entry = this.read(projectId);
    if (entry) this.clear(projectId);
    return entry;
  }

  clear(projectId) {
    const file = this.file(projectId);
    if (!file) return;
    try {
      rmSync(file, { force: true });
    } catch {
      // A stale brief is recomputed on the next switch; never fail the request for it.
    }
  }
}
