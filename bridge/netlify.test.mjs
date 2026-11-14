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

// ---------------------------------------------------------------- kode pasangan (pindah space ke perangkat lain)

// Alfabet kode = 30 simbol tanpa huruf/angka ambigu (I, L, O, U, 0, 1); 30^8 ≈ 6,6 × 10^11.
const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIR_RE = new RegExp(`^[${PAIR_ALPHABET}]{8}$`);
const wrongCode = (i) => `ZZZZZZZ${PAIR_ALPHABET[i % PAIR_ALPHABET.length]}`; // kode sah-format yang pasti tidak ada
const hourKeyOf = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 13);

const requestPair = async (env, token) => statusOf(await handleApi(jsonReq('/api/pair', {}, { 'X-Bridge-Token': token }), env));
const pairHash = (code) => createHash('sha256').update(code).digest('hex'); // isi index pairSpace/<id>
const pairHashKey = (code) => `pair/${pairHash(code)}`;
/** Klaim kode; `body` boleh objek (dikirim JSON) atau string mentah (body bukan JSON). */
const claimPair = async (env, body, ip = '7.7.7.7') => statusOf(await handleApi(req('/api/pair/claim', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-nf-client-connection-ip': ip },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}), env));

test('pair: kode 8 karakter base32 + expiresAt 2 menit; store HANYA menyimpan sha256(kode); satu kode aktif per space', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const before = Date.now();
  const r = await requestPair(env, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.code, PAIR_RE, '8 karakter dari alfabet tanpa huruf/angka ambigu (tanpa I/L/O/U/0/1)');
  assert.ok(r.body.expiresAt > before + 119_000 && r.body.expiresAt <= Date.now() + 120_000, 'TTL tetap 120 dtk');
  assert.deepEqual(JSON.parse(env.store.map.get(pairHashKey(r.body.code))), { spaceId: id, exp: r.body.expiresAt }, 'record = { spaceId, exp } di key sha256(kode)');
  assert.equal(env.store.map.has(`pair/${r.body.code}`), false, 'kode plaintext tidak dipakai sebagai key');
  assert.equal([...env.store.map.keys()].some((k) => k.includes(r.body.code)), false, 'kode tidak muncul di key mana pun');
  assert.equal(await store.getPairSpaceCode(env, id), pairHash(r.body.code), 'referensi kode aktif space disimpan');
  // Kode baru = kode lama mati (satu kode aktif per space).
  const second = await requestPair(env, token);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.code, r.body.code);
  assert.equal(env.store.map.has(pairHashKey(r.body.code)), false, 'kode lama dihapus saat kode baru dibuat');
  assert.equal(await store.getPairSpaceCode(env, id), pairHash(second.body.code), 'referensi menunjuk kode terbaru');
  assert.equal((await claimPair(env, { code: r.body.code })).status, 401, 'kode lama tidak bisa diklaim lagi');
});

test('pair: HANYA ownerToken — tiket serah-terima (ticket/h) dan tiket sesi (ticket/s) ditolak 401', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  // ticket/s: tiket SESI dibuat saat halaman status dibuka dengan tiket serah-terima.
  const first = await statusOf(await handleApi(jsonReq('/api/off?delay=60', {}, { 'X-Bridge-Token': token }), env));
  const handoff1 = first.body.handoffUrl.split('?t=')[1];
  const page = await handleApi(req(`/s/${id}?t=${handoff1}`), env);
  const session = (await page.text()).match(/TOKEN = "([0-9a-f]{64})"/)?.[1];
  assert.ok(session, 'halaman memberi tiket sesi');
  assert.equal((await statusOf(await handleApi(jsonReq('/api/pair', {}, { 'X-Bridge-Token': session }), env))).status, 401, 'tiket sesi tidak boleh ditukar jadi ownerToken');
  // Tiket sesi tidak dihabiskan oleh percobaan itu: jalur status tetap menerimanya.
  assert.equal((await statusOf(await handleApi(req('/api/status', { headers: { 'X-Status-Token': session } }), env))).status, 200, 'tiket sesi masih hidup');
  // ticket/h: tiket serah-terima baru dari /api/off
  const second = await statusOf(await handleApi(jsonReq('/api/off?delay=60', {}, { 'X-Bridge-Token': token }), env));
  const handoff2 = second.body.handoffUrl.split('?t=')[1];
  assert.equal((await statusOf(await handleApi(jsonReq('/api/pair', {}, { 'X-Bridge-Token': handoff2 }), env))).status, 401, 'tiket serah-terima tidak boleh ditukar jadi ownerToken');
  assert.equal((await handleApi(req(`/s/${id}?t=${handoff2}`), env)).status, 200, 'tiket serah-terima masih hidup (tidak dihabiskan /api/pair)');
  // ownerToken sendiri tetap boleh.
  assert.equal((await requestPair(env, token)).status, 200, 'ownerToken tidak terpengaruh');
});

test('pair: tanpa token / token salah / header status → 401', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  assert.equal((await statusOf(await handleApi(jsonReq('/api/pair', {}), env))).status, 401);
  assert.equal((await statusOf(await handleApi(jsonReq('/api/pair', {}, { 'X-Bridge-Token': 'salah' }), env))).status, 401);
  assert.equal((await statusOf(await handleApi(jsonReq('/api/pair', {}, { 'X-Status-Token': token }), env))).status, 401, 'ownerToken di X-Status-Token pun tidak membuka /api/pair');
});

test('claim: kode sah (huruf kecil ikut dinormalisasi) → respons register, sekali pakai', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const { body: { code } } = await requestPair(env, token);
  const claimed = await claimPair(env, { code: code.toLowerCase() });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.deepEqual(claimed.body, {
    ok: true,
    id,
    token, // ownerToken yang sama dengan register: perangkat ini sekarang memegang space-nya
    bridgeUrl: 'https://bridge.test',
    statusUrl: `/s/${id}`,
    manageUrl: `/manage?token=${token}`,
  }, 'bentuk persis respons register');
  assert.equal(await store.getPairCode(env, code), null, 'kode dihapus setelah dipakai');
  assert.equal(env.store.map.has(pairHashKey(code)), false, 'tidak ada sisa key kode');
  assert.ok(!(await store.getPairSpaceCode(env, id)), 'referensi kode aktif ikut dibersihkan');
  assert.equal((await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': claimed.body.token } }), env))).status, 200, 'token hasil klaim benar-benar berlaku');
  const again = await claimPair(env, { code });
  assert.equal(again.status, 401, 'kode yang sama tidak bisa dipakai dua kali (berurutan)');
  assert.equal(again.body.error, 'Kode tidak dikenal atau kedaluwarsa');
});

test('claim: kode tidak ada dan kode kedaluwarsa → 401 dengan pesan yang SAMA (tidak membocorkan bedanya)', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  const missing = await claimPair(env, { code: 'ZZZZZZZZ' });
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.body, { error: 'Kode tidak dikenal atau kedaluwarsa' });
  const { body: { code } } = await requestPair(env, token);
  await store.putPairCode(env, code, { spaceId: 'x', exp: Date.now() - 1 }); // dimundurkan: kedaluwarsa
  const expired = await claimPair(env, { code });
  assert.equal(expired.status, 401);
  assert.deepEqual(expired.body, missing.body, 'kedaluwarsa dan tidak-ada tidak bisa dibedakan');
});

test('claim: body bukan JSON / code bukan 8 karakter base32 → 400', async () => {
  const env = makeEnv();
  fakeTuya();
  for (const body of [
    'bukan json', {}, { code: '' }, { code: 'ABCDEFG' }, { code: 'ABCDEFGHJ' }, // panjang salah
    { code: 'ABCDEFGI' }, { code: 'ABCDEFGL' }, { code: 'ABCDEFGO' }, { code: 'ABCDEFGU' }, // huruf ambigu
    { code: 'ABCDEFG0' }, { code: 'ABCDEFG1' }, { code: '12345678' }, // angka ambigu
    { code: 12345678 }, { code: null }, { code: ['AAAAAAAA'] },
  ]) {
    const r = await claimPair(env, body);
    assert.equal(r.status, 400, `body ${JSON.stringify(body)} harus 400`);
  }
});

test('claim: 20 percobaan gagal per IP per jam → 429, dan tidak mencampur kuota register (prefix pairtry/)', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  const ip = '9.9.9.9';
  for (let i = 0; i < 20; i++) {
    assert.equal((await claimPair(env, { code: wrongCode(i) }, ip)).status, 401, `percobaan gagal #${i + 1}`);
  }
  const blocked = await claimPair(env, { code: wrongCode(20) }, ip);
  assert.equal(blocked.status, 429, 'percobaan ke-21 dari IP yang sama ditolak');
  assert.match(blocked.body.error, /Terlalu banyak/);
  // IP yang terkunci tetap ditolak walau kodenya sah (anti-tebak), IP lain tidak terpengaruh.
  const { body: { code } } = await requestPair(env, token);
  assert.equal((await claimPair(env, { code }, ip)).status, 429, 'kode sah pun ditolak selama IP terkunci');
  assert.equal((await claimPair(env, { code }, '8.8.8.8')).status, 200, 'IP lain bisa mengklaim kode yang sama');
  // Throttle klaim punya key sendiri: kuota register IP itu tidak ikut terbakar.
  assert.equal([...env.store.map.keys()].some((k) => k.startsWith('pairtry/9.9.9.9/')), true, 'hitungan gagal di prefix pairtry/');
  assert.equal([...env.store.map.keys()].some((k) => k.startsWith('reg/9.9.9.9/')), false, 'reg/<ip> tidak tersentuh');
  assert.equal((await doRegister(env, defaultBody(), ip)).status, 200, 'IP yang terkunci klaim masih boleh mendaftar (kuota terpisah)');
});

test('claim: x-forwarded-for TIDAK dipercaya — semua request tanpa header Netlify jatuh ke bucket "unknown"', async () => {
  const env = makeEnv();
  fakeTuya();
  // 20 gagal, masing-masing dengan XFF berbeda dan TANPA x-nf-client-connection-ip → satu bucket.
  for (let i = 0; i < 20; i++) {
    const r = await statusOf(await handleApi(req('/api/pair/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.1.1.${i}` },
      body: JSON.stringify({ code: wrongCode(i) }),
    }), env));
    assert.equal(r.status, 401, `gagal #${i + 1}`);
  }
  // XFF baru tidak memberi bucket baru: tetap 429 dari bucket 'unknown'.
  const blocked = await statusOf(await handleApi(req('/api/pair/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.9.9.9' },
    body: JSON.stringify({ code: wrongCode(20) }),
  }), env));
  assert.equal(blocked.status, 429, 'XFF palsu tidak melewati throttle');
  const keys = [...env.store.map.keys()];
  assert.equal(keys.some((k) => k.startsWith('pairtry/unknown/')), true, 'bucket "unknown" yang dipakai');
  assert.equal(keys.some((k) => k.includes('10.1.1.') || k.includes('10.9.9.')), false, 'tidak ada bucket dari XFF');
});

test('claim: batas global 3000 gagal/jam lintas IP → 429 walau IP ini belum pernah gagal', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  // Isi batas global jam berjalan; probe memastikan bridge benar-benar membacanya (jaga-jaga lintas jam).
  let filled = null;
  for (let i = 0; i < 3 && !filled; i++) {
    await env.store.set(`pairtry/_global/${hourKeyOf()}`, '3000');
    if (await claimPair(env, { code: wrongCode(i) }, `10.5.5.${i + 1}`).then((r) => r.status === 429)) filled = hourKeyOf();
  }
  assert.ok(filled, 'batas global terpasang');
  const { body: { code } } = await requestPair(env, token);
  const fresh = await claimPair(env, { code }, '10.6.6.6'); // IP baru, belum pernah salah
  assert.equal(fresh.status, 429, 'kode sah pun ditolak saat batas total penuh');
  assert.match(fresh.body.error, /Terlalu banyak/);
});

test('pair: tabrakan kode tidak menimpa kode aktif space lain (kode dibuat ulang)', async () => {
  const env = makeEnv();
  fakeTuya();
  const a = await doRegister(env, defaultBody(), '1.1.1.1');
  const b = await doRegister(env, defaultBody(), '2.2.2.2');
  const codeA = (await requestPair(env, a.body.token)).body.code;
  // Simulasi: pembuat kode space B "kebetulan" menghasilkan kode yang sama dengan space A, lalu kode bebas.
  let calls = 0;
  env.makeCode = () => (++calls === 1 ? codeA : 'ZZZZZZZZ');
  const r = await requestPair(env, b.body.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZZZZZZZZ', 'kode bentrok dilewati, bukan ditimpa');
  const recA = JSON.parse(env.store.map.get(pairHashKey(codeA)));
  assert.equal(recA.spaceId, a.body.id, 'record kode space A utuh (tidak ditimpa)');
  assert.equal((await claimPair(env, { code: codeA })).body.id, a.body.id, 'klaim kode A tetap menuju space A');
});

test('pair: 5 tabrakan berturut-turut → 503, kode space lain tetap utuh', async () => {
  const env = makeEnv();
  fakeTuya();
  const a = await doRegister(env, defaultBody(), '1.1.1.1');
  const b = await doRegister(env, defaultBody(), '2.2.2.2');
  const codeA = (await requestPair(env, a.body.token)).body.code;
  env.makeCode = () => codeA; // selalu bentrok
  const r = await requestPair(env, b.body.token);
  assert.equal(r.status, 503, 'tidak ada kode valid setelah 5 percobaan');
  assert.equal((await claimPair(env, { code: codeA })).body.id, a.body.id, 'kode space A tidak tersentuh');
  assert.ok(!(await store.getPairSpaceCode(env, b.body.id)), 'space B tidak menyimpan referensi kode gagal');
});

test('CORS: /api/pair* tanpa Access-Control-Allow-Origin (termasuk preflight); endpoint lain tidak berubah', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  const pairRes = await handleApi(jsonReq('/api/pair', {}, { 'X-Bridge-Token': token }), env);
  assert.equal(pairRes.status, 200);
  assert.equal(pairRes.headers.get('access-control-allow-origin'), null, 'respons /api/pair tanpa ACAO');
  const code = (await pairRes.json()).code;
  const claimRes = await handleApi(jsonReq('/api/pair/claim', { code }), env);
  assert.equal(claimRes.status, 200);
  assert.equal(claimRes.headers.get('access-control-allow-origin'), null, 'respons claim tanpa ACAO');
  for (const p of ['/api/pair', '/api/pair/claim']) {
    const pre = await handleApi(req(p, { method: 'OPTIONS' }), env);
    assert.equal(pre.status, 204, `preflight ${p}`);
    assert.equal(pre.headers.get('access-control-allow-origin'), null, `preflight ${p} tanpa ACAO`);
  }
  const other = await handleApi(req('/api/status', { method: 'OPTIONS' }), env);
  assert.equal(other.status, 204);
  assert.equal(other.headers.get('access-control-allow-origin'), '*', 'endpoint lain tetap membawa CORS');
  assert.equal(other.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
});

test('halaman HTML: Referrer-Policy, X-Frame-Options DENY, nosniff, CSP frame-ancestors (script inline tetap jalan)', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  for (const path of ['/', `/s/${id}?token=${token}`, `/manage?token=${token}`]) {
    const page = await handleApi(req(path), env);
    assert.equal(page.status, 200, path);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer', path);
    assert.equal(page.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'none'", `${path}: CSP hanya anti-frame, tanpa script-src`);
    assert.equal(page.headers.get('cache-control'), 'no-store', path);
    assert.equal(page.headers.get('access-control-allow-origin'), null, `${path} tetap tanpa CORS`);
  }
});

test('cron: kode pasangan kedaluwarsa dibuang (kode + referensi), yang masih berlaku tidak', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const { body: { code, expiresAt } } = await requestPair(env, token);
  assert.deepEqual(await scheduledSweep(env, expiresAt - 1), [], 'sweep sebelum kedaluwarsa tidak mengubah apa pun');
  assert.ok(await store.getPairCode(env, code), 'kode masih ada');
  assert.deepEqual(await scheduledSweep(env, expiresAt + 1), []);
  assert.equal(env.store.map.has(pairHashKey(code)), false, 'key pair/ kedaluwarsa dihapus sweep');
  assert.ok(!(await store.getPairSpaceCode(env, id)), 'referensi pairSpace/ ikut dibersihkan');
  assert.equal((await claimPair(env, { code })).status, 401, 'kode yang dibuang sweep tidak bisa diklaim');
});

test('cron: hitungan klaim lebih lama dari ~2 jam dibuang (semua bucket, jam & menit); key lain tidak', async () => {
  const env = makeEnv();
  fakeTuya();
  const now = Date.now();
  const oldIpHour = hourKeyOf(now - 3 * 3_600_000);
  const oldGlobalHour = hourKeyOf(now - 4 * 3_600_000);
  const freshHour = hourKeyOf(now - 30 * 60_000);
  const minuteKey = (ms) => new Date(ms).toISOString().slice(0, 16);
  const oldMinute = minuteKey(now - 5 * 3_600_000);
  const freshMinute = minuteKey(now - 30 * 60_000);
  await env.store.set(`pairtry/1.2.3.4/${oldIpHour}`, '5');
  await env.store.set(`pairtry/_global/${oldGlobalHour}`, '100');
  await env.store.set(`pairtry/_globalm/${oldMinute}`, '120');
  await env.store.set(`pairtry/1.2.3.4/${freshHour}`, '2');
  await env.store.set(`pairtry/_global/${freshHour}`, '7');
  await env.store.set(`pairtry/_globalm/${freshMinute}`, '9');
  await env.store.set(`reg/1.2.3.4/${new Date(now).toISOString().slice(0, 10)}`, '1');
  assert.deepEqual(await scheduledSweep(env, now), []);
  assert.equal(env.store.map.has(`pairtry/1.2.3.4/${oldIpHour}`), false, 'hitungan IP lama dibuang');
  assert.equal(env.store.map.has(`pairtry/_global/${oldGlobalHour}`), false, 'hitungan global/jam lama dibuang');
  assert.equal(env.store.map.has(`pairtry/_globalm/${oldMinute}`), false, 'hitungan global/menit lama dibuang');
  assert.equal(env.store.map.has(`pairtry/1.2.3.4/${freshHour}`), true, 'hitungan < 2 jam dipertahankan');
  assert.equal(env.store.map.has(`pairtry/_global/${freshHour}`), true);
  assert.equal(env.store.map.has(`pairtry/_globalm/${freshMinute}`), true, 'bucket menit berjalan dipertahankan');
  assert.equal([...env.store.map.keys()].some((k) => k.startsWith('reg/')), true, 'sweep tidak menyentuh reg/');
});

test('claim: cap global 120 gagal/MENIT → 429, pulih di menit berikutnya; backstop 3000/jam tetap', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  const minuteKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 16); // 'yyyy-mm-ddThh:mm'
  // 1) Menit berjalan penuh → IP yang belum pernah salah pun kena 429.
  let blocked = null;
  for (let i = 0; i < 3 && !blocked; i++) {
    const minute = minuteKey();
    await env.store.set(`pairtry/_globalm/${minute}`, '120');
    const r = await claimPair(env, { code: wrongCode(i) }, `10.7.7.${i + 1}`);
    if (r.status === 429 && minuteKey() === minute) blocked = r;
  }
  assert.equal(blocked?.status, 429, '120 gagal/menit = 429');
  assert.match(blocked.body.error, /Terlalu banyak/);
  // 2) Pemulihan ≤ 1 menit: menit sebelumnya penuh, menit berjalan kosong → klaim sah diterima lagi.
  await env.store.delete(`pairtry/_globalm/${minuteKey()}`);
  await env.store.set(`pairtry/_globalm/${minuteKey(Date.now() - 60_000)}`, '120');
  const { body: { code } } = await requestPair(env, token);
  assert.equal((await claimPair(env, { code }, '10.8.8.8')).status, 200, 'tidak ada carry-over dari menit lalu');
  // 3) Backstop per jam (3000) tetap berlaku saat menit masih kosong.
  let hourBlocked = null;
  for (let i = 0; i < 3 && !hourBlocked; i++) {
    const hour = hourKeyOf();
    await env.store.set(`pairtry/_global/${hour}`, '3000');
    await env.store.delete(`pairtry/_globalm/${minuteKey()}`);
    const r = await claimPair(env, { code: wrongCode(10 + i) }, `10.9.9.${i + 1}`);
    if (r.status === 429 && hourKeyOf() === hour) hourBlocked = r;
  }
  assert.equal(hourBlocked?.status, 429, 'backstop 3000/jam tetap ada');
});

test('CORS jalan error: 400/401/404 di /api/pair* tanpa ACAO; endpoint lain tetap `*`', async () => {
  const env = makeEnv();
  fakeTuya();
  const cases = [
    ['401 tanpa token', await handleApi(jsonReq('/api/pair', {}), env), 401],
    ['400 code pendek', await handleApi(req('/api/pair/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"pendek"}' }), env), 400],
    ['400 body bukan JSON', await handleApi(req('/api/pair/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'nope' }), env), 400],
    ['404 method salah', await handleApi(req('/api/pair'), env), 404],
    ['404 claim method salah', await handleApi(req('/api/pair/claim'), env), 404],
  ];
  for (const [label, res, status] of cases) {
    assert.equal(res.status, status, label);
    assert.equal(res.headers.get('access-control-allow-origin'), null, `${label}: tanpa ACAO`);
  }
  const other = await handleApi(req('/api/nope', { method: 'POST' }), env);
  assert.equal(other.status, 404);
  assert.equal(other.headers.get('access-control-allow-origin'), '*', 'endpoint lain tidak berubah');
});

test('manage delete & retensi: kode pasangan aktif + referensinya ikut terhapus', async () => {
  const env = makeEnv();
  fakeTuya();
  const deleteForm = (token) => req(`/api/manage?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'delete', confirm: 'HAPUS' }).toString(),
  });
  // (a) dihapus pemiliknya lewat halaman manage
  const a = await doRegister(env, defaultBody(), '3.3.3.3');
  const codeA = (await requestPair(env, a.body.token)).body.code;
  assert.equal((await handleApi(deleteForm(a.body.token), env)).status, 200);
  assert.equal(env.store.map.has(pairHashKey(codeA)), false, 'kode aktif ikut terhapus');
  assert.ok(!(await store.getPairSpaceCode(env, a.body.id)), 'referensi pairSpace ikut terhapus');
  assert.equal((await claimPair(env, { code: codeA })).status, 401, 'kode tidak bisa diklaim lagi');
  // (b) dihapus otomatis oleh sweep retensi
  const b = await doRegister(env, defaultBody(), '4.4.4.4');
  const codeB = (await requestPair(env, b.body.token)).body.code;
  const spaceB = await store.getSpace(env, b.body.id);
  spaceB.createdAt = Date.now() - 31 * 86_400_000; // didaftarkan tapi tak pernah dipakai
  await store.putSpace(env, spaceB);
  const results = await scheduledSweep(env, Date.now());
  assert.ok(results.find((r) => r.id === b.body.id && r.action === 'retention-delete'), 'space dihapus retensi');
  assert.equal(env.store.map.has(pairHashKey(codeB)), false, 'kode aktif space retensi ikut terhapus');
  assert.ok(!(await store.getPairSpaceCode(env, b.body.id)));
});

test('pair: record kode KEDALUWARSA milik space lain boleh ditimpa — referensi lamanya dibersihkan', async () => {
  const env = makeEnv();
  fakeTuya();
  const a = await doRegister(env, defaultBody(), '1.1.1.1');
  const b = await doRegister(env, defaultBody(), '2.2.2.2');
  const stale = 'ZZZZZZZ2';
  await store.putPairCode(env, stale, { spaceId: a.body.id, exp: Date.now() - 1 }); // sudah kedaluwarsa
  await store.putPairSpaceCode(env, a.body.id, store.pairCodeHash(stale)); // referensi "yatim" milik A
  let calls = 0;
  env.makeCode = () => (++calls === 1 ? stale : 'ZZZZZZZ3');
  const r = await requestPair(env, b.body.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.code, stale, 'kode kedaluwarsa dipakai ulang (bukan dianggap tabrakan)');
  assert.equal(JSON.parse(env.store.map.get(pairHashKey(stale))).spaceId, b.body.id, 'sekarang milik space B');
  assert.ok(!(await store.getPairSpaceCode(env, a.body.id)), 'referensi A dibersihkan, tidak menunjuk kode B');
});

test('pair: 503 karena tabrakan TIDAK menghapus kode lama yang masih berlaku', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const first = (await requestPair(env, token)).body.code;
  env.makeCode = () => first; // setiap percobaan "bentrok" dengan kode lama space ini sendiri
  const r = await requestPair(env, token);
  assert.equal(r.status, 503, 'tak ada kode baru setelah 5 percobaan');
  assert.ok(await store.getPairCode(env, first), 'kode lama tetap tersimpan');
  assert.equal(await store.getPairSpaceCode(env, id), pairHash(first), 'referensi tetap menunjuk kode lama');
  assert.equal((await claimPair(env, { code: first })).status, 200, 'kode lama masih bisa diklaim');
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
