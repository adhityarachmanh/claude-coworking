// The encrypted WhatsApp session store (src/wa-auth-store.js). No network: the tests pin down what actually lands
// on disk — the session is sealed with AES-256-GCM, the key file is private, load() restores the state (Buffers
// included), and a tampered file stops the app instead of silently starting a new session over a repairable one.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EncryptedAuthStore } from '../src/wa-auth-store.js';

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'adhitron-wa-'));
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

test('saves the session encrypted: no plaintext on disk', async () => {
  const dir = tempDir();
  try {
    const store = new EncryptedAuthStore({ dir });
    const { state, saveCreds } = await store.load();
    state.creds.me = { id: '628111@s.whatsapp.net', name: 'Adhit' };
    await state.keys.set({ session: { '628111@s.whatsapp.net': { private: Buffer.from([1, 2, 3, 4]) } } });
    await saveCreds();

    const sessionFile = path.join(dir, 'session.bin');
    const raw = readFileSync(sessionFile);
    assert.ok(!raw.includes('628111'), 'the WhatsApp number may never appear in the session file');
    assert.ok(!raw.includes('Adhit'), 'nor the profile name');
    assert.ok(!raw.includes('s.whatsapp.net'), 'nor any JID from the key store');

    const keyFile = path.join(dir, 'key');
    assert.equal(readFileSync(keyFile).length, 32, 'the AES key is 32 bytes');
    if (process.platform !== 'win32') {
      assert.equal(statSync(keyFile).mode & 0o777, 0o600, 'only the owner may read the key');
    }

    const reloaded = await new EncryptedAuthStore({ dir }).load();
    assert.equal(reloaded.state.creds.me.id, '628111@s.whatsapp.net');
    assert.equal(reloaded.state.creds.me.name, 'Adhit');
    assert.ok(Buffer.isBuffer(reloaded.state.creds.noiseKey.private), 'BufferJSON restores the Buffer fields');
    const keys = await reloaded.state.keys.get('session', ['628111@s.whatsapp.net']);
    assert.deepEqual(keys['628111@s.whatsapp.net'].private, Buffer.from([1, 2, 3, 4]));
  } finally {
    cleanup(dir);
  }
});

test('wipe removes every file', async () => {
  const dir = tempDir();
  try {
    const store = new EncryptedAuthStore({ dir });
    const { saveCreds } = await store.load();
    await saveCreds();
    assert.ok(existsSync(path.join(dir, 'session.bin')));
    assert.ok(existsSync(path.join(dir, 'key')));

    await store.wipe();
    assert.equal(existsSync(dir), false, 'the whole session folder is gone');
  } finally {
    cleanup(dir);
  }
});

test('a save queued before wipe() cannot resurrect the session', async () => {
  const dir = tempDir();
  try {
    const store = new EncryptedAuthStore({ dir });
    const { saveCreds } = await store.load();
    await saveCreds();

    const wiping = store.wipe();
    const late = saveCreds(); // a save already in baileys' hands when the owner pressed "lepas tautan"
    await Promise.all([wiping, late]);
    await saveCreds(); // and one after the wipe finished: still nothing to save

    assert.equal(existsSync(dir), false, 'the wiped session stays gone');
  } finally {
    cleanup(dir);
  }
});

test('load() waits for a save already in the queue', async () => {
  const dir = tempDir();
  try {
    const store = new EncryptedAuthStore({ dir });
    const first = await store.load();
    first.state.creds.me = { id: '628111@s.whatsapp.net' };
    const pending = first.saveCreds(); // queued, not yet flushed when load() starts

    const reread = await store.load();
    assert.equal(reread.state.creds.me?.id, '628111@s.whatsapp.net', 'a reconnect reads the newest state, not the previous one');
    await pending;
  } finally {
    cleanup(dir);
  }
});

test('a missing key file is reported as a lost key, not a broken session', async () => {
  const dir = tempDir();
  try {
    const store = new EncryptedAuthStore({ dir });
    const { state, saveCreds } = await store.load();
    state.creds.me = { id: '628111@s.whatsapp.net' };
    await saveCreds();
    rmSync(path.join(dir, 'key'));

    await assert.rejects(
      () => new EncryptedAuthStore({ dir }).load(),
      (err) => /Kunci sesi WhatsApp/i.test(err.message) && !/file sesi/i.test(err.message),
    );
    assert.equal(existsSync(path.join(dir, 'key')), false, 'no new key is minted over a session that still exists');
  } finally {
    cleanup(dir);
  }
});

test('a tampered file is refused, not silently reset', async () => {
  const dir = tempDir();
  try {
    const store = new EncryptedAuthStore({ dir });
    const { state, saveCreds } = await store.load();
    state.creds.me = { id: '628111@s.whatsapp.net' };
    await saveCreds();

    const sessionFile = path.join(dir, 'session.bin');
    const original = readFileSync(sessionFile);
    // iv(12) | tag(16) | ciphertext: flipping a ciphertext byte must fail the GCM tag.
    const tampered = Buffer.from(original);
    tampered[12 + 16 + Math.floor((tampered.length - 28) / 2)] ^= 0xff;
    writeFileSync(sessionFile, tampered);
    const keyBefore = readFileSync(path.join(dir, 'key'));

    await assert.rejects(
      () => new EncryptedAuthStore({ dir }).load(),
      (err) => /Sesi WhatsApp/i.test(err.message) && /rusak|diubah/i.test(err.message),
    );
    // The broken session is left for support instead of being overwritten by a fresh one.
    assert.deepEqual(readFileSync(sessionFile), tampered);
    assert.deepEqual(readFileSync(path.join(dir, 'key')), keyBefore);
  } finally {
    cleanup(dir);
  }
});
