// 🔐 The WhatsApp session (baileys credentials + Signal keys) on disk, sealed with AES-256-GCM.
//
// The session IS a WhatsApp login: whoever holds it can send and read messages as the owner. It is therefore never
// written in plaintext. One key per data folder (`key`, 32 random bytes, owner-only) encrypts one blob
// (`session.bin`) laid out as iv(12) | tag(16) | ciphertext. Neither the key nor the plaintext leaves the machine,
// and nothing here is ever logged.
//
// Why one file instead of baileys' per-category files: the state is small and one atomic write (`.tmp` + rename)
// makes "the session on disk is either the old one or the new one, never half of each" free. A failed GCM tag
// (flipped byte, wrong key) is an error, never a silent reset — a still-repairable session must not be replaced by
// a fresh one just because a read failed. `wipe()` is the only way to start over, and it is called from "lepas tautan".
import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

export const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_FILE = 'key';
const SESSION_FILE = 'session.bin';
const TAMPERED_MESSAGE = 'Sesi WhatsApp tidak bisa dibaca: file sesi rusak atau diubah. Lepas tautan lalu pindai QR lagi.';
const KEY_LOST_MESSAGE = 'Kunci sesi WhatsApp hilang atau berubah, jadi sesi lama tidak bisa dibuka. Lepas tautan lalu pindai QR lagi.';

export class WaAuthStoreError extends Error {
  /**
   * @param {'tampered'|'unreadable'} code
   * @param {string} message Indonesian text safe to show in the UI
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'WaAuthStoreError';
    this.code = code;
  }
}

export class EncryptedAuthStore {
  #dir;
  #readFile;
  #writeFile;
  #rm;
  #randomBytes;
  #key = null;
  #writing = Promise.resolve();
  #wiped = false;

  /**
   * @param {object} options
   * @param {string} options.dir folder holding `key` and `session.bin` (e.g. `<dataDir>/wa`)
   * @param {(file: string) => Buffer} [options.readFile] sync, injected for tests
   * @param {(file: string, data: Buffer, options?: object) => void} [options.writeFile] sync, injected for tests
   * @param {(dir: string) => void} [options.rm] removes the whole session folder
   * @param {(size: number) => Buffer} [options.randomBytes]
   */
  constructor({
    dir,
    readFile = readFileSync,
    writeFile = writeFileSync,
    rm = (target) => rmSync(target, { recursive: true, force: true }),
    randomBytes = nodeRandomBytes,
  } = {}) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new WaAuthStoreError('unreadable', 'Folder sesi WhatsApp belum diatur.');
    }
    this.#dir = path.resolve(dir);
    this.#readFile = readFile;
    this.#writeFile = writeFile;
    this.#rm = rm;
    this.#randomBytes = randomBytes;
  }

  get dir() {
    return this.#dir;
  }

  /**
   * Reads the sealed session (or starts a fresh one), and hands back baileys' `{ state, saveCreds }` shape.
   * `keys` is a single in-memory Signal key store: every category lives in one encrypted file, written on
   * `saveCreds` (and after each `keys.set`, because a ratchet update must survive a crash).
   * @returns {Promise<{ state: { creds: object, keys: { get: Function, set: Function } }, saveCreds: () => Promise<void> }>}
   * @throws {WaAuthStoreError} `tampered` when the file fails the GCM tag or the key has the wrong size
   */
  async load() {
    // A save still in the queue is the newest state on disk; a reconnect must read it, not the previous one.
    await this.#writing.catch(() => {});
    this.#wiped = false;
    const key = this.#keyOf();
    const saved = this.#readSession(key);
    const creds = saved?.creds ?? initAuthCreds();
    const data = saved?.keys ?? {};

    const saveCreds = async () => {
      await this.#write(creds, data);
    };

    const keys = {
      /**
       * @param {string} type signal key category (`session`, `pre-key`, `app-state-sync-key`, …)
       * @param {string[]} ids
       */
      get: async (type, ids) => {
        const found = {};
        for (const id of ids) {
          let value = data[type]?.[id];
          if (value === undefined || value === null) continue;
          // baileys' own file store does the same: the app-state key is a protobuf message, not a plain object.
          if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value);
          found[id] = value;
        }
        return found;
      },
      /** @param {Record<string, Record<string, unknown|null>>} update a null value deletes the key */
      set: async (update) => {
        for (const [type, entries] of Object.entries(update ?? {})) {
          const bucket = (data[type] ??= {});
          for (const [id, value] of Object.entries(entries ?? {})) {
            if (value === undefined || value === null) delete bucket[id];
            else bucket[id] = value;
          }
          if (Object.keys(bucket).length === 0) delete data[type];
        }
        await saveCreds();
      },
    };

    return { state: { creds, keys }, saveCreds };
  }

  /** Removes the key and the session: the next `load()` starts from `initAuthCreds()`. Used by "lepas tautan". */
  async wipe() {
    // The flag goes up first: a saveCreds already queued (or called while this awaits) must not resurrect the session.
    this.#wiped = true;
    await this.#writing.catch(() => {});
    this.#key = null;
    this.#writing = Promise.resolve();
    this.#rm(this.#dir);
  }

  /** The 32-byte AES key, created on first use with owner-only permissions. */
  #keyOf() {
    if (this.#key) return this.#key;
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.#dir, KEY_FILE);
    let existing;
    try {
      existing = Buffer.from(this.#readFile(file));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw new WaAuthStoreError('unreadable', 'Kunci sesi WhatsApp tidak bisa dibaca.', { cause: err });
    }
    if (existing) {
      if (existing.length === KEY_LEN) {
        this.#key = existing;
        return existing;
      }
      throw new WaAuthStoreError('tampered', 'Kunci sesi WhatsApp rusak. Lepas tautan lalu pindai QR lagi.');
    }
    // A sealed session without its key can never be opened. Minting a new key here would hide the real cause
    // (a lost/restored key file) behind "the session file is broken", so say what is actually missing.
    if (this.#hasSession()) throw new WaAuthStoreError('tampered', KEY_LOST_MESSAGE);
    const fresh = Buffer.from(this.#randomBytes(KEY_LEN));
    if (fresh.length !== KEY_LEN) throw new WaAuthStoreError('tampered', 'Kunci sesi WhatsApp gagal dibuat.');
    const tmp = path.join(this.#dir, `${KEY_FILE}.tmp`);
    try {
      this.#writeFile(tmp, fresh, { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      throw new WaAuthStoreError('unreadable', 'Kunci sesi WhatsApp tidak bisa disimpan. Periksa izin folder data.', { cause: err });
    }
    this.#key = fresh;
    return fresh;
  }

  /** True when a sealed session exists (an unreadable file counts: it is still a session that must not be replaced). */
  #hasSession() {
    try {
      this.#readFile(path.join(this.#dir, SESSION_FILE));
      return true;
    } catch (err) {
      return err?.code !== 'ENOENT';
    }
  }

  /** Decrypts `session.bin`; a missing file is a fresh session, a broken one is an error. */
  #readSession(key) {
    const file = path.join(this.#dir, SESSION_FILE);
    let payload;
    try {
      payload = Buffer.from(this.#readFile(file));
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw new WaAuthStoreError('unreadable', 'Sesi WhatsApp tidak bisa dibaca. Lepas tautan lalu pindai QR lagi.', { cause: err });
    }
    if (payload.length <= IV_LEN + TAG_LEN) throw new WaAuthStoreError('tampered', TAMPERED_MESSAGE);
    let json;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, IV_LEN));
      decipher.setAuthTag(payload.subarray(IV_LEN, IV_LEN + TAG_LEN));
      json = Buffer.concat([decipher.update(payload.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8');
    } catch (err) {
      throw new WaAuthStoreError('tampered', TAMPERED_MESSAGE, { cause: err });
    }
    try {
      const parsed = JSON.parse(json, BufferJSON.reviver);
      if (!parsed || typeof parsed !== 'object' || !parsed.creds) throw new Error('missing creds');
      return { creds: parsed.creds, keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {} };
    } catch (err) {
      throw new WaAuthStoreError('tampered', TAMPERED_MESSAGE, { cause: err });
    }
  }

  /**
   * Seals the whole state and swaps it in atomically. Writes are queued: two baileys handlers may call `saveCreds`
   * in the same tick, and neither may interleave with the other's `.tmp` file.
   * @param {object} creds
   * @param {Record<string, Record<string, unknown>>} data
   */
  #write(creds, data) {
    // A save that was already in baileys' hands when the owner unlinked must not recreate the session it just deleted.
    if (this.#wiped) return Promise.resolve();
    const json = JSON.stringify({ creds, keys: data }, BufferJSON.replacer);
    const payload = this.#seal(Buffer.from(json, 'utf8'));
    const write = async () => {
      // Re-checked at execution time: wipe() may have run while this write was queued.
      if (this.#wiped) return;
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      const tmp = path.join(this.#dir, `${SESSION_FILE}.tmp`);
      try {
        this.#writeFile(tmp, payload, { mode: 0o600 });
        renameSync(tmp, path.join(this.#dir, SESSION_FILE));
      } catch (err) {
        throw new WaAuthStoreError('unreadable', 'Sesi WhatsApp tidak bisa disimpan. Periksa ruang disk dan izin folder data.', { cause: err });
      }
    };
    const next = this.#writing.then(write, write);
    this.#writing = next.then(() => {}, () => {});
    return next;
  }

  /** iv(12) | tag(16) | ciphertext, the layout documented at the top and expected by #readSession. */
  #seal(plaintext) {
    const iv = Buffer.from(this.#randomBytes(IV_LEN));
    const cipher = createCipheriv('aes-256-gcm', this.#keyOf(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }
}
