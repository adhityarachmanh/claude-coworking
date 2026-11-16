// The in-process WhatsApp link (src/wa-link.js). No network and no baileys socket: `socketFactory` hands out a stand-in
// that records what the link asks of it, and `ev.emit('connection.update', …)` plays the events baileys would emit.
// The tests pin down the /pair contract, that a second link() never opens a second socket, that a PIN message goes to
// the owner's own number, and that reconnect/unlink behave the way the settings page assumes.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EncryptedAuthStore, WaAuthStoreError } from '../src/wa-auth-store.js';
import { QR_TTL_MS, WaLink, WaLinkError, pairStatus } from '../src/wa-link.js';

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'adhitron-walink-'));
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded wait: a broken implementation fails the test, it never hangs the suite. */
async function waitFor(predicate, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(stepMs);
  }
  assert.fail('timed out waiting for the expected state');
}

/** A stand-in for a baileys socket: an event emitter plus the four calls the link makes. */
function fakeSocketFactory(log) {
  return (config) => {
    const handlers = new Map();
    const sock = {
      config,
      sends: [],
      loggedOut: false,
      ended: false,
      ev: {
        on(name, handler) {
          if (!handlers.has(name)) handlers.set(name, []);
          handlers.get(name).push(handler);
        },
      },
      emit(name, payload) {
        for (const handler of handlers.get(name) ?? []) handler(payload);
      },
      async sendMessage(jid, content) {
        sock.sends.push({ jid, content });
        return { key: { id: 'stub' } };
      },
      // baileys' pairing code (no QR): the link asks for the owner's number and shows what WhatsApp returned.
      pairingAsks: [],
      async requestPairingCode(number) {
        sock.pairingAsks.push(number);
        return 'ABCD-1234';
      },
      async logout() {
        sock.loggedOut = true;
      },
      end() {
        sock.ended = true;
      },
    };
    log.sockets.push(sock);
    return sock;
  };
}

const stubQr = async (qr) => `data:image/png;base64,${Buffer.from(qr).toString('base64')}`;

/**
 * A store stand-in for restore(): only `hasSession()` decides whether a session is left on disk, and `load()`
 * hands back credentials as if baileys had saved them before the server stopped.
 */
function storedSession(dir, { hasSession = true, loads } = {}) {
  return {
    dir,
    hasSession: () => hasSession,
    load: async () => {
      if (loads) loads.count += 1;
      return { state: { creds: { me: { id: '628111:3@s.whatsapp.net', name: 'Adhit' } }, keys: {} }, saveCreds: async () => {} };
    },
    wipe: async () => {},
  };
}

function harness({ dir, now, retryBaseMs = 5, logoutTimeoutMs, onChange, qrToDataUrl = stubQr, store, socketFactory } = {}) {
  const log = { sockets: [], statuses: [] };
  const sessionStore = store ?? new EncryptedAuthStore({ dir });
  const link = new WaLink({
    store: sessionStore,
    socketFactory: socketFactory ?? fakeSocketFactory(log),
    // `null` deliberately falls through to the real QRCode converter (T2).
    qrToDataUrl,
    now,
    retryBaseMs,
    ...(logoutTimeoutMs === undefined ? {} : { logoutTimeoutMs }),
    onChange: (status) => {
      log.statuses.push(status);
      onChange?.(status);
    },
  });
  return { link, log, store: sessionStore };
}

test('link() emits a QR and reports qr_ready', async () => {
  const dir = tempDir();
  try {
    let clock = 1_000_000;
    const h = harness({ dir, now: () => clock });
    const linking = h.link.link();
    await flush();
    assert.equal(h.log.sockets.length, 1, 'one socket is enough to show a QR');
    await linking;

    h.log.sockets[0].emit('connection.update', { qr: '2@s.whatsapp.net,QR-SECRET,abc' });
    await flush();
    const status = await h.link.status();
    assert.equal(status.state, 'qr');
    assert.match(status.qr, /^data:image\/png;base64,/, 'the QR is handed to the UI as an image');
    assert.equal(status.me, null);
    assert.deepEqual(pairStatus(status), { configured: true, status: 'qr_ready' });
    assert.ok(h.log.statuses.some((s) => s.state === 'qr' && s.qr), 'onChange saw the QR');

    // A QR is only worth scanning for a minute; the socket keeps rotating new ones.
    clock += QR_TTL_MS + 1;
    const stale = await h.link.status();
    assert.equal(stale.qr, null, 'an old QR is never shown again');
    assert.equal(stale.state, 'qr', 'the socket is still rotating QR codes');
    h.link.stop();
  } finally {
    cleanup(dir);
  }
});

test('a second link() does not open a second socket', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir });
    const [first, second] = await Promise.all([h.link.link(), h.link.link()]);
    assert.equal(h.log.sockets.length, 1);
    assert.equal(first.state, 'connecting');
    assert.equal(second.state, 'connecting');

    await h.link.link(); // after the socket exists: still the same one
    assert.equal(h.log.sockets.length, 1);
    h.link.stop();
  } finally {
    cleanup(dir);
  }
});

test('sendText goes to the linked account itself', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir });
    await h.link.link();
    // baileys fills creds.me when the login completes; the same creds object is what the link keeps.
    h.log.sockets[0].config.auth.creds.me = { id: '628111@s.whatsapp.net', name: 'Adhit' };
    h.log.sockets[0].emit('connection.update', { connection: 'open' });

    const status = await h.link.status();
    assert.equal(status.state, 'linked');
    assert.deepEqual(status.me, { number: '628111', name: 'Adhit' });
    assert.deepEqual(pairStatus(status), { configured: true, status: 'connected' });

    assert.deepEqual(await h.link.sendText('halo'), { ok: true });
    assert.deepEqual(h.log.sockets[0].sends, [{ jid: '628111@s.whatsapp.net', content: { text: 'halo' } }]);
    h.link.stop();
  } finally {
    cleanup(dir);
  }
});

test('sendText drops the device suffix from our own JID', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir });
    await h.link.link();
    // WhatsApp stores our own id WITH the device (`628111:12@s.whatsapp.net`). baileys relays that string as-is,
    // so the server accepted the message and the phone never showed it. The send must go to the user JID.
    h.log.sockets[0].config.auth.creds.me = { id: '628111:12@s.whatsapp.net', name: 'Adhit' };
    h.log.sockets[0].emit('connection.update', { connection: 'open' });
    assert.equal((await h.link.status()).state, 'linked');

    assert.deepEqual(await h.link.sendText('halo'), { ok: true });
    assert.deepEqual(h.log.sockets[0].sends, [{ jid: '628111@s.whatsapp.net', content: { text: 'halo' } }]);
    h.link.stop();
  } finally {
    cleanup(dir);
  }
});

test('sendText before linking throws not_linked', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir });
    await assert.rejects(
      () => h.link.sendText('halo'),
      (err) => err instanceof WaLinkError && err.code === 'not_linked' && /Tautkan|QR/i.test(err.message),
    );

    // A socket that is still showing a QR is not a linked account either.
    await h.link.link();
    await assert.rejects(() => h.link.sendText('halo'), (err) => err instanceof WaLinkError && err.code === 'not_linked');
    h.link.stop();
  } finally {
    cleanup(dir);
  }
});

test('a closed socket reconnects, loggedOut goes off', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir, retryBaseMs: 1 });
    await h.link.link();

    // A dropped connection (428) is retried with the same store.
    h.log.sockets[0].emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
    await waitFor(() => h.log.sockets.length === 2);
    assert.equal((await h.link.status()).state, 'connecting');
    assert.match(h.link.lastError, /Menyambung ulang/);

    // A fresh QR means the connection is alive again: the stale "reconnecting" error must not stay on screen.
    h.log.sockets[1].emit('connection.update', { qr: 'QR-2' });
    await flush();
    assert.equal(h.link.lastError, null);
    assert.equal((await h.link.status()).state, 'qr');

    // The phone unlinked this device (401): no retry, and the credentials on disk are useless.
    h.log.sockets[1].emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await waitFor(async () => (await h.link.status()).state === 'off');
    await waitFor(() => !existsSync(dir));
    await delay(30);
    assert.equal(h.log.sockets.length, 2, 'loggedOut never reconnects');
    assert.match(h.link.lastError, /Tautkan|ulang/i);
    assert.deepEqual(pairStatus(await h.link.status()), { configured: false, status: 'disconnected' });
  } finally {
    cleanup(dir);
  }
});

test('link() during a pending retry does not open another socket', async () => {
  const dir = tempDir();
  try {
    // A long delay keeps the retry pending for the whole test: this is the window the review found the bug in.
    const h = harness({ dir, retryBaseMs: 5_000 });
    await h.link.link();
    h.log.sockets[0].emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });

    const status = await h.link.link();
    assert.equal(status.state, 'connecting');
    assert.equal(h.log.sockets.length, 1, 'the scheduled retry is the attempt; link() must not open a second socket');
    h.link.stop();
  } finally {
    cleanup(dir);
  }
});

test('the default QR converter produces a real PNG data URL', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir, qrToDataUrl: null });
    await h.link.link();
    h.log.sockets[0].emit('connection.update', { qr: '2@s.whatsapp.net,QR-SECRET,abc' });

    await waitFor(async () => Boolean((await h.link.status()).qr));
    const status = await h.link.status();
    assert.match(status.qr, /^data:image\/png;base64,/, 'the real QRCode.toDataURL ran, not a stub');
    h.link.stop();
  } finally {
    cleanup(dir);
  }
});

test('a converter that returns nothing leaves qr null, never the string "null"', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir, qrToDataUrl: async () => null });
    await h.link.link();
    h.log.sockets[0].emit('connection.update', { qr: 'QR-EMPTY' });
    await flush();
    const status = await h.link.status();
    assert.equal(status.state, 'qr');
    assert.equal(status.qr, null);
    h.link.stop();
  } finally {
    cleanup(dir);
  }
});

test('an expired QR is published as null for event-only clients', async (t) => {
  const dir = tempDir();
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = 1_000_000;
    const h = harness({ dir, now: () => clock });
    await h.link.link();
    h.log.sockets[0].emit('connection.update', { qr: 'QR-1' });
    await flush();
    assert.ok(h.log.statuses.some((s) => s.state === 'qr' && s.qr));

    clock += QR_TTL_MS + 1;
    t.mock.timers.tick(QR_TTL_MS);

    const last = h.log.statuses.at(-1);
    assert.equal(last.state, 'qr');
    assert.equal(last.qr, null, 'the page drops the old image without having to poll');
    h.link.stop();
  } finally {
    t.mock.timers.reset();
    cleanup(dir);
  }
});

test('status() never throws when the store refuses or the socket cannot start', async () => {
  const dir = tempDir();
  try {
    const refusing = harness({
      dir,
      store: {
        load: async () => {
          throw new WaAuthStoreError('tampered', 'Sesi WhatsApp tidak bisa dibaca: file sesi rusak atau diubah. Lepas tautan lalu pindai QR lagi.');
        },
        wipe: async () => {},
      },
    });
    await assert.rejects(() => refusing.link.link(), /Sesi WhatsApp/);
    assert.deepEqual(await refusing.link.status(), { state: 'off', qr: null, me: null, since: null });
    assert.match(refusing.link.lastError, /Sesi WhatsApp/);

    const crashing = harness({
      dir,
      socketFactory: () => {
        throw new Error('boom');
      },
    });
    await assert.rejects(() => crashing.link.link(), /boom/);
    assert.equal((await crashing.link.status()).state, 'off');
    assert.match(crashing.link.lastError, /Tidak bisa memulai WhatsApp/);
  } finally {
    cleanup(dir);
  }
});

test('sendText reports send_failed and refuses empty text', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir });
    await h.link.link();
    const sock = h.log.sockets[0];
    sock.config.auth.creds.me = { id: '628111@s.whatsapp.net', name: 'Adhit' };
    sock.emit('connection.update', { connection: 'open' });

    await assert.rejects(() => h.link.sendText('   '), (err) => err instanceof WaLinkError && err.code === 'send_failed');

    sock.sendMessage = async () => {
      throw new Error('ECONNRESET secret detail');
    };
    await assert.rejects(
      () => h.link.sendText('halo'),
      (err) => err instanceof WaLinkError && err.code === 'send_failed' && !/ECONNRESET|secret detail/.test(err.message),
    );
    h.link.stop();
  } finally {
    cleanup(dir);
  }
});

test('stop() closes the socket but keeps the session on disk', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir });
    await h.link.link();
    const sock = h.log.sockets[0];

    h.link.stop();
    assert.equal(sock.ended, true, 'the websocket is closed on shutdown');
    assert.equal(existsSync(dir), true, 'shutdown never unlinks WhatsApp');
    assert.equal((await h.link.status()).state, 'off');
  } finally {
    cleanup(dir);
  }
});

test('unlink() wipes the store and stops the socket', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir });
    await h.link.link();
    assert.ok(existsSync(dir), 'linking created the session folder');
    const sock = h.log.sockets[0];

    await h.link.unlink();
    assert.equal(sock.loggedOut, true, 'the phone is told this device is gone');
    assert.equal(sock.ended, true);
    assert.equal(existsSync(dir), false, 'no key and no session left on disk');
    assert.equal((await h.link.status()).state, 'off');
    assert.deepEqual(pairStatus(await h.link.status()), { configured: false, status: 'disconnected' });
    assert.equal(h.link.lastError, null);
  } finally {
    cleanup(dir);
  }
});

// "Lepas" is the user's data-deletion path (the privacy doc promises the session is gone afterwards). A phone that is
// offline never answers logout(), and the route gives up at 5 s — so unlink() must not depend on that answer.
test('pairingCode(): hanya digit yang dikirim, kode dikembalikan, nomor salah ditolak sebelum socket dibuka', async () => {
  const dir = tempDir();
  const badDir = tempDir();
  try {
    const h = harness({ dir });
    const out = await h.link.pairingCode('+62 812-3456-789');
    assert.equal(out.code, 'ABCD-1234', 'kode dari WhatsApp diteruskan ke pemanggil');
    assert.ok(out.expiresAt > Date.now() + 4 * 60_000, 'kode punya masa berlaku (kartu menampilkan sampai jam berapa)');
    assert.equal(h.link.pairCode, 'ABCD-1234');
    const sock = h.log.sockets[0];
    assert.deepEqual(sock.pairingAsks, ['628123456789'], 'digit saja, kode negara ikut');

    // once the phone links, the code is spent
    sock.emit('connection.update', { connection: 'open' });
    assert.equal(h.link.pairCode, null, 'kode hilang setelah tertaut');
    assert.equal((await h.link.pairingCode('628123456789')).code, null, 'sudah tertaut: tidak ada kode baru');
    h.link.stop();

    const bad = harness({ dir: badDir });
    await assert.rejects(() => bad.link.pairingCode('0812'), (err) => err.code === 'bad_phone');
    assert.equal(bad.log.sockets.length, 0, 'nomor yang tidak valid tidak membuka socket');
  } finally {
    cleanup(dir);
    cleanup(badDir);
  }
});

test('unlink() still deletes the session when logout() never finishes', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir, logoutTimeoutMs: 50 });
    await h.link.link();
    assert.ok(existsSync(dir), 'linking created the session folder');
    const sock = h.log.sockets[0];
    sock.logout = () => new Promise(() => {}); // the phone is offline: baileys never answers

    const started = Date.now();
    await h.link.unlink(); // must settle, not hang
    assert.ok(Date.now() - started < 2_000, 'unlink() gave up on the logout and carried on');

    assert.equal(sock.ended, true, 'the socket is closed even though the logout never answered');
    assert.equal(existsSync(dir), false, 'the credentials and key are gone from disk');
    assert.equal((await h.link.status()).state, 'off');
    assert.deepEqual(pairStatus(await h.link.status()), { configured: false, status: 'disconnected' });
    assert.equal(h.link.lastError, null, 'a timed-out goodbye is not an error the page has to show');
  } finally {
    cleanup(dir);
  }
});

test('unlink() deletes the session even when logout() throws', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir });
    await h.link.link();
    assert.ok(existsSync(dir), 'linking created the session folder');
    const sock = h.log.sockets[0];
    sock.logout = async () => {
      throw new Error('ECONNRESET 628111@s.whatsapp.net');
    };

    await h.link.unlink(); // not a rejection: the wipe is what unlinks
    assert.equal(sock.ended, true);
    assert.equal(existsSync(dir), false, 'a failed logout never leaves the session behind');
    assert.equal((await h.link.status()).state, 'off');
    assert.equal(h.link.lastError, null, 'the failed goodbye never leaks into the status');
  } finally {
    cleanup(dir);
  }
});

test('link() waits for a running unlink() instead of opening a socket mid-wipe', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir, logoutTimeoutMs: 5_000 });
    await h.link.link();
    const sock = h.log.sockets[0];
    sock.logout = () => delay(30); // the goodbye is still in flight when the page asks to link again

    const unlinking = h.link.unlink();
    await flush();
    const linking = h.link.link();
    await flush();
    assert.equal(h.log.sockets.length, 1, 'no new socket while the credentials are being deleted');

    await unlinking;
    await linking;
    assert.equal(existsSync(dir), true, 'the fresh link starts its own session');
    assert.equal(h.log.sockets.length, 2, 'link() proceeds once the wipe is done');
    h.link.stop();
  } finally {
    cleanup(dir);
  }
});

// A reboot/restart used to leave the link 'off' even though the encrypted session was still on disk: WhatsApp
// "forgot" the login, /pair reported configured:false and the PIN button stayed dead. restore() is what the
// server calls at start-up (and before a PIN send) to bring that session back.
test('restore() reconnects the session left on disk', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir, store: storedSession(dir) });
    const status = await h.link.restore();
    assert.equal(h.log.sockets.length, 1, 'the stored credentials open a socket');
    assert.equal(status.state, 'connecting', 'the login is in flight, not a QR');

    h.log.sockets[0].emit('connection.update', { connection: 'open' });
    assert.equal((await h.link.status()).state, 'linked');
    // The PIN path works right away: this is what the pair page needs after a reboot.
    assert.deepEqual(await h.link.sendText('halo'), { ok: true });
    assert.deepEqual(h.log.sockets[0].sends, [{ jid: '628111@s.whatsapp.net', content: { text: 'halo' } }]);
    h.link.stop();
  } finally {
    cleanup(dir);
  }
});

test('restore() without a session opens no socket and shows no QR', async () => {
  const dir = tempDir();
  try {
    const loads = { count: 0 };
    const h = harness({
      dir,
      store: { dir, hasSession: () => false, load: async () => { loads.count += 1; throw new Error('nothing to load'); }, wipe: async () => {} },
    });
    assert.deepEqual(await h.link.restore(), { state: 'off', qr: null, me: null, since: null });
    assert.equal(h.log.sockets.length, 0, 'a boot without a session must not mint a new login');
    assert.equal(loads.count, 0, 'the store is not even read');
    assert.equal(h.log.statuses.length, 0, 'nothing to broadcast: no QR was created');
  } finally {
    cleanup(dir);
  }
});

test('restore() is idempotent while connecting or linked', async () => {
  const dir = tempDir();
  try {
    const h = harness({ dir, store: storedSession(dir) });
    await Promise.all([h.link.restore(), h.link.restore()]);
    assert.equal(h.log.sockets.length, 1, 'two restores at boot share one socket');
    await h.link.restore();
    assert.equal(h.log.sockets.length, 1);

    h.log.sockets[0].emit('connection.update', { connection: 'open' });
    await h.link.restore();
    assert.equal(h.log.sockets.length, 1, 'a linked session is left alone');
    h.link.stop();
  } finally {
    cleanup(dir);
  }
});

test('restore() never throws: a broken store is left in lastError', async () => {
  const dir = tempDir();
  try {
    const h = harness({
      dir,
      store: {
        dir,
        hasSession: () => true,
        load: async () => {
          throw new WaAuthStoreError('tampered', 'Sesi WhatsApp tidak bisa dibaca: file sesi rusak atau diubah. Lepas tautan lalu pindai QR lagi.');
        },
        wipe: async () => {},
      },
    });
    const status = await h.link.restore(); // not a rejection: a restart must survive a broken session
    assert.equal(status.state, 'off');
    assert.match(h.link.lastError, /Sesi WhatsApp/);
    assert.equal(h.log.sockets.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('hasSession(): a session file on disk counts, an empty folder does not', () => {
  const dir = tempDir();
  try {
    const store = new EncryptedAuthStore({ dir });
    assert.equal(store.hasSession(), false, 'nothing on disk yet');
    writeFileSync(path.join(dir, 'session.bin'), Buffer.from('sealed'));
    assert.equal(store.hasSession(), true, 'the sealed session is what restore() looks for');
  } finally {
    cleanup(dir);
  }
});
