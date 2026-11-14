// bridge/netlify.test.mjs — inti jembatan Netlify multi-tenant, pola test lama worker.test.mjs:
// fetch Tuya dan store Blobs difake (driver Map); tanpa jaringan, tanpa runtime Netlify.
// Jalankan: node --test --test-timeout=60000 bridge/
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import vm from 'node:vm';
import { handleApi, scheduledSweep } from './src/bridge.mjs';
import { decryptCreds, decryptSecret, encryptCreds } from './src/vault.mjs';
import * as store from './src/store.mjs';

const CID = 'cid-123';
const SECRET = 'rahasia-tuya-xyz';
const DEVICE = 'dev-1';
const KEY = 'ab'.repeat(32); // ENCRYPTION_KEY 32-byte hex

const calls = [];
let powerW = 45;
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

const res = (j) => ({ json: async () => j });
const fakeTuya = () => {
  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    if (u.includes('/v1.0/token')) return res({ success: true, result: { access_token: 'tok-1' } });
    if (u.includes('/commands')) return res({ success: true, result: true });
    if (u.includes('/status')) return res({ success: true, result: [{ code: 'switch_1', value: true }, { code: 'power', value: powerW }] });
    return res({ success: true, result: null });
  };
};

/** Driver Blobs palsu, bentuk persis @netlify/blobs store; map diekspos agar test bisa mengintip isi store. */
const makeStore = () => {
  const map = new Map();
  return {
    map,
    get: async (k) => (map.has(k) ? map.get(k) : null),
    set: async (k, v) => { map.set(k, String(v)); },
    delete: async (k) => { map.delete(k); },
    list: async ({ prefix }) => ({ blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
  };
};

const makeEnv = () => {
  const env = { store: makeStore(), encryptionKey: KEY, cycleWaitMs: 0 };
  return env;
};

const req = (path, init = {}) => new Request(`https://bridge.test${path}`, init);
const jsonReq = (path, body, headers = {}) => req(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const statusOf = async (r) => {
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; } // halaman HTML (mis. tiket kedaluwarsa) diteruskan mentah
  return { status: r.status, body };
};

const defaultBody = () => ({ tuyaClientId: CID, tuyaClientSecret: SECRET, tuyaDeviceId: DEVICE, tuyaRegion: 'eu', adhitronUrl: 'https://saya.ts.net' });

/** Register via endpoint; kembalikan respons + token/id. */
const doRegister = async (env, body = defaultBody(), ip = '1.2.3.4') => {
  const r = await handleApi(req('/api/space', {
    method: 'POST',
    headers: { 'x-nf-client-connection-ip': ip, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  return statusOf(r);
};

const getSpace = async (env, id) => store.getSpace(env, id);
const cmdValues = () => calls.filter((c) => c.url.includes('/commands')).map((c) => c.body.commands[0].value);

// ---------------------------------------------------------------- register + enkripsi

test('register: id + token, kredensial TIDAK PERNAH plaintext di store, kredensial bisa didekripsi', async () => {
  const env = makeEnv();
  fakeTuya();
  const { status, body } = await doRegister(env);
  assert.equal(status, 200, JSON.stringify(body));
  assert.match(body.id, /^[0-9a-f]{8}$/, 'id = 8 char hex');
  assert.match(body.token, /^[0-9a-f]{64}$/, 'token = 32-byte hex');
  assert.equal(body.bridgeUrl, 'https://bridge.test', 'URL jembatan untuk panel Adhitron');
  assert.match(body.manageUrl, /\/manage\?token=/);
  const space = await getSpace(env, body.id);
  assert.ok(space, 'record space ada');
  const everything = [...env.store.map.values()].join('\n');
  assert.equal(everything.includes(SECRET), false, 'secret tidak pernah plaintext');
  assert.equal(everything.includes(CID), false, 'client id tidak pernah plaintext');
  assert.equal(everything.includes(DEVICE), false, 'device id tidak pernah plaintext');
  assert.equal(everything.includes(body.token), false, 'A3: ownerToken tidak pernah plaintext di store (record cipher, index hash)');
  assert.match(space.enc.ct, /^[0-9a-f]+$/);
  assert.match(space.enc.iv, /^[0-9a-f]{24}$/);
  assert.match(space.enc.salt, /^[0-9a-f]{32}$/);
  const creds = decryptCreds(decryptSecret(KEY, space.ownerTokenEnc), KEY, space.enc);
  assert.equal(creds.tuyaClientSecret, SECRET, 'dekripsi dengan token pemilik berhasil');
  assert.equal(space.adhitronUrl, 'https://saya.ts.net', 'adhitronUrl tetap plaintext');
  const tokHash = createHash('sha256').update(body.token).digest('hex');
  assert.equal(await env.store.map.get(`token/${tokHash}`), body.id, 'index token → space (key = sha256)');
});

test('register: validasi input — field kosong, region asal, adhitronUrl non-https ditolak 400', async () => {
  const env = makeEnv();
  fakeTuya();
  for (const bad of [
    { ...defaultBody(), tuyaClientId: '' },
    { ...defaultBody(), tuyaClientSecret: 'x'.repeat(201) },
    { ...defaultBody(), tuyaRegion: 'mars' },
    { ...defaultBody(), adhitronUrl: 'http://saya.ts.net' },
  ]) {
    const { status } = await doRegister(env, bad);
    assert.equal(status, 400, JSON.stringify(bad));
  }
  const { status } = await doRegister(env, { ...defaultBody(), adhitronUrl: null });
  assert.equal(status, 200, 'adhitronUrl kosong boleh');
});

test('register: throttle 10 space per IP per hari — ke-11 ditolak 429', async () => {
  const env = makeEnv();
  fakeTuya();
  for (let i = 0; i < 10; i++) assert.equal((await doRegister(env, defaultBody())).status, 200, `register #${i + 1}`);
  const { status } = await doRegister(env);
  assert.equal(status, 429, 'ke-11 dari IP sama ditolak');
  assert.equal((await doRegister(env, defaultBody(), '5.6.7.8')).status, 200, 'IP lain tidak kena');
});

test('vault: kunci salah tidak bisa dekripsi; pasangan enkripsi-dekripsi simetris', () => {
  const enc = encryptCreds('tok', KEY, { a: 1 });
  assert.deepEqual(decryptCreds('tok', KEY, enc), { a: 1 });
  assert.throws(() => decryptCreds('tok-lain', KEY, enc), 'ownerToken salah → gagal');
  assert.throws(() => decryptCreds('tok', 'cd'.repeat(32), enc), 'ENCRYPTION_KEY salah → gagal');
  assert.throws(() => encryptCreds('tok', 'tidak-hex', { a: 1 }), 'ENCRYPTION_KEY tidak valid → ditolak');
});

// ---------------------------------------------------------------- auth

test('auth: token salah/hilang → 401 di semua endpoint, tanpa bocor', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  assert.equal((await statusOf(await handleApi(req('/api/status'), env))).status, 401);
  assert.equal((await statusOf(await handleApi(jsonReq('/api/heartbeat', { ts: 1 }, { 'X-Bridge-Token': 'salah' }), env))).status, 401);
  assert.equal((await statusOf(await handleApi(jsonReq('/api/off', {}, { 'X-Status-Token': 'salah' }), env))).status, 401);
  assert.equal((await statusOf(await handleApi(req(`/s/${id}?token=salah`), env))).status, 401);
  assert.equal((await statusOf(await handleApi(req(`/manage?token=salah`), env))).status, 401);
  assert.equal((await statusOf(await handleApi(req(`/s/${id}`), env))).status, 401, 'tanpa t/token');
  const space = await getSpace(env, id);
  const leak = JSON.stringify([...env.store.map.values()]);
  assert.equal(leak.includes(SECRET), false);
  assert.equal(leak.includes(token), false, 'A3: ownerToken tidak plaintext di store');
  assert.ok(space.ownerTokenEnc, 'simpanan token terenkripsi tetap ada');
  assert.ok(token, 'token pemilik tetap berlaku untuk akses sendiri');
});

// ---------------------------------------------------------------- off → jadwal + tiket + heartbeat batal

test('off?delay: jadwal ditulis, handoffUrl + tiket 10 menit dibuat', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const before = Date.now();
  const r = await statusOf(await handleApi(jsonReq(`/api/off?delay=120`, {}, { 'X-Bridge-Token': token }), env));
  assert.equal(r.status, 200);
  assert.ok(r.body.offAt >= before + 119_000 && r.body.offAt <= Date.now() + 120_000, 'offAt = sekarang + delay');
  assert.match(r.body.handoffUrl, new RegExp(`^/s/${id}\\?t=[0-9a-f]{64}$`), 'handoffUrl tanpa token jangka panjang');
  const space = await getSpace(env, id);
  assert.equal(space.offAt, r.body.offAt);
  assert.ok(space.offAtWrittenAt >= before, 'offAtWrittenAt dicatat');
  const t = r.body.handoffUrl.split('?t=')[1];
  const ticket = await store.getTicket(env, 'h', t);
  assert.equal(ticket.spaceId, id);
  assert.ok(ticket.exp > before + 9 * 60_000 && ticket.exp <= before + 10 * 60_000 + 1000, 'tiket TTL 10 menit');
  assert.deepEqual(cmdValues(), [], 'delay>0: belum ada komando plug');
});

test('off: delay di luar 0–3600 → 400; delay kosong → default 300', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  assert.equal((await statusOf(await handleApi(jsonReq('/api/off?delay=3601', {}, { 'X-Bridge-Token': token }), env))).status, 400);
  assert.equal((await statusOf(await handleApi(jsonReq('/api/off?delay=-5', {}, { 'X-Bridge-Token': token }), env))).status, 400);
  assert.equal((await statusOf(await handleApi(jsonReq('/api/off?delay=abc', {}, { 'X-Bridge-Token': token }), env))).status, 400);
  const r = await statusOf(await handleApi(jsonReq('/api/off', {}, { 'X-Bridge-Token': token }), env));
  assert.equal(r.status, 200);
  assert.ok(r.body.offAt > Date.now() + 290_000, 'default delay 300 dtk');
});

test('off?delay=0: langsung memutus (satu komando OFF, tidak siklus)', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  const r = await statusOf(await handleApi(jsonReq('/api/off?delay=0', {}, { 'X-Bridge-Token': token }), env));
  assert.equal(r.status, 200);
  assert.equal(r.body.fired, true);
  assert.deepEqual(cmdValues(), [false]);
});

test('tiket serah-terima SEKALI PAKAI: halaman status terbuka, link sama dipakai ulang → 401', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  await handleApi(jsonReq('/api/off?delay=600', {}, { 'X-Bridge-Token': token }), env);
  const first = await handleApi(req(`/s/${id}?token=${token}`), env); // isi jadwal via off dulu
  assert.equal(first.status, 200);
  const r = await statusOf(await handleApi(jsonReq('/api/off', {}, { 'X-Bridge-Token': token }), env));
  const t = r.body.handoffUrl.split('?t=')[1];
  const page = await handleApi(req(`/s/${id}?t=${t}`), env);
  assert.equal(page.status, 200);
  const html = await page.text();
  const session = html.match(/TOKEN = "([0-9a-f]{64})"/)?.[1];
  assert.ok(session, 'halaman membawa tiket sesi untuk polling');
  assert.equal(html.includes(SECRET), false, 'halaman tidak bocorkan kredensial');
  assert.equal((await statusOf(await handleApi(req(`/s/${id}?t=${t}`), env))).status, 401, 'tiket sama dipakai kedua kali → 401');
  // Polling halaman pakai header X-Status-Token (bukan X-Bridge-Token)
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Status-Token': session } }), env));
  assert.equal(st.status, 200);
  assert.equal(st.body.id, id);
  assert.ok(st.body.offAt, 'jadwal masih berjalan');
});

test('A1: tiket serah-terima SEKALI PAKAI juga di jalur header — pemakaian kedua via X-Status-Token → 401', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const r = await statusOf(await handleApi(jsonReq('/api/off?delay=600', {}, { 'X-Bridge-Token': token }), env));
  const t = r.body.handoffUrl.split('?t=')[1];
  // Pemakaian pertama LEWAT HEADER: handoffUrl bocor dipakai langsung tanpa membuka halaman
  const first = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Status-Token': t } }), env));
  assert.equal(first.status, 200, 'tiket serah-terima valid di jalur header');
  assert.equal(first.body.id, id);
  // Pemakaian kedua (judul: URL bocor bisa dipakai berulang) harus gagal — tiket sudah dihapus
  assert.equal((await statusOf(await handleApi(req('/api/status', { headers: { 'X-Status-Token': t } }), env))).status, 401, 'tiket habis setelah dipakai sekali');
  // Dan jalur halaman juga tidak lagi menerima tiket yang sudah dipakai lewat header
  assert.equal((await statusOf(await handleApi(req(`/s/${id}?t=${t}`), env))).status, 401, 'jalur halaman ikut melihat tiket sudah terpakai');
});

test('A4-related: tiket sesi (ticket/s) tetap reusable sampai TTL di jalur header', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  await handleApi(jsonReq('/api/off?delay=600', {}, { 'X-Bridge-Token': token }), env);
  const page = await handleApi(req(`/s/${id}?token=${token}`), env);
  const session = (await page.text()).match(/TOKEN = "([0-9a-f]{64})"/)?.[1];
  assert.ok(session);
  for (let i = 0; i < 3; i++) {
    const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Status-Token': session } }), env));
    assert.equal(st.status, 200, `poll ke-${i + 1} tetap 200`);
  }
});

test('heartbeat: lastHeartbeat tertulis; heartbeat datang → jadwal mati BATAL (aturan pembatalan)', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  assert.deepEqual(await statusOf(await handleApi(jsonReq('/api/heartbeat', { ts: 1, version: '1.0.25' }, { 'X-Bridge-Token': token }), env)), { status: 200, body: { ok: true } });
  let space = await getSpace(env, id);
  space.lastHeartbeat -= 60_000; // mundurkan 1 mnt: test berjalan < 1 ms, timestamp hb1 dan hb2 bisa jatuh di milidetik sama
  const beat = space.lastHeartbeat;
  await store.putSpace(env, space);
  assert.ok(beat > 0);
  assert.equal(space.version, '1.0.25');
  await handleApi(jsonReq('/api/off?delay=120', {}, { 'X-Bridge-Token': token }), env);
  space = await getSpace(env, id);
  assert.ok(space.offAt, 'jadwal tertulis');
  space.offAtWrittenAt -= 5_000; // deterministik: anggap jadwal ditulis 5 dtk lalu (hindari balapan milidetik)
  await store.putSpace(env, space);
  assert.deepEqual(await statusOf(await handleApi(jsonReq('/api/heartbeat', {}, { 'X-Bridge-Token': token }), env)), { status: 200, body: { ok: true } });
  space = await getSpace(env, id);
  assert.equal(space.offAt, null, 'PC ternyata hidup lagi → jadwal dibatalkan');
  assert.equal(space.lastHeartbeat > beat, true, 'heartbeat terbaru dicatat (batal selalu menulis)');
  // throttle: heartbeat kedua dalam < 1 mnt tanpa jadwal → diterima tapi tidak menulis ulang
  const second = await statusOf(await handleApi(jsonReq('/api/heartbeat', {}, { 'X-Bridge-Token': token }), env));
  assert.deepEqual(second, { status: 200, body: { ok: true } });
  assert.equal((await getSpace(env, id)).lastHeartbeat, space.lastHeartbeat, 'throttled: tidak menulis ulang');
});

// ---------------------------------------------------------------- cron

test('cron: jadwal jatuh tempo + daya turun → plug OFF, jadwal bersih, attempts 0', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 0.2;
  const { body: { id, token } } = await doRegister(env);
  await handleApi(jsonReq('/api/heartbeat', {}, { 'X-Bridge-Token': token }), env);
  await handleApi(jsonReq('/api/off?delay=60', {}, { 'X-Bridge-Token': token }), env);
  const space = await getSpace(env, id);
  const now = space.offAt + 500;
  assert.deepEqual(await scheduledSweep(env, now), [{ id, action: 'off', powerW: 0.2 }]);
  const after = await getSpace(env, id);
  assert.deepEqual(cmdValues(), [false], 'cron memutus listrik');
  assert.equal(after.offAt, null);
  assert.equal(after.attempts, 0);
  assert.equal(after.lastPlug, 'off');
  assert.equal(after.powerW, 0.2, 'daya terakhir dicatat');
  assert.deepEqual(await scheduledSweep(env, now), [], 'tidak ada lagi yang jatuh tempo');
});

test('cron: daya masih tinggi → coba ulang +60 dtk; 3× gagal → needsAttention (tidak loop)', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 45;
  const { body: { id } } = await doRegister(env);
  const before = Date.now();
  const space0 = await getSpace(env, id);
  space0.offAt = before - 1000;
  space0.offAtWrittenAt = before - 2000;
  await store.putSpace(env, space0);
  let now = before;
  for (let i = 1; i <= 3; i++) {
    calls.length = 0;
    const res2 = await scheduledSweep(env, now);
    assert.deepEqual(res2, [{ id, action: 'retry', powerW: 45 }], `pass ${i}`);
    const space = await getSpace(env, id);
    assert.deepEqual(cmdValues(), [false], 'komando OFF tetap dikirim tiap pass');
    if (i < 3) {
      assert.equal(space.attempts, i);
      assert.equal(space.offAt, now + 60_000, 'jadwal ulang 60 dtk');
    } else {
      assert.equal(space.offAt, null, 'habis 3 percobaan: jadwal dihentikan');
      assert.equal(space.needsAttention, true, '⚠ gagal memutus ditandakan');
    }
    now = space.offAt ?? now + 60_000;
  }
  assert.deepEqual(await scheduledSweep(env, now), [], 'setelah needsAttention tidak ada jadwal lagi');
});

test('cron: PC ternyata hidup setelah jadwal ditulis → batal tanpa menyentuh plug', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  await handleApi(jsonReq('/api/off?delay=60', {}, { 'X-Bridge-Token': token }), env);
  const space = await getSpace(env, id);
  space.lastHeartbeat = space.offAtWrittenAt + 1; // heartbeat datang setelah offAt ditulis
  await store.putSpace(env, space);
  const before = [...env.store.map.values()].length;
  assert.deepEqual(await scheduledSweep(env, Date.now() + 120_000), [{ id, action: 'cancel' }]);
  assert.deepEqual(cmdValues(), [], 'plug tidak disentuh');
  assert.equal((await getSpace(env, id)).offAt, null);
  assert.equal([...env.store.map.values()].length, before, 'tidak ada key baru');
});

// ---------------------------------------------------------------- retensi (C1) + validasi token (B4)

test('C1: sweep retensi — space mati lama terhapus (index + tiket ikut), space hidup tidak', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id: deadId, token: deadToken } } = await doRegister(env, defaultBody(), '9.9.9.9');
  const { body: { id: aliveId, token: aliveToken } } = await doRegister(env, defaultBody(), '8.8.8.8');
  await handleApi(jsonReq('/api/heartbeat', {}, { 'X-Bridge-Token': aliveToken }), env);
  // Jadwalkan pembuatan tiket untuk space mati: buka halaman status dulu (ownerToken), lalu off
  const deadPage = await handleApi(req(`/s/${deadId}?token=${deadToken}`), env);
  const deadSession = (await deadPage.text()).match(/TOKEN = "([0-9a-f]{64})"/)?.[1];
  const deadSpace = await getSpace(env, deadId);
  deadSpace.lastHeartbeat = 0; // kembalikan: dianggap tak pernah dipakai
  deadSpace.createdAt = Date.now() - 31 * 86_400_000; // daftar 31 hari lalu
  await store.putSpace(env, deadSpace);
  const aliveSpace = await getSpace(env, aliveId);
  const aliveHash = aliveSpace.tokenHash;
  const now = Date.now();
  const results = await scheduledSweep(env, now);
  assert.ok(results.find((r) => r.id === deadId && r.action === 'retention-delete'), 'space mati lama dihapus');
  assert.equal(await getSpace(env, deadId), null, 'record space mati hilang');
  assert.equal(await env.store.map.get(`token/${createHash('sha256').update(deadToken).digest('hex')}`), undefined, 'index token space mati hilang');
  assert.equal(await store.getTicket(env, 's', deadSession), null, 'tiket milik space mati ikut hilang');
  assert.ok(await getSpace(env, aliveId), 'space hidup tidak disentuh');
  assert.equal(await env.store.map.get(`token/${aliveHash}`), aliveId, 'index space hidup tetap ada');
  // Heartbeat basi > 6 bulan juga terhapus
  const stale = await getSpace(env, aliveId);
  stale.lastHeartbeat = now - 7 * 30 * 86_400_000; // 7 bulan tanpa kabar
  await store.putSpace(env, stale);
  const again = await scheduledSweep(env, now);
  assert.ok(again.find((r) => r.id === aliveId && r.action === 'retention-delete'), 'space tanpa heartbeat > 6 bulan dihapus');
});

test('B4: token header tidak valid (bukan hex / panjang aneh) → 401 tanpa menyentuh store', async () => {
  const env = makeEnv();
  fakeTuya();
  for (const bad of ['x'.repeat(20), 'a'.repeat(8), 'a'.repeat(65), `${'a'.repeat(8)}/../evil`]) {
    assert.equal((await statusOf(await handleApi(req('/api/status', { headers: { 'X-Status-Token': bad } }), env))).status, 401, `token "${bad}" ditolak`);
  }
});


// ---------------------------------------------------------------- on / status

test('on: menghapus jadwal, memutari listrik (siklus OFF→ON karena plug tercatat ON)', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  await handleApi(jsonReq('/api/off?delay=300', {}, { 'X-Bridge-Token': token }), env);
  assert.deepEqual(await statusOf(await handleApi(jsonReq('/api/on', {}, { 'X-Bridge-Token': token }), env)), { status: 200, body: { ok: true } });
  assert.deepEqual(cmdValues(), [false, true], 'ON yang sudah-ON disiklus OFF → ON (BIOS)');
  const space = await getSpace(env, id);
  assert.equal(space.offAt, null, 'jadwal batal');
  assert.equal(space.lastPlug, 'on');
});

test('/api/status: bentuk kontrak lengkap; booting = power tinggi ≥ 30 dtk + heartbeat basi', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 45;
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const space = await getSpace(env, id);
  space.lastHeartbeat = now - 31 * 60_000; // basi ≥ 30 mnt
  space.powerW = 45;
  space.powerAt = now; // sampel segar → apiStatus tidak memanggil Tuya
  space.powerHighSince = now - 40_000; // power tinggi ≥ 30 dtk
  space.lastPlug = 'on';
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.status, 200);
  assert.deepEqual(Object.keys(st.body).sort(), ['adhitronUrl', 'alive', 'booting', 'id', 'lastHeartbeat', 'needsAttention', 'offAt', 'plug', 'powerAt', 'powerW', 'secondsUntilOff']);
  assert.equal(st.body.alive, false);
  assert.equal(st.body.booting, true, 'PC beku/booting terdeteksi');
  assert.equal(st.body.powerW, 45);
  assert.equal(st.body.plug, 'on');
  assert.equal(st.body.adhitronUrl, 'https://saya.ts.net');
  // sampling dibatasi: poll berikutnya < 30 dtk tidak memanggil Tuya
  calls.length = 0;
  await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env);
  assert.deepEqual(cmdValues(), []);
  assert.equal(calls.filter((c) => c.url.includes('/status')).length, 0, 'kuota Tuya dijaga');
});

// ---------------------------------------------------------------- halaman

test('halaman: register di /, manage, status — tanpa membocorkan kredensial', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const home = await handleApi(req('/'), env);
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /Daftar/);
  assert.match(homeHtml, /terenkripsi/, 'pemberitahuan privasi tampil');
  const page = await handleApi(req(`/s/${id}?token=${token}`), env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Nyalakan PC/, 'PC mati → tombol nyalakan');
  assert.match(html, /saya\.ts\.net/, 'link Adhitron memakai URL yang diset');
  assert.equal(html.includes(SECRET), false, 'secret tidak di halaman');
  assert.equal(html.includes(CID), false, 'client id tidak di halaman');
  const manage = await handleApi(req(`/manage?token=${token}`), env);
  const manageHtml = await manage.text();
  assert.equal(manage.status, 200);
  assert.match(manageHtml, /Hapus permanen/);
  assert.match(manageHtml, /Rotasi token/);
  assert.match(manageHtml, new RegExp(DEVICE), 'device id (milik pemilik) tampil di manage');
  assert.equal(manageHtml.includes(SECRET), false, 'secret tidak dirender ulang');
});

test('halaman /: space diingat di browser (localStorage) supaya refresh tidak kembali ke form kosong', async () => {
  const env = makeEnv();
  fakeTuya();
  const home = await handleApi(req('/'), env);
  assert.equal(home.status, 200);
  const html = await home.text();
  // Kartu "Space kamu" tersembunyi sampai localStorage berisi space (renderSpace() saat halaman dibuka).
  assert.match(html, /id="space"[^>]*hidden/, 'kartu space disembunyikan saat belum ada yang diingat');
  assert.match(html, /adhitron-space/, 'kunci localStorage');
  assert.match(html, /saveSpace\(\{ id: d\.id, bridgeUrl: d\.bridgeUrl, statusUrl: d\.statusUrl, manageUrl: d\.manageUrl \}\)/, 'hasil daftar disimpan (tanpa salinan token terpisah)');
  assert.match(html, /localStorage\.removeItem/, 'tombol Lupakan menghapusnya');
  assert.match(html, /Sudah punya token\?/, 'jalur untuk token yang sudah ada');
  assert.match(html, /id="paste"/, 'form tempel token');
  assert.match(html, /location\.href = '\/manage\?token=' \+ encodeURIComponent\(token\)/, 'tempel token membuka manage');
  assert.match(html, /sp-token/, 'token dirender lewat elemen teks (textContent)');
  assert.equal(/innerHTML[^\n]*d\.token/.test(html), false, 'token tidak pernah lewat innerHTML');
});

test('halaman /: skrip halaman benar-benar bisa dikompilasi (regex tidak kehilangan backslash di template)', async () => {
  const env = makeEnv();
  fakeTuya();
  const html = await (await handleApi(req('/'), env)).text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'satu blok skrip di halaman /');
  assert.equal(scripts[0].includes('${'), false, 'tidak ada sisa interpolasi template');
  // Dulu regex literal di dalam template string kehilangan backslash-nya (\/ → /, \? → ?, \s → s),
  // sehingga seluruh skrip SyntaxError dan semua tombol/form mati. Kompilasi = penjaga nyata.
  assert.doesNotThrow(() => new vm.Script(scripts[0]), 'skrip halaman harus valid');
  assert.match(scripts[0], /new RegExp\(/, 'regex disuntik dari SPACE_SHAPE, bukan literal di template');
});

test('manage: rotasi & hapus ikut memperbarui kartu "Space kamu" (hanya untuk id yang cocok)', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const post = (tok, body) =>
    handleApi(req(`/api/manage?token=${tok}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    }), env);
  // Rotasi: halaman baru menampilkan token baru dan skrip yang mengganti manageUrl di localStorage
  // untuk space ini saja — tanpa itu, kartu "/" masih memakai token mati dan tautannya 401.
  const rotated = await (await post(token, { action: 'rotate' })).text();
  assert.match(rotated, /adhitron-space/);
  assert.match(rotated, /stored\.manageUrl = '\/manage\?token=' \+ encodeURIComponent\(token\)/, 'kartu "/" memakai token baru');
  assert.ok(rotated.includes(`const id = "${id}";`), 'id halaman disuntik sebagai konstanta');
  assert.match(rotated, /stored\.id === id/, 'hanya space ini yang disentuh');
  // Alur "Sudah punya token?": membuka /manage saat belum ada yang diingat membuat entri (bridgeUrl dari origin).
  assert.match(rotated, /bridgeUrl: location\.origin/, 'space lama ikut diingat saat manage dibuka');
  assert.ok(rotated.includes("statusUrl: '/s/' + id"), 'statusUrl dihitung dari id halaman');
  const newToken = rotated.match(/<code>([0-9a-f]{64})<\/code>/)?.[1];
  assert.ok(newToken && newToken !== token, 'token baru ditampilkan (sekali) setelah rotasi');
  // Hapus: halaman terhapus membersihkan entri localStorage, tetap hanya bila id-nya cocok.
  const deleted = await (await post(newToken, { action: 'delete', confirm: 'HAPUS' })).text();
  assert.match(deleted, /localStorage\.removeItem\(KEY\)/);
  assert.ok(deleted.includes(`s.id === "${id}"`), 'id space yang dihapus ikut diperiksa');
});

test('manage: update memakai secret lama saat kosong, rotasi token mematikan token lama, hapus wajib konfirmasi', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  // update: secret kosong → tetap; adhitronUrl diganti
  const form = (tok, action, extra = {}) => req(`/api/manage?token=${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action, ...extra }).toString() });
  let r = await handleApi(form(token, 'update', { tuyaClientId: CID, tuyaClientSecret: '', tuyaDeviceId: DEVICE, tuyaRegion: 'eu', adhitronUrl: 'https://baru.ts.net' }), env);
  assert.equal(r.status, 200);
  let space = await getSpace(env, id);
  let creds = decryptCreds(decryptSecret(KEY, space.ownerTokenEnc), KEY, space.enc);
  assert.equal(creds.tuyaClientSecret, SECRET, 'secret lama dipertahankan');
  assert.equal(space.adhitronUrl, 'https://baru.ts.net');
  // rotasi
  r = await handleApi(form(token, 'rotate'), env);
  assert.equal(r.status, 200);
  const newToken = (await r.text()).match(/Token baru[^]*?<code>([0-9a-f]{64})<\/code>/)?.[1];
  assert.ok(newToken, 'token baru ditampilkan sekali');
  assert.equal((await statusOf(await handleApi(jsonReq('/api/heartbeat', {}, { 'X-Bridge-Token': token }), env))).status, 401, 'token lama mati');
  assert.equal((await statusOf(await handleApi(jsonReq('/api/heartbeat', {}, { 'X-Bridge-Token': newToken }), env))).status, 200, 'token baru hidup');
  space = await getSpace(env, id);
  creds = decryptCreds(decryptSecret(KEY, space.ownerTokenEnc), KEY, space.enc); // re-encrypt dengan token baru
  assert.equal(creds.tuyaClientSecret, SECRET);
  // hapus: tanpa konfirmasi → 400; dengan konfirmasi → hilang
  assert.equal((await statusOf(await handleApi(form(newToken, 'delete'), env))).status, 400);
  const del = await handleApi(form(newToken, 'delete', { confirm: 'HAPUS' }), env);
  assert.equal(del.status, 200);
  assert.match(await del.text(), /Space dihapus/);
  assert.equal(await getSpace(env, id), null, 'record space hilang');
  assert.equal(await env.store.map.get(`token/${createHash('sha256').update(newToken).digest('hex')}`), undefined, 'index token (hash) hilang');
});
