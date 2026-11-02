// Chat history on disk: one JSONL file per project, data/chats/<projectId>.jsonl (design notes in src/hub.js).
//
// Record kinds, one JSON object per line:
//   {"id":"m12",…}                 a message (a second line with the same id replaces it in place)
//   {"_patch":"m12","text":…}      fields changed after the message was written; "_unset": [keys] removes keys
// Replaying the lines in order gives the chat; the last `limit` messages are kept. A line that does not parse
// (torn by a crash mid-append, hand-edited) is skipped, and the file is then rewritten clean before the next
// append so new records never get glued onto a broken line.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Messages kept per project (in memory, in its file after a compaction, in a backup). */
export const CHAT_LIMIT = 250;
// Project ids used as file names (sha1 prefixes in the app, short names in tests). No dot, so '<id>.jsonl'
// has one extension; Windows device names (con, nul, com1…) are refused (they are devices even with one).
const CHAT_FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|(com|lpt)[0-9¹²³])$/i;
/** Whether `id` can name a chat file (data/chats/<id>.jsonl, office/chats/<id>.jsonl in a backup). */
export const isChatId = (id) => typeof id === 'string' && CHAT_FILE_ID.test(id) && !WINDOWS_DEVICE.test(id);
// A file is compacted long before this; a bigger one (hand-made, foreign) is only read from its tail.
const MAX_READ_BYTES = 16 * 1024 * 1024;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Replays JSONL chat records.
 * @param {string} text
 * @param {number} limit  messages kept (the newest)
 * @returns {{ messages: object[], lines: number, bad: number }}  lines: records read; bad: lines skipped
 */
export function replayChat(text, limit = Infinity) {
  const byId = new Map(); // insertion order = chat order; set() of an existing id keeps its place
  let lines = 0;
  let bad = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    if (!isObject(rec)) {
      bad++;
      continue;
    }
    lines++;
    if (typeof rec._patch === 'string') {
      const target = byId.get(rec._patch);
      if (!target) continue; // its message was before the tail we read, or never written
      const { _patch, _unset, ...fields } = rec;
      Object.assign(target, fields);
      if (Array.isArray(_unset)) for (const k of _unset) if (typeof k === 'string') delete target[k];
    } else if (typeof rec.id === 'string') {
      byId.set(rec.id, rec);
    } else {
      bad++;
    }
  }
  const messages = [...byId.values()];
  return { messages: messages.length > limit ? messages.slice(-limit) : messages, lines, bad };
}

export class ChatStore {
  /**
   * @param {string} dir  data/chats
   * @param {{ limit?: number, compactAt?: number, maxReadBytes?: number }} [options]
   *   limit: messages kept per project; compactAt: records in a file before it is rewritten with just the chat
   */
  constructor(dir, { limit = CHAT_LIMIT, compactAt = limit * 2, maxReadBytes = MAX_READ_BYTES } = {}) {
    this.dir = dir;
    this.limit = limit;
    this.compactAt = compactAt;
    this.maxReadBytes = maxReadBytes;
    this.lines = new Map(); // project id -> records in its file now
    this.pending = new Map(); // project id -> { appends: Map<msgId, msg>, patches: Map<msgId, object> }
    this.rewrites = new Set(); // project ids whose file is rewritten whole at the next flush
    // Project ids whose file exists but could not be read (antivirus/backup tool holding it: EBUSY, EPERM…).
    // Their chat in memory is incomplete, so their file is never rewritten (no compaction, no import, no
    // relabel): only appended to, until a later read succeeds (Hub.save retries, see reload()).
    this.unreadable = new Set();
  }

  file(id) {
    if (!isChatId(id)) throw new Error(`invalid chat file id: ${id}`);
    return path.join(this.dir, `${id}.jsonl`);
  }

  /** Project ids that have a chat file. */
  list() {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.slice(0, -'.jsonl'.length))
        .filter(isChatId);
    } catch {
      return [];
    }
  }

  /**
   * Reads a project's file without changing anything. A missing file is an empty chat; any other error throws
   * (an unreadable file must never pass for an empty one: a rewrite would then erase it).
   * @returns {{ messages: object[], lines: number, clean: boolean }}  clean: every line parsed and the file
   *   ends with a newline (safe to append to)
   */
  read(id) {
    let fd;
    try {
      fd = openSync(this.file(id), 'r');
    } catch (err) {
      if (err?.code === 'ENOENT') return { messages: [], lines: 0, clean: true };
      throw err;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw Object.assign(new Error('bukan file biasa'), { code: 'EISDIR' });
      const size = st.size;
      const start = Math.max(0, size - this.maxReadBytes);
      const buf = Buffer.alloc(size - start);
      let off = 0;
      while (off < buf.length) {
        const n = readSync(fd, buf, off, buf.length - off, start + off);
        if (!n) break;
        off += n;
      }
      let text = buf.subarray(0, off).toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1); // the first line was cut by the tail read
      const { messages, lines, bad } = replayChat(text, this.limit);
      return { messages, lines, clean: start === 0 && bad === 0 && (off === 0 || buf[off - 1] === 0x0a) };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Reads a project's chat at start; a file that is not clean is rewritten at the next flush. A file that
   * can't be read is marked unreadable (logged) and gives an empty chat for now.
   */
  load(id) {
    try {
      const { messages, lines, clean } = this.read(id);
      this.unreadable.delete(id);
      this.lines.set(id, lines);
      if (!clean) this.rewrites.add(id);
      return messages;
    } catch (err) {
      if (!this.unreadable.has(id)) console.error(`Riwayat chat ${id} tidak bisa dibaca (${err.code ?? err.message}); file dibiarkan, dicoba lagi nanti.`);
      this.unreadable.add(id);
      this.rewrites.delete(id);
      return [];
    }
  }

  /** Tries an unreadable file again. @returns {object[]|null} its chat now, or null while still unreadable */
  reload(id) {
    if (!this.unreadable.has(id)) return null;
    const messages = this.load(id);
    return this.unreadable.has(id) ? null : messages;
  }

  #queue(id) {
    let q = this.pending.get(id);
    if (!q) this.pending.set(id, (q = { appends: new Map(), patches: new Map() }));
    return q;
  }

  /** A new message (serialized at the flush, so changes until then ride along). */
  append(id, message) {
    this.#queue(id).appends.set(message.id, message);
  }

  /** Fields changed on a message. */
  patch(id, msgId, fields) {
    const q = this.#queue(id);
    if (q.appends.has(msgId)) return; // not written yet: the append carries the change
    q.patches.set(msgId, { ...q.patches.get(msgId), ...fields });
  }

  /** The whole file is rewritten from the project's current chat at the next flush (never an unreadable one). */
  rewrite(id) {
    if (!this.unreadable.has(id)) this.rewrites.add(id);
  }

  /** Drops what is pending (the hub writes chats into state.json instead: a migration that failed). */
  discardPending() {
    this.pending.clear();
    this.rewrites.clear();
  }

  get dirty() {
    return this.pending.size > 0 || this.rewrites.size > 0;
  }

  /**
   * Writes what is pending: appends (one write per project) or, when the file would pass `compactAt`
   * records (or was marked for a rewrite), the current chat whole (tmp + rename). A project whose write
   * fails keeps its pending records (retried with the next flush) and its file is rewritten then, so a
   * partly written append never has new lines glued onto it; the other projects are still written.
   * @param {(id: string) => object[]} chatOf  a project's chat in memory now
   * @throws {Error} after trying every project, when one of them failed
   */
  flush(chatOf) {
    const ids = new Set([...this.pending.keys(), ...this.rewrites]);
    if (!ids.size) return;
    const failed = [];
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      throw new Error(`folder ${this.dir}: ${err.message}`);
    }
    for (const id of ids) {
      try {
        this.#flushOne(id, chatOf);
        this.pending.delete(id);
        this.rewrites.delete(id);
      } catch (err) {
        if (!this.unreadable.has(id)) this.rewrites.add(id);
        failed.push(`${id}: ${err.code ?? err.message}`);
      }
    }
    if (failed.length) throw new Error(failed.join('; '));
  }

  #flushOne(id, chatOf) {
    const q = this.pending.get(id);
    const records = [];
    if (q) {
      for (const m of q.appends.values()) records.push(JSON.stringify(m));
      for (const [msgId, fields] of q.patches) {
        const set = {};
        const unset = [];
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined) unset.push(k);
          else set[k] = v;
        }
        records.push(JSON.stringify({ _patch: msgId, ...set, ...(unset.length && { _unset: unset }) }));
      }
    }
    const whole = !this.unreadable.has(id) && (this.rewrites.has(id) || (this.lines.get(id) ?? 0) + records.length > this.compactAt);
    if (whole) {
      this.writeAll(id, chatOf(id));
    } else if (records.length) {
      // Retrying a failed append is safe: a repeated message line replaces itself, a repeated patch sets the same fields.
      appendFileSync(this.file(id), `${records.join('\n')}\n`);
      this.lines.set(id, (this.lines.get(id) ?? 0) + records.length);
    }
  }

  /** Replaces a project's file with `messages` (atomic: tmp + rename). An empty chat removes the file. */
  writeAll(id, messages) {
    if (this.unreadable.has(id)) throw new Error(`chat ${id} tidak terbaca: tidak ditulis ulang`);
    const file = this.file(id);
    const list = messages.slice(-this.limit);
    if (!list.length) {
      this.remove(id);
      return;
    }
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${list.map((m) => JSON.stringify(m)).join('\n')}\n`);
    renameSync(tmp, file);
    this.lines.set(id, list.length);
  }

  /** Forgets a project's chat: its file and anything pending. */
  remove(id) {
    this.pending.delete(id);
    this.rewrites.delete(id);
    this.lines.delete(id);
    this.unreadable.delete(id);
    rmSync(this.file(id), { force: true });
  }
}

/** Reads a chat file's text the same way as from disk (backup import). */
export function parseChatFile(buf, limit) {
  return replayChat(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf), limit).messages;
}

