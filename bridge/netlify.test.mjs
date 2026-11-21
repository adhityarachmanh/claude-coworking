// bridge/netlify.test.mjs — inti jembatan Netlify multi-tenant, pola test lama worker.test.mjs:
// fetch Tuya dan store Blobs difake (driver Map); tanpa jaringan, tanpa runtime Netlify.
// Jalankan: node --test --test-timeout=60000 bridge/
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { after, test } from 'node:test';
import vm from 'node:vm';
import { handleApi, scheduledSweep } from './src/bridge.mjs';
import { readPlugStatus } from './src/tuya.mjs';
import { handleSite } from './src/site.mjs';
import { decryptCreds, decryptSecret, encryptCreds } from './src/vault.mjs';
import * as store from './src/store.mjs';

const CID = 'cid-123';
const SECRET = 'rahasia-tuya-xyz';
const DEVICE = 'dev-1';
const KEY = 'ab'.repeat(32); // ENCRYPTION_KEY 32-byte hex

const calls = [];
let powerW = 45;
let plugOn = true; // keadaan saklar plug di fake: /commands mengubahnya, /status melaporkannya
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

const res = (j) => ({ json: async () => j });
/** Fake Tuya. `opts` membuat kegagalan terkontrol untuk tes validasi kredensial:
 *  tokenRejected (sign/region salah), deviceMissing (token lolos, device tidak ada di project),
 *  notAPlug (tanpa switch_1/switch), networkError (fetch melempar, mis. DNS/timeout), commandFail
 *  (komando plug ditolak), statusPayload (hasil /status kustom — mis. parsing lewat nomor DP `id`). */
const fakeTuya = (opts = {}) => {
  calls.length = 0;
  plugOn = true; // tiap skenario mulai dengan plug ON (fake tidak bicara dengan perangkat sungguhan)
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, method: init?.method ?? 'GET', body, headers: init?.headers ?? {} });
    if (opts.networkError) throw new TypeError('fetch failed'); // seperti DNS mati / AbortSignal.timeout
    if (u.includes('/v1.0/token')) {
      // `goodHost` models the real rule: a Cloud Project's credentials only work in its own data center.
      if (opts.goodHost && !u.includes(opts.goodHost)) return res({ success: false, code: 1004, msg: 'sign invalid' });
      if (opts.tokenRejected) return res({ success: false, code: 1004, msg: 'sign invalid' });
      if (opts.tokenBusy) return res({ success: false, code: 28841002, msg: 'quota limit reached' });
      return res({ success: true, result: { access_token: 'tok-1' } });
    }
    if (u.includes('/commands')) {
      if (!opts.commandFail) plugOn = Boolean(body?.commands?.[0]?.value);
      return res({ success: true, result: true });
    }
    if (u.includes('/status')) {
      if (opts.deviceMissing) return res({ success: false, code: 1106, msg: 'permission deny' });
      if (opts.notAPlug) return res({ success: true, result: [{ code: 'bright_value', value: 10 }] });
      if (opts.statusPayload) return res({ success: true, result: opts.statusPayload });
      // Payload gaya plug Bardi: `cur_power` 0,1 W · `cur_voltage` 0,1 V · `cur_current` mA · `add_ele` 0,01 kWh.
      return res({ success: true, result: [
        { code: 'switch_1', value: plugOn },
        { code: 'cur_power', value: Math.round(powerW * 10) },
        { code: 'cur_voltage', value: 2201 },
        { code: 'cur_current', value: 990 },
        { code: 'add_ele', value: 1234 },
      ] });
    }
    return res({ success: true, result: null });
  };
};
/** Key yang TIDAK boleh ada setelah registrasi gagal validasi (fail closed: tidak boleh ada sisa data). */
const assertNothingStored = (env) => {
  const keys = [...env.store.map.keys()].filter((k) => k.startsWith('space/') || k.startsWith('token/') || k.startsWith('ticket/'));
  assert.deepEqual(keys, [], 'gagal validasi tidak boleh menyimpan space/index/tiket');
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

/** Isi blok HTML server-side (mis. #state / #btns) — bagian yang dilihat pengguna sebelum JS polling jalan.
 *  Dicocokkan per blok karena skrip halaman memang memuat label tombol semua state. */
const blockOf = (html, id) => html.match(new RegExp(`<div[^>]*id="${id}"[^>]*>([\\s\\S]*?)</div>`))?.[1] ?? '';

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

test('handoff: tiket halaman status TANPA jadwal/plug, dan delay disimpan untuk tombol Putus arus', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const h = await statusOf(await handleApi(jsonReq('/api/handoff?delay=90', {}, { 'X-Bridge-Token': token }), env));
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.match(h.body.handoffUrl, new RegExp(`^/s/${id}\\?t=`));
  assert.equal(h.body.offDelaySec, 90);
  assert.deepEqual(cmdValues(), [], 'handoff tidak menyentuh plug');
  let space = await getSpace(env, id);
  assert.equal(space.offAt, null, 'tidak ada jadwal pemutusan');
  assert.equal(space.offDelaySec, 90, 'delay aplikasi diingat halaman');
  assert.ok(await store.getTicket(env, 'h', h.body.handoffUrl.split('t=')[1]), 'tiket serah-terima dibuat');
  // Halaman memakai delay tersimpan saat tombol "Putus arus" ditekan (tanpa ?delay).
  const off = await statusOf(await handleApi(jsonReq('/api/off?hold=1', {}, { 'X-Bridge-Token': token }), env));
  assert.equal(off.status, 200);
  const seconds = Math.ceil((off.body.offAt - Date.now()) / 1000);
  assert.ok(seconds >= 88 && seconds <= 90, `memakai delay 90 dtk (dapat ${seconds})`);
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

test('off?hold=1 ("Putus arus" dari halaman): heartbeat TIDAK membatalkan jadwal, /api/on tetap bisa', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 45;
  const { body: { id, token } } = await doRegister(env);
  const off = await statusOf(await handleApi(req('/api/off?delay=300&hold=1', { method: 'POST', headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(off.status, 200);
  let space = await getSpace(env, id);
  assert.equal(space.offHold, true, 'the schedule is marked as held');
  space.offAtWrittenAt -= 5_000; // like the real 2-minute Adhitron beat arriving after the schedule
  await store.putSpace(env, space);
  await handleApi(jsonReq('/api/heartbeat', {}, { 'X-Bridge-Token': token }), env);
  space = await getSpace(env, id);
  assert.ok(space.offAt, 'a heartbeat no longer cancels the user’s "matikan rapi"');
  // The cron still cuts the power when due — and clears the flag.
  powerW = 0.2;
  assert.deepEqual(await scheduledSweep(env, space.offAt + 500), [{ id, action: 'off', powerW: 0.2 }]);
  space = await getSpace(env, id);
  assert.equal(space.offAt, null);
  assert.equal(space.offHold, false, 'cleared together with the schedule');
  // /api/on still cancels a held schedule explicitly.
  await handleApi(req('/api/off?delay=300&hold=1', { method: 'POST', headers: { 'X-Bridge-Token': token } }), env);
  assert.equal((await getSpace(env, id)).offHold, true);
  // The cron cut above set lastOffAt; rewind it as if the 2-minute cooldown already passed
  // (a fresh cut blocks /api/on — including ?force=1 — see the cooldown tests).
  space = await getSpace(env, id);
  space.lastOffAt = Date.now() - 121_000;
  await store.putSpace(env, space);
  const on = await statusOf(await handleApi(req('/api/on?force=1', { method: 'POST', headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(on.status, 200);
  space = await getSpace(env, id);
  assert.equal(space.offAt, null, 'manual on cancels the schedule');
  assert.equal(space.offHold, false);
});

test('status: a fresh 0 W sample beats an old-but-fresh heartbeat (normal shutdown)', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 0;
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const space = await getSpace(env, id);
  space.lastHeartbeat = now - 60_000; // masih segar (ambang heartbeat 4 mnt), dari tepat sebelum shutdown
  space.powerW = 0;
  space.powerAt = now; // the reading came after the last beat
  space.lastPlug = 'off';
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.body.heartbeatFresh, true);
  assert.equal(st.body.state, 'off', 'the newer measurement wins');
  assert.equal(st.body.alive, false);
  // /api/on is no longer refused: the PC is off and the user may turn it on.
  const on = await statusOf(await handleApi(req('/api/on', { method: 'POST', headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(on.status, 200, JSON.stringify(on.body));

  // Deliberate behaviour change: right after /api/on the page shows the boot window (BOOT_HOLD_MS), not "PC mati",
  // because a 0 W reading may just be the PSU not drawing yet. Only "Putus paksa" is offered meanwhile.
  const page = await handleApi(req(`/s/${id}?token=${token}`), env);
  const html = await page.text();
  assert.match(blockOf(html, 'state'), /sedang booting/);
  const btns = blockOf(html, 'btns');
  assert.equal(btns.includes('Matikan PC rapi'), false, 'no "matikan" button during boot');
  assert.equal(btns.includes('Putus arus listrik'), false, 'no "putus arus" button during boot');
});

test('off?delay=0 right after /api/on ends the boot window: state off, Nyalakan locked by cooldown', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 0;
  const { status: regStatus, body: { id, token } } = await doRegister(env);
  assert.equal(regStatus, 200);
  const on = await statusOf(await handleApi(jsonReq('/api/on?force=1', {}, { 'X-Bridge-Token': token }), env));
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal((await getSpace(env, id)).turnedOnAt > 0, true, 'ON opened a boot window');
  // A real power cut must win over the boot window: the PC cannot be "booting" on a dead plug.
  const cut = await handleApi(req('/api/off?delay=0', { method: 'POST', headers: { 'X-Bridge-Token': token } }), env);
  assert.equal(cut.status, 200);
  const space = await getSpace(env, id);
  assert.equal(space.turnedOnAt, 0, 'boot window cleared by the cut');
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.body.state, 'off', 'not booting after a real cut');
  assert.equal(st.body.alive, false);
  assert.ok(st.body.onCooldownSec > 0, 'the 2-minute cooldown started');
  const html = await (await handleApi(req(`/s/${id}?token=${token}`), env)).text();
  assert.match(blockOf(html, 'btns'), /disabled id="btn-on"/, 'Nyalakan is locked during the cooldown');
});

test('status: even a heartbeat newer than a 0 W sample reads "off" (power evidence wins)', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 0;
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const space = await getSpace(env, id);
  space.lastHeartbeat = now - 30_000;
  space.powerW = 0;
  space.powerAt = now - 60_000; // the beat arrived after the reading
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.body.state, 'off');
  assert.equal(st.body.alive, false);
});

test('POST /api/off/cancel drops a "matikan rapi" schedule without touching the plug', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 45;
  const { body: { id, token } } = await doRegister(env);
  await handleApi(req('/api/off?delay=300&hold=1', { method: 'POST', headers: { 'X-Bridge-Token': token } }), env);
  let space = await getSpace(env, id);
  assert.ok(space.offAt);
  calls.length = 0;
  const cancelled = await statusOf(await handleApi(req('/api/off/cancel', { method: 'POST', headers: { 'X-Bridge-Token': token } }), env));
  assert.deepEqual(cancelled, { status: 200, body: { ok: true, cancelled: true } });
  assert.deepEqual(cmdValues(), [], 'the plug is never cycled to cancel');
  space = await getSpace(env, id);
  assert.equal(space.offAt, null);
  assert.equal(space.offHold, false);
  // The page offers the cancel button while a schedule exists.
  await handleApi(req('/api/off?delay=300&hold=1', { method: 'POST', headers: { 'X-Bridge-Token': token } }), env);
  const html = await (await handleApi(req(`/s/${id}?token=${token}`), env)).text();
  assert.match(blockOf(html, 'btns'), /Batalkan jadwal/);
});

test('register: a temporary Tuya quota/limit is TUYA_BUSY (503), not "Client ID ditolak" (422)', async () => {
  const env = makeEnv();
  fakeTuya({ tokenBusy: true });
  const r = await doRegister(env);
  assert.equal(r.status, 503);
  assert.match(r.body.error, /kuota|limit/i);
  assert.equal([...env.store.map.keys()].filter((k) => k.startsWith('space/')).length, 0);
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

test('/api/status: bentuk kontrak lengkap (state + umur bukti); booting = power tinggi ≥ 30 dtk + heartbeat basi', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 45;
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const space = await getSpace(env, id);
  space.lastHeartbeat = now - 8 * 60_000; // basi: lebih tua dari HEARTBEAT_FRESH_MS (4 mnt)
  space.powerW = 45;
  space.powerAt = now; // sampel segar
  space.powerTryAt = now; // sudah dicoba sekarang → apiStatus tidak memanggil Tuya
  space.powerHighSince = now - 40_000; // power tinggi ≥ 30 dtk
  space.lastPlug = 'on';
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.status, 200);
  assert.deepEqual(Object.keys(st.body).sort(), [
    'adhitronUrl', 'alive', 'booting', 'currentMa', 'energyKwh', 'heartbeatAgeSec', 'heartbeatFresh', 'id',
    'lastHeartbeat', 'lastOffAt', 'needsAttention', 'offAt', 'offDelaySec', 'onCooldownSec', 'plug',
    'powerAgeSec', 'powerAt', 'powerFresh', 'powerW', 'secondsUntilOff', 'state', 'switchOn', 'voltageV',
  ]);
  assert.equal(st.body.alive, true, 'listrik mengalir > ambang boot = PC hidup walau tanpa heartbeat');
  assert.equal(st.body.state, 'booting', 'state eksplisit untuk halaman');
  assert.equal(st.body.booting, true, 'PC beku/booting terdeteksi');
  assert.equal(st.body.heartbeatFresh, false);
  assert.equal(st.body.powerFresh, true);
  assert.ok(st.body.heartbeatAgeSec >= 480 && st.body.heartbeatAgeSec <= 482, `umur heartbeat dalam dtk (${st.body.heartbeatAgeSec})`);
  assert.ok(st.body.powerAgeSec <= 1, 'umur sampel daya ~0 dtk');
  assert.equal(st.body.powerW, 45);
  assert.equal(st.body.plug, 'on');
  assert.equal(st.body.adhitronUrl, 'https://saya.ts.net');
  // sampling dibatasi: poll berikutnya < 30 dtk tidak memanggil Tuya
  calls.length = 0;
  await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env);
  assert.deepEqual(cmdValues(), []);
  assert.equal(calls.filter((c) => c.url.includes('/status')).length, 0, 'kuota Tuya dijaga');
});

// ---------------------------------------------------------------- state PC (heartbeat + bukti daya)

test('regresi: PC mati & plug OFF — heartbeat 20 mnt lalu + daya 0 W segar → state off (bukan "PC hidup")', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 0;
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const space = await getSpace(env, id);
  space.lastHeartbeat = now - 20 * 60_000; // dulu: < 30 mnt → alive=true (bug)
  space.powerW = 0;
  space.powerAt = now; // bukti listrik: benar-benar 0 W
  space.powerTryAt = now;
  space.powerHighSince = null;
  space.lastPlug = 'off';
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.status, 200);
  assert.equal(st.body.state, 'off');
  assert.equal(st.body.alive, false, 'heartbeat 20 mnt bukan bukti PC hidup');
  assert.equal(st.body.heartbeatFresh, false);
  assert.equal(st.body.powerFresh, true);
  assert.equal(st.body.booting, false);
  const page = await handleApi(req(`/s/${id}?token=${token}`), env);
  assert.equal(page.status, 200);
  const html = await page.text();
  // Halaman yang dilihat pengguna sebelum JS polling: state + tombol server-side.
  assert.match(blockOf(html, 'state'), /PC mati/, 'bukan "PC hidup"');
  assert.equal(blockOf(html, 'state').includes('PC hidup'), false);
  assert.equal(blockOf(html, 'btns').includes('Matikan PC rapi'), false, 'tidak ada tombol shutdown dari halaman');
  assert.match(blockOf(html, 'btns'), /Nyalakan PC/);
  assert.match(blockOf(html, 'btns'), /Putus arus listrik/, 'PC sudah mati: putus arus Bardi opsional dari sini');
});

test('status: daya 45 W segar + heartbeat basi → suspected-alive (< 30 dtk), lalu booting (≥ 30 dtk); tombol hanya Putus paksa', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 45;
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const base = await getSpace(env, id);
  base.lastHeartbeat = now - 8 * 60_000; // basi
  base.powerW = 45;
  base.powerAt = now;
  base.powerTryAt = now;
  base.powerHighSince = now - 5_000; // < BOOT_DETECT_MS
  base.lastPlug = 'on';
  await store.putSpace(env, base);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.body.state, 'suspected-alive', 'daya ada tapi belum cukup lama = belum pasti booting');
  assert.equal(st.body.alive, true, 'listrik mengalir = PC dianggap hidup walau Adhitron tidak berkabar');
  assert.equal(st.body.booting, false);
  assert.equal(st.body.heartbeatFresh, false);
  const page = await handleApi(req(`/s/${id}?token=${token}`), env);
  const html = await page.text();
  assert.match(blockOf(html, 'state'), /kemungkinan hidup/);
  assert.match(blockOf(html, 'btns'), /Putus paksa/);
  assert.equal(blockOf(html, 'btns').includes('Putus arus listrik'), false, 'state belum pasti: jangan tawarkan putus arus biasa');
  // ≥ 30 dtk daya tinggi tanpa heartbeat → booting/beku
  const older = await getSpace(env, id);
  older.powerHighSince = now - 40_000;
  older.powerTryAt = Date.now();
  await store.putSpace(env, older);
  const boot = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(boot.body.state, 'booting');
  assert.equal(boot.body.booting, true);
});

test('status: switch_1 OFF dari plug menang atas heartbeat segar → off (arus bisa diputus dari aplikasi Bardi)', async () => {
  const env = makeEnv();
  fakeTuya({ statusPayload: [{ code: 'switch_1', value: false }, { code: 'cur_power', value: 0 }] });
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const space = await getSpace(env, id);
  space.lastHeartbeat = now - 30_000; // masih segar (< 4 mnt) — bukti saklar tetap menang
  space.powerTryAt = 0; // /api/status mengambil sampel nyata dari plug
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.body.switchOn, false);
  assert.equal(st.body.state, 'off');
  assert.equal(st.body.alive, false);
  assert.equal(st.body.plug, 'off', 'lastPlug ikut switch_1, bukan hanya perintah dari bridge');
});

test('status: cur_power 124 (12,4 W) → standby + hanya tombol Putus paksa (bukan "PC hidup")', async () => {
  const env = makeEnv();
  fakeTuya({ statusPayload: [{ code: 'switch_1', value: true }, { code: 'cur_power', value: 124 }] });
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const space = await getSpace(env, id);
  space.lastHeartbeat = now - 30_000; // segar: 10–15 W tetap standby (bukan bukti PC hidup)
  space.powerTryAt = 0;
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.body.powerW, 12.4, 'cur_power adalah 0,1 W → 12,4 W');
  assert.equal(st.body.state, 'standby');
  assert.equal(st.body.alive, false);
  const html = await (await handleApi(req(`/s/${id}?token=${token}`), env)).text();
  assert.match(blockOf(html, 'state'), /Standby/);
  assert.match(blockOf(html, 'btns'), /Putus paksa/);
  assert.equal(blockOf(html, 'btns').includes('Putus arus listrik'), false, 'standby tidak menawarkan putus arus biasa');
});

test('status: cur_power 450 (45 W) + heartbeat segar → alive', async () => {
  const env = makeEnv();
  fakeTuya({ statusPayload: [{ code: 'switch_1', value: true }, { code: 'cur_power', value: 450 }] });
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const space = await getSpace(env, id);
  space.lastHeartbeat = now - 30_000;
  space.powerTryAt = 0;
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.body.powerW, 45);
  assert.equal(st.body.switchOn, true);
  assert.equal(st.body.state, 'alive');
  assert.equal(st.body.alive, true);
});

test('status: plug tercatat OFF + offAt null + heartbeat 20 mnt → off (walau belum ada sampel daya)', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const space = await getSpace(env, id);
  space.lastHeartbeat = now - 20 * 60_000;
  space.lastPlug = 'off';
  space.offAt = null;
  space.powerW = null; // tanpa sensor daya / belum pernah disampel
  space.powerAt = 0;
  space.powerTryAt = now; // jangan sampling saat tes
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.body.state, 'off');
  assert.equal(st.body.alive, false);
  assert.equal(st.body.powerFresh, false);
});

test('status: sampel daya basi (10 mnt) + heartbeat basi → unknown (bukan tebakan "mati")', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const space = await getSpace(env, id);
  space.lastHeartbeat = now - 20 * 60_000;
  space.powerW = 45;
  space.powerAt = now - 10 * 60_000; // > POWER_FRESH_MS (90 dtk)
  space.powerTryAt = now; // sampling di-throttle: bukti lama tetap diperiksa apa adanya
  space.powerHighSince = now - 20 * 60_000;
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.body.state, 'unknown');
  assert.equal(st.body.alive, false);
  assert.equal(st.body.powerFresh, false);
  assert.equal(st.body.booting, false);
  assert.ok(st.body.powerAgeSec >= 600);
  const html = await (await handleApi(req(`/s/${id}?token=${token}`), env)).text();
  assert.match(blockOf(html, 'state'), /Status belum pasti/);
  assert.match(blockOf(html, 'btns'), /Nyalakan paksa/);
});

test('status: sampel GAGAL dimodelkan — pembacaan Tuya gagal TIDAK membuat powerAt segar (umur null/ tetap basi)', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const space = await getSpace(env, id);
  space.lastHeartbeat = 0;
  space.powerW = null;
  space.powerAt = 0;
  space.powerTryAt = 0; // belum pernah dicoba → apiStatus akan mencoba
  await store.putSpace(env, space);
  fakeTuya({ networkError: true }); // Tuya tidak bisa dihubungi
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.status, 200);
  assert.equal(st.body.state, 'unknown');
  assert.equal(st.body.powerAt, null, 'tidak ada sampel: powerAt tetap kosong (bukan diisi waktu percobaan)');
  assert.equal(st.body.powerAgeSec, null, 'belum ada sampel → umur null');
  assert.equal(st.body.heartbeatAgeSec, null, 'belum pernah heartbeat → umur null');
  const after = await getSpace(env, id);
  assert.equal(after.powerAt, 0, 'powerAt tidak dimajukan saat gagal');
  assert.ok(after.powerTryAt > 0, 'percobaan sampling tetap di-throttle lewat powerTryAt');
  // Kegagalan berikutnya dalam < 30 dtk tidak memanggil Tuya lagi.
  calls.length = 0;
  await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env);
  assert.equal(calls.length, 0, 'kuota Tuya dijaga saat gagal');
});

test('/api/on: PC masih hidup → 409 TANPA memanggil Tuya; ?force=1 menyiklus OFF → ON', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const space = await getSpace(env, id);
  space.lastHeartbeat = now - 60_000; // segar (< 4 mnt)
  space.powerTryAt = now;
  await store.putSpace(env, space);
  calls.length = 0;
  const r = await statusOf(await handleApi(jsonReq('/api/on', {}, { 'X-Bridge-Token': token }), env));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /masih hidup/);
  assert.deepEqual(cmdValues(), [], 'penolakan tidak mengirim komando');
  assert.equal(calls.length, 0, 'penolakan tidak memanggil Tuya sama sekali (termasuk token)');
  assert.equal((await getSpace(env, id)).lastPlug, null, 'record tidak diubah oleh penolakan');
  // Bukti daya juga menahan: heartbeat basi tapi listrik masih mengalir.
  const byPower = await getSpace(env, id);
  byPower.lastHeartbeat = 0;
  byPower.powerW = 45;
  byPower.powerAt = Date.now();
  byPower.powerTryAt = Date.now();
  await store.putSpace(env, byPower);
  assert.equal((await statusOf(await handleApi(jsonReq('/api/on', {}, { 'X-Bridge-Token': token }), env))).status, 409, 'daya tinggi segar = masih hidup');
  // ?force=1 → siklus OFF → ON (fake: switch_1 sudah ON).
  const forced = await statusOf(await handleApi(jsonReq('/api/on?force=1', {}, { 'X-Bridge-Token': token }), env));
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.deepEqual(cmdValues(), [false, true], 'force menyiklus listrik');
  assert.equal((await getSpace(env, id)).lastPlug, 'on');
});

// ---------------------------------------------------------------- jeda 2 menit setelah pemutusan + realtime

test('cooldown: setelah off?delay=0, status membawa lastOffAt/onCooldownSec dan POST /api/on → 409 tanpa memanggil Tuya', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  const off = await statusOf(await handleApi(jsonReq('/api/off?delay=0', {}, { 'X-Bridge-Token': token }), env));
  assert.equal(off.status, 200);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.ok(st.body.lastOffAt > 0, 'waktu listrik benar-benar diputus dicatat');
  assert.ok(st.body.onCooldownSec > 0 && st.body.onCooldownSec <= 120, `jeda 2 menit (dapat ${st.body.onCooldownSec})`);
  // Sisa daya di PSU harus habis dulu: berlaku juga untuk ?force=1 (fisik, bukan sekadar pengaman).
  calls.length = 0;
  const raw = await handleApi(jsonReq('/api/on', {}, { 'X-Bridge-Token': token }), env);
  const body = await raw.json();
  assert.equal(raw.status, 409, JSON.stringify(body));
  assert.ok(body.retryAfterSec > 0 && body.retryAfterSec <= 120, `sisa detik di body (${body.retryAfterSec})`);
  assert.match(body.error, /tunggu/i);
  assert.equal(raw.headers.get('retry-after'), String(body.retryAfterSec), 'header Retry-After ikut dikirim');
  for (const path of ['/api/on', '/api/on?force=1']) {
    const r = await statusOf(await handleApi(jsonReq(path, {}, { 'X-Bridge-Token': token }), env));
    assert.equal(r.status, 409, `${path} tetap ditolak selama cooldown`);
    assert.ok(r.body.retryAfterSec > 0, `${path} membawa retryAfterSec`);
  }
  assert.deepEqual(cmdValues(), [], 'tidak ada komando ke plug');
  assert.equal(calls.length, 0, 'penolakan cooldown tidak memanggil Tuya sama sekali');
});

test('cooldown: setelah 2 menit lewat (lastOffAt dimundurkan) POST /api/on diterima dan sampel lama dibuang', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  await handleApi(jsonReq('/api/off?delay=0', {}, { 'X-Bridge-Token': token }), env);
  const space = await getSpace(env, id);
  space.lastOffAt = Date.now() - 121_000;
  await store.putSpace(env, space);
  const before = Date.now();
  const r = await statusOf(await handleApi(jsonReq('/api/on', {}, { 'X-Bridge-Token': token }), env));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await getSpace(env, id);
  assert.ok(after.turnedOnAt >= before, 'turnedOnAt dicatat saat perintah ON berhasil');
  assert.equal(after.powerW, null, 'sampel daya lama (0 W) dibuang');
  assert.equal(after.powerAt, 0, 'powerAt direset');
  assert.equal(after.powerTryAt, 0, 'sampel berikutnya langsung boleh dicoba');
  assert.equal(after.lastPlug, 'on');
});

test('on: sampel 0 W lama dibuang — status setelah menyalakan adalah booting, bukan off', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 0;
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  let space = await getSpace(env, id);
  space.lastHeartbeat = now - 20 * 60_000; // PC sudah mati lama: tidak ada kabar
  space.powerW = 0;
  space.powerAt = now; // sampel 0 W segar → status "off"
  space.powerTryAt = now;
  space.switchOn = null;
  space.lastPlug = 'off';
  await store.putSpace(env, space);
  const before = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(before.body.state, 'off');
  assert.equal((await statusOf(await handleApi(jsonReq('/api/on', {}, { 'X-Bridge-Token': token }), env))).status, 200);
  space = await getSpace(env, id);
  assert.equal(space.powerW, null, 'sampel lama dibuang oleh /api/on');
  assert.equal(space.powerAt, 0);
  fakeTuya({ networkError: true }); // Tuya sesaat tidak terbaca: jangan jatuh ke "off" karena sampel lama
  const after = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(after.body.state, 'booting', 'jendela booting, bukan off');
  assert.equal(after.body.alive, false);
  assert.equal(after.body.powerAgeSec, null, 'tidak ada sampel daya lama yang dipakai');
});

test('cron: pemutusan yang berhasil menulis lastOffAt (jeda berlaku untuk jadwal cron juga)', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 0.2;
  const { body: { id, token } } = await doRegister(env);
  await handleApi(jsonReq('/api/off?delay=60', {}, { 'X-Bridge-Token': token }), env);
  const scheduled = await getSpace(env, id);
  const now = scheduled.offAt + 500;
  assert.deepEqual(await scheduledSweep(env, now), [{ id, action: 'off', powerW: 0.2 }]);
  const after = await getSpace(env, id);
  assert.equal(after.lastOffAt, now, 'waktu pemutusan tercatat di record');
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.ok(st.body.lastOffAt > 0, 'status membawa lastOffAt');
  assert.equal(st.body.onCooldownSec != null, true, 'status membawa onCooldownSec');
});

test('status: heartbeat 3 menit tanpa bukti daya → suspected-alive, tombol Putus arus hilang, /api/on tetap 409', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  const space = await getSpace(env, id);
  space.lastHeartbeat = now - 180_000; // 3 mnt: masih "fresh" (< 4 mnt) tapi lewat ambang hidup 2,5 mnt
  space.powerW = null;
  space.powerAt = 0;
  space.powerTryAt = now; // jangan sampling: murni uji tangga heartbeat
  space.switchOn = true;
  space.lastPlug = 'on';
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.body.heartbeatFresh, true, 'kontrak lama: heartbeatFresh tetap 4 mnt');
  assert.equal(st.body.state, 'suspected-alive');
  // alive tetap true: pengaman /api/on tidak boleh melemah untuk PC yang mungkin masih hidup.
  assert.equal(st.body.alive, true);
  const html = await (await handleApi(req(`/s/${id}?token=${token}`), env)).text();
  assert.match(blockOf(html, 'state'), /kemungkinan hidup/);
  assert.equal(blockOf(html, 'btns').includes('Putus arus listrik'), false, 'tombol putus arus hilang');
  assert.match(blockOf(html, 'btns'), /Putus paksa/);
  // Tanpa ?force=1 /api/on menolak: status "mungkin hidup" tetap dilindungi dari siklus listrik.
  calls.length = 0;
  const on = await statusOf(await handleApi(jsonReq('/api/on', {}, { 'X-Bridge-Token': token }), env));
  assert.equal(on.status, 409, JSON.stringify(on.body));
  assert.match(on.body.error, /masih hidup/);
  assert.deepEqual(cmdValues(), [], 'penolakan tidak menyentuh plug');
});

test('halaman status: polling 5 dtk + tombol Nyalakan terkunci hitung mundur selama cooldown 2 menit', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  await handleApi(jsonReq('/api/off?delay=0', {}, { 'X-Bridge-Token': token }), env);
  const html = await (await handleApi(req(`/s/${id}?token=${token}`), env)).text();
  assert.match(html, /bootMode \? 2000 : 5000/, 'poll /api/status tiap 5 dtk (2 dtk saat booting)');
  const btns = blockOf(html, 'btns');
  assert.match(btns, /<button class="btn on" type="button" disabled id="btn-on">⚡ Nyalakan PC \(\d:\d\d\)<\/button>/, 'tombol nyalakan terkunci + hitung mundur, dengan id stabil');
  assert.equal(btns.includes('onclick="nyalakan()"'), false, 'tombol nyalakan tidak bisa diklik saat cooldown');
  assert.match(btns, /Tunggu 2 menit setelah listrik diputus agar sisa daya di komputer habis\./);
  assert.match(blockOf(html, 'proof'), /Bukti: heartbeat .* · daya /, 'baris umur bukti tampil');
  assert.match(html, /setInterval\(cooldownTick, 1000\)/, 'hitung mundur berjalan tiap detik di klien');
});

test('realtime: sampel daya dibatasi 10 dtk — dua GET /api/status berurutan memanggil Tuya sekali', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  fakeTuya(); // jendela bersih: hanya panggilan dari rute di bawah yang dihitung
  const statusCalls = () => calls.filter((c) => c.url.includes(`/devices/${DEVICE}/status`)).length;
  const first = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(statusCalls(), 1, 'sampel pertama mengambil satu device status');
  await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env);
  assert.equal(statusCalls(), 1, 'poll berikutnya dalam < 10 dtk tidak memanggil Tuya lagi');
  let space = await getSpace(env, id);
  space.powerTryAt = Date.now() - 9_000;
  await store.putSpace(env, space);
  await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env);
  assert.equal(statusCalls(), 1, '9 dtk belum lewat: tetap di-throttle');
  space = await getSpace(env, id);
  space.powerTryAt = Date.now() - 11_000;
  await store.putSpace(env, space);
  await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env);
  assert.equal(statusCalls(), 2, '≥ 10 dtk: sampel berikutnya diambil');
});

test('on: sampel Tuya 0 W yang BERHASIL sesudah ON tetap "booting" (bukan off), tanpa cooldown baru', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 0;
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  let space = await getSpace(env, id);
  space.lastHeartbeat = now - 20 * 60_000; // PC sudah mati lama: tidak ada kabar
  space.powerW = 0;
  space.powerAt = now;
  space.powerTryAt = now;
  space.switchOn = null;
  space.lastPlug = 'off';
  await store.putSpace(env, space);
  assert.equal((await statusOf(await handleApi(jsonReq('/api/on', {}, { 'X-Bridge-Token': token }), env))).status, 200);
  // Sampel NYATA (bukan networkError) yang masih 0 W: beberapa detik pertama sesudah plug ON, PSU belum menarik daya.
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.status, 200);
  assert.equal(st.body.state, 'booting', 'jendela 45 dtk mengalahkan bacaan 0 W');
  assert.equal(st.body.alive, false);
  assert.equal(st.body.powerFresh, true, 'sampelnya memang segar — bukan bukti yang hilang');
  assert.equal(st.body.onCooldownSec, null, 'siklus ON sendiri bukan pemutusan');
  space = await getSpace(env, id);
  assert.equal(space.lastOffAt ?? null, null, 'tidak ada lastOffAt baru dari sampel 0 W');
});

test('on: setelah jendela 45 dtk lewat, sampel 0 W kembali membaca off', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 0;
  const { body: { id, token } } = await doRegister(env);
  const now = Date.now();
  let space = await getSpace(env, id);
  space.lastHeartbeat = now - 20 * 60_000;
  space.powerW = 0;
  space.powerAt = now;
  space.powerTryAt = now;
  space.switchOn = null;
  space.lastPlug = 'off';
  await store.putSpace(env, space);
  assert.equal((await statusOf(await handleApi(jsonReq('/api/on', {}, { 'X-Bridge-Token': token }), env))).status, 200);
  space = await getSpace(env, id);
  space.turnedOnAt = Date.now() - 46_000; // jendela boot sudah lewat
  space.powerW = null;
  space.powerAt = 0;
  space.powerTryAt = 0; // biarkan sampel nyata diambil
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.status, 200);
  assert.equal(st.body.powerW, 0, 'sampel 0 W benar-benar terbaca');
  assert.equal(st.body.state, 'off', 'sesudah jendela, bukti listrik yang menang');
  assert.equal(st.body.alive, false);
});

test('samplePower: transisi eksternal switchOn true→false menulis lastOffAt; null→false tidak', async () => {
  // (1) plug yang tercatat ON dimatikan dari aplikasi Bardi/Smart Life: transisi nyata → cooldown mulai.
  const env = makeEnv();
  fakeTuya({ statusPayload: [{ code: 'switch_1', value: false }, { code: 'cur_power', value: 0 }] });
  const a = await doRegister(env);
  let space = await getSpace(env, a.body.id);
  space.switchOn = true; // saklar terakhir diketahui ON (dari perintah bridge)
  space.lastPlug = 'on';
  space.powerTryAt = 0;
  await store.putSpace(env, space);
  const before = Date.now();
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': a.body.token } }), env));
  assert.equal(st.body.state, 'off');
  space = await getSpace(env, a.body.id);
  assert.ok(space.lastOffAt >= before, `transisi true→false mencatat lastOffAt (${space.lastOffAt})`);
  assert.ok(st.body.onCooldownSec > 0, 'jeda 2 menit langsung berlaku');
  // (2) record yang belum pernah membaca saklar (null) + plug ternyata OFF: BUKAN pemutusan (bisa data lama berjam-jam).
  const env2 = makeEnv();
  fakeTuya({ statusPayload: [{ code: 'switch_1', value: false }, { code: 'cur_power', value: 0 }] });
  const b = await doRegister(env2);
  const st2 = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': b.body.token } }), env2));
  assert.equal(st2.status, 200);
  const space2 = await getSpace(env2, b.body.id);
  assert.equal(space2.switchOn, false, 'saklar tetap dibaca apa adanya');
  assert.equal(space2.lastOffAt ?? null, null, 'null→false tidak memulai cooldown');
  assert.equal(st2.body.onCooldownSec, null);
});

test('record lama tanpa lastOffAt/turnedOnAt/cyclingUntil: status tidak error dan onCooldownSec null', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const space = await getSpace(env, id);
  delete space.lastOffAt;      // field baru: belum ada di record produksi
  delete space.turnedOnAt;
  delete space.cyclingUntil;
  space.powerTryAt = Date.now(); // cukup uji pembacaan record: jangan sampling
  await store.putSpace(env, space);
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.status, 200);
  assert.equal(st.body.state, 'unknown');
  assert.equal(st.body.alive, false);
  assert.equal(st.body.lastOffAt, null);
  assert.equal(st.body.onCooldownSec, null, 'tanpa lastOffAt tidak ada jeda');
  assert.equal((await statusOf(await handleApi(jsonReq('/api/on', {}, { 'X-Bridge-Token': token }), env))).status, 200, 'field yang hilang tidak mengunci /api/on');
});

test('on: siklus OFF→ON sendiri tidak memicu cooldown (sampel switch_1=false saat cyclingUntil aktif)', async () => {
  const env = makeEnv();
  fakeTuya({ statusPayload: [{ code: 'switch_1', value: false }, { code: 'cur_power', value: 0 }] });
  const { body: { id, token } } = await doRegister(env);
  await handleApi(jsonReq('/api/off?delay=0', {}, { 'X-Bridge-Token': token }), env);
  let space = await getSpace(env, id);
  const cutAt = Date.now() - 121_000;
  space.lastOffAt = cutAt; // jeda 2 menit sudah lewat: /api/on boleh
  space.powerTryAt = 0;
  await store.putSpace(env, space);
  assert.equal((await statusOf(await handleApi(jsonReq('/api/on', {}, { 'X-Bridge-Token': token }), env))).status, 200);
  space = await getSpace(env, id);
  assert.ok(space.cyclingUntil > Date.now(), 'on() menjaga jendela siklus plug');
  // Sampel menyusul dan melaporkan saklar OFF (sisa komunikasi selama siklus) — bukan pemutusan oleh pengguna.
  const st = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(st.status, 200);
  space = await getSpace(env, id);
  assert.equal(space.lastOffAt, cutAt, 'lastOffAt tidak ditimpa oleh siklus sendiri');
  assert.equal(space.switchOn, false, 'sampel tetap dicatat apa adanya');
});

// ---------------------------------------------------------------- validasi kredensial sebelum simpan (fail closed)

test('register: kredensial dicek READ-ONLY ke Tuya (token + status, TANPA /commands) sebelum space dibuat', async () => {
  const env = makeEnv();
  fakeTuya();
  const { status, body } = await doRegister(env);
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(await getSpace(env, body.id), 'space tersimpan setelah validasi lolos');
  assert.equal(calls.filter((c) => c.url.includes('/v1.0/token')).length, 1, 'token diminta sekali');
  assert.equal(calls.filter((c) => c.url.includes(`/devices/${DEVICE}/status`)).length, 1, 'device dicek read-only');
  assert.deepEqual(cmdValues(), [], 'validasi tidak pernah mengirim komando');
});

test('register: token/region ditolak Tuya → 422; tidak ada space/token/tiket tersimpan', async () => {
  const env = makeEnv();
  fakeTuya({ tokenRejected: true });
  const r = await doRegister(env);
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.match(r.body.error, /Client ID\/Secret atau region ditolak Tuya\./);
  assertNothingStored(env);
  assert.equal([...env.store.map.keys()].some((k) => k.startsWith('reg/1.2.3.4/')), true, 'hitungan throttle tetap jalan (sebelum validasi)');
});

test('register: device tidak ada di project / bukan smart plug → 422 dengan pesan spesifik', async () => {
  const env = makeEnv();
  fakeTuya({ deviceMissing: true });
  let r = await doRegister(env);
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.match(r.body.error, /Device ID tidak ada di project ini/);
  assertNothingStored(env);
  fakeTuya({ notAPlug: true });
  r = await doRegister(env, defaultBody(), '6.6.6.6');
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.match(r.body.error, /bukan smart plug/);
  assertNothingStored(env);
});

test('register: Tuya tidak bisa dihubungi (jaringan/timeout) → 503; tidak ada yang tersimpan', async () => {
  const env = makeEnv();
  fakeTuya({ networkError: true });
  const r = await doRegister(env);
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.match(r.body.error, /Tidak bisa menghubungi Tuya Cloud/);
  assertNothingStored(env);
});

test('manage update: kredensial ditolak Tuya → 400; ciphertext + URL lama utuh dan tetap bisa didekripsi', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  const before = await getSpace(env, id);
  fakeTuya({ deviceMissing: true });
  const r = await statusOf(await handleApi(req(`/api/manage?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      action: 'update', tuyaClientId: 'cid-baru', tuyaClientSecret: 'secret-baru',
      tuyaDeviceId: 'dev-2', tuyaRegion: 'asia', adhitronUrl: 'https://ganti.ts.net',
    }).toString(),
  }), env));
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /Device ID tidak ada di project ini/);
  const after = await getSpace(env, id);
  assert.equal(after.enc.ct, before.enc.ct, 'tidak ada penulisan kredensial');
  assert.equal(after.adhitronUrl, before.adhitronUrl, 'URL lama dipertahankan');
  const creds = decryptCreds(decryptSecret(KEY, after.ownerTokenEnc), KEY, after.enc);
  assert.equal(creds.tuyaClientSecret, SECRET, 'secret lama masih bisa didekripsi');
  assert.equal(creds.tuyaClientId, CID);
});

test('error validasi tidak pernah memuat Client ID/Secret/Device ID', async () => {
  const env = makeEnv();
  for (const [i, opts] of [{ tokenRejected: true }, { deviceMissing: true }, { notAPlug: true }, { networkError: true }].entries()) {
    fakeTuya(opts);
    const body = {
      tuyaClientId: 'CID-RAHASIA-XYZ', tuyaClientSecret: 'SECRET-RAHASIA-XYZ',
      tuyaDeviceId: 'DEVID-RAHASIA-XYZ', tuyaRegion: 'eu',
    };
    const r = await doRegister(env, body, `4.5.6.${i + 1}`);
    const text = JSON.stringify(r.body);
    assert.equal(r.status >= 400, true, JSON.stringify(opts));
    assert.equal(text.includes('RAHASIA'), false, `error ${JSON.stringify(opts)} membocorkan kredensial: ${text}`);
  }
});

test('register: cap GLOBAL 300 verifikasi/hari → 503 sebelum Tuya dipanggil, tidak ada space', async () => {
  const env = makeEnv();
  fakeTuya();
  const day = new Date().toISOString().slice(0, 10);
  await env.store.set(`verify/${day}`, '300');
  const r = await doRegister(env, defaultBody(), '9.9.9.9');
  assert.equal(r.status, 503);
  assert.match(r.body.error, /Batas verifikasi harian/);
  assert.equal(calls.length, 0, 'no Tuya call once the daily cap is reached');
  assert.equal([...env.store.map.keys()].filter((k) => k.startsWith('space/')).length, 0, 'nothing stored');
});

test('/api/on: a Tuya error is answered with a stable message, never raw upstream JSON', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  fakeTuya({ tokenRejected: true });
  const on = await statusOf(await handleApi(req('/api/on?force=1', { method: 'POST', headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(on.status, 502);
  assert.equal(on.body.error, 'Client ID/Secret atau region ditolak Tuya.');
  assert.equal(JSON.stringify(on.body).includes('"success"'), false, 'no upstream JSON leaked');
  assert.equal(cmdValues().length, 0, 'no command was sent');
});

test('register: region yang salah dideteksi otomatis (7 data center) dan yang benar disimpan', async () => {
  const env = makeEnv();
  fakeTuya({ goodHost: 'openapi-weaz.tuyaeu.com' }); // the project lives in Western Europe
  const r = await doRegister(env, { ...defaultBody(), tuyaRegion: 'eu' }); // the user picked Central Europe
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const space = await getSpace(env, r.body.id);
  const creds = decryptCreds(r.body.token, KEY, space.enc);
  assert.equal(creds.tuyaRegion, 'eu-west', 'the detected data center is what gets stored');
  // A second registration with the now-correct region needs no detection round.
  fakeTuya({ goodHost: 'openapi-weaz.tuyaeu.com' });
  const again = await doRegister(env, { ...defaultBody(), tuyaRegion: 'eu-west' }, '7.7.7.7');
  assert.equal(again.status, 200);
  assert.equal(calls.filter((c) => c.url.includes('/v1.0/token')).length, 1, 'one token call when the region is right');
});

test('register: region salah dan kredensial memang salah → 422, tetap tanpa data', async () => {
  const env = makeEnv();
  fakeTuya({ goodHost: 'tidak-ada.tuya.invalid' });
  const r = await doRegister(env, { ...defaultBody(), tuyaRegion: 'asia' });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /Client ID\/Secret atau region/);
  assert.equal([...env.store.map.keys()].filter((k) => k.startsWith('space/')).length, 0);
});

test('halaman: ketujuh data center Tuya tampil di form register & manage', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  const home = await (await handleApi(req('/'), env)).text();
  for (const region of ['eu', 'eu-west', 'america', 'us-east', 'asia', 'india', 'singapore']) {
    assert.match(home, new RegExp(`value="${region}"`), `register: ${region}`);
  }
  const manage = await (await handleApi(req(`/manage?token=${token}`), env)).text();
  assert.match(manage, /value="eu"\s+selected/, 'the saved region stays selected');
});

test('signature Tuya: header `t`, token memakai hash body kosong, command memakai hash body-nya', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const mac = (text) => createHmac('sha256', SECRET).update(text).digest('hex').toUpperCase();
  const tokenCall = calls.find((c) => c.url.includes('/v1.0/token'));
  const statusCall = calls.find((c) => c.url.includes('/status'));
  assert.ok(tokenCall.headers.t, 'header `t` dikirim (Tuya membacanya, bukan `timestamp`)');
  assert.equal(tokenCall.headers.t, tokenCall.headers.timestamp, 'keduanya sama untuk gateway lama');
  const urlPart = (path) => `\n\n${path}`;
  assert.equal(tokenCall.headers.sign, mac(CID + tokenCall.headers.t + 'GET\n' + sha('') + urlPart('/v1.0/token?grant_type=1')), 'token: body kosong + URL token');
  assert.equal(statusCall.headers.t, statusCall.headers.timestamp);
  assert.equal(statusCall.headers.sign, mac(CID + 'tok-1' + statusCall.headers.t + 'GET\n' + sha('') + urlPart(`/v1.0/devices/${DEVICE}/status`)), 'status: GET tanpa body + path');

  calls.length = 0;
  const off = await statusOf(await handleApi(req('/api/off?delay=0', { method: 'POST', headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(off.status, 200, JSON.stringify(off.body));
  const command = calls.find((c) => c.url.includes('/commands'));
  assert.ok(command, 'perintah OFF dikirim');
  const commandBody = JSON.stringify(command.body);
  assert.equal(command.headers.sign, mac(CID + 'tok-1' + command.headers.t + 'POST\n' + sha(commandBody) + urlPart(`/v1.0/devices/${DEVICE}/commands`)), 'command: hash body JSON + path');
});

test('GET /api/energy: monitoring realtime dari SATU device status (IoT Core gratis) + cache 5 dtk', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 237;
  const { body: { token } } = await doRegister(env);
  fakeTuya(); // register made its own calls; start the energy window clean
  const r = await statusOf(await handleApi(req('/api/energy?range=year&tz=Asia/Jakarta', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, {
    ok: true,
    now: { powerW: 237, voltageV: 220.1, currentMa: 990 },
    switchOn: true,
    energyKwh: 12.34,
    updatedAt: r.body.updatedAt,
  });
  assert.ok(Number.isFinite(r.body.updatedAt));
  // Hanya SATU panggilan device status: tanpa statistik Power Management (berbayar) dan tanpa argumen range.
  assert.equal(calls.filter((c) => c.url.includes('/status')).length, 1, 'satu panggilan device status');
  assert.deepEqual(cmdValues(), [], 'read-only: tidak ada perintah ke plug');
  calls.length = 0;
  const again = await statusOf(await handleApi(req('/api/energy', { headers: { 'X-Bridge-Token': token } }), env));
  assert.deepEqual(again.body, r.body, 'cache 5 dtk: jawaban sama');
  assert.equal(calls.length, 0, 'cache menahan kuota Tuya (tidak poll terus-menerus)');
});

test('GET /api/energy: Tuya gagal → ok:false pesan generik (tanpa kode/JSON upstream), status tetap hidup', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body: { id, token } } = await doRegister(env);
  fakeTuya({ deviceMissing: true });
  const r = await statusOf(await handleApi(req('/api/energy', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.deepEqual(Object.keys(r.body).sort(), ['error', 'ok'], 'kontrak error: hanya ok + error');
  assert.doesNotMatch(r.body.error, /1106|kode Tuya|permission|Client ID|Secret|JSON/i);
  const status = await statusOf(await handleApi(req('/api/status', { headers: { 'X-Bridge-Token': token } }), env));
  assert.equal(status.status, 200, 'kegagalan listrik tidak merusak status');
  const page = await handleApi(req(`/s/${id}?token=${token}`), env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Listrik Bardi/);
});

test('Tuya: tidak ada satu pun panggilan ke endpoint statistik energi berbayar (penyebab 28841101)', async () => {
  // Regresi untuk keluhan "Statistik energi belum tersedia dari Tuya … (kode Tuya 28841101)". Akun ini hanya punya
  // paket IoT Core gratis: endpoint Power Management (/v1.0/iot-03/energy/...) harus NOL panggilan, dari rute mana pun.
  const env = makeEnv();
  fakeTuya();
  const { body: { token } } = await doRegister(env);
  fakeTuya(); // jendela bersih: hanya panggilan dari rute di bawah yang diperiksa
  for (const path of ['/api/status', '/api/energy']) {
    const r = await statusOf(await handleApi(req(path, { headers: { 'X-Bridge-Token': token } }), env));
    assert.equal(r.status, 200, `${path} tetap melayani`);
  }
  assert.ok(calls.length > 0, 'rute di atas memang memanggil Tuya (kalau tidak, tes ini tidak membuktikan apa pun)');
  const offenders = calls.filter(({ url }) => /\/iot-03\/energy|\/energy\/electricity|\/statistics/i.test(new URL(url).pathname));
  assert.deepEqual(offenders.map((c) => c.url), [], 'endpoint statistik energi tidak boleh dipanggil');
  const allowed = new Set(['/v1.0/token', `/v1.0/devices/${DEVICE}/status`]);
  for (const { url } of calls) assert.ok(allowed.has(new URL(url).pathname), `endpoint tak terduga: ${url}`);
});

test('readPlugStatus: parsing lewat nomor DP (`id`) tanpa `code` — saklar, daya, tegangan, arus, kWh', async () => {
  fakeTuya({ statusPayload: [
    { id: 1, value: true },
    { id: 19, value: 124 },
    { id: 20, value: 2201 },
    { id: 18, value: 990 },
    { id: 17, value: 1234 },
  ] });
  const cfg = { region: 'eu', clientId: CID, clientSecret: SECRET, deviceId: DEVICE };
  assert.deepEqual(await readPlugStatus(cfg), {
    switchOn: true, powerW: 12.4, voltageV: 220.1, currentMa: 990, energyKwh: 12.34,
  });
  assert.equal(calls.filter((c) => c.url.includes('/status')).length, 1, 'satu panggilan device status (IoT Core)');
});

test('readPlugStatus: field opsional hilang → null (tidak melempar); `switch` dipakai bila `switch_1` absen', async () => {
  const cfg = { region: 'eu', clientId: CID, clientSecret: SECRET, deviceId: DEVICE };
  fakeTuya({ statusPayload: [{ code: 'switch', value: false }] });
  assert.deepEqual(await readPlugStatus(cfg), {
    switchOn: false, powerW: null, voltageV: null, currentMa: null, energyKwh: null,
  }, 'plug tanpa sensor daya: saklar terbaca, metering null');
  fakeTuya({ statusPayload: [] });
  assert.deepEqual(await readPlugStatus(cfg), {
    switchOn: null, powerW: null, voltageV: null, currentMa: null, energyKwh: null,
  }, 'tidak ada DP sama sekali pun tidak boleh membuat pembacaan gagal');
});

// ---------------------------------------------------------------- halaman

test('halaman: register di /, manage, status — tanpa membocorkan kredensial', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 0; // PC mati: state 'off' → tombol Nyalakan PC
  const { body: { id, token } } = await doRegister(env);
  const home = await handleApi(req('/'), env);
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /Daftar/);
  assert.match(homeHtml, /terenkripsi/, 'pemberitahuan privasi tampil');
  assert.match(homeHtml, /Kredensial dicek langsung ke Tuya Cloud sebelum disimpan/, 'catatan validasi kredensial di halaman register');
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
  assert.match(manageHtml, /Perubahan dicek ke Tuya dulu/, 'catatan validasi di halaman manage');
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

test('halaman status: skrip state-machine (tombol per state + 409) valid dan tidak meninggalkan interpolasi', async () => {
  const env = makeEnv();
  fakeTuya();
  powerW = 0;
  const { body: { id, token } } = await doRegister(env);
  const html = await (await handleApi(req(`/s/${id}?token=${token}`), env)).text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'satu blok skrip di halaman status');
  assert.equal(scripts[0].includes('${'), false, 'tidak ada sisa interpolasi template');
  assert.doesNotThrow(() => new vm.Script(scripts[0]), 'skrip halaman status harus valid');
  assert.match(scripts[0], /\/api\/on\?force=1/, 'state unknown memakai ?force=1');
  assert.match(scripts[0], /r\.ok/, 'penolakan server (409) diperiksa, bukan diabaikan');
  assert.match(scripts[0], /flash = r\.error/, 'pesan error server ditampilkan di halaman');
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

// ---------------------------------------------------------------- portal + mount '/bridge'

test('portal: root menampilkan dua pintu (Chat & Remote Power) tanpa membocorkan kredensial', async () => {
  const r = handleSite(req('/'));
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /href="\/chat"/, 'pintu Chat menuju /chat');
  assert.match(html, /href="\/bridge"/, 'pintu Remote Power menuju /bridge');
  assert.match(html, /API key milikmu sendiri/, 'menjelaskan key milik user');
  assert.equal(handleSite(req('/halaman-asing')), null, 'path tak dikenal diserahkan ke pemanggil (404)');
  const chat = await handleSite(req('/chat')).text();
  assert.match(chat, /💬 Chat/, 'kerangka chat ada');
  assert.match(chat, /id="f-login"/, 'form masuk');
  assert.match(chat, /\/chat\/app\.js/, 'memuat skrip aplikasi chat');
  assert.match(chat, /id="composer"/, 'komposer pesan ada');
  assert.match(chat, /id="convs"/, 'sidebar riwayat ada');
  const app = handleSite(req('/chat/app.js'));
  assert.equal(app.status, 200, 'app.js tersedia');
  assert.match(app.headers.get('content-type') || '', /javascript/);
  const appText = await app.text();
  assert.doesNotThrow(() => new vm.Script(appText), 'skrip aplikasi chat harus valid');
  assert.equal(handleSite(req('/chat/app.js', { method: 'POST' })), null, 'app.js hanya GET');
  const priv = handleSite(req('/privasi'));
  assert.equal(priv.status, 200, '/privasi ada');
  assert.match(await priv.text(), /Kebijakan Privasi/);
  const tos = handleSite(req('/syarat'));
  assert.equal(tos.status, 200, '/syarat ada');
  assert.match(await tos.text(), /Syarat Layanan/);
  assert.equal(handleSite(req('/syarat', { method: 'POST' })), null, 'POST ke /syarat bukan rute');
});

test('mount /bridge: rute jembatan sama seperti di root, tapi URL yang diterbitkan berprefiks /bridge', async () => {
  const env = { ...makeEnv(), basePath: '/bridge' };
  fakeTuya();
  // Halaman daftar jembatan melayani '/bridge' (prefix dipangkas) dan tautan internalnya berprefiks.
  const page = await handleApi(req('/bridge'), env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /href="\/bridge\/"/, 'brand menunjuk ke mount');
  assert.match(html, /fetch\('\/bridge\/api\/space'/, 'form daftar memanggil API berprefiks');
  // Register lewat mount: payload menerbitkan bridgeUrl/statusUrl/manageUrl berprefiks '/bridge'.
  const reg = await statusOf(await handleApi(req('/bridge/api/space', {
    method: 'POST',
    headers: { 'x-nf-client-connection-ip': '1.2.3.4', 'Content-Type': 'application/json' },
    body: JSON.stringify(defaultBody()),
  }), env));
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.bridgeUrl, 'https://bridge.test/bridge', 'URL jembatan untuk panel Adhitron berprefiks');
  assert.match(reg.body.statusUrl, /^\/bridge\/s\/[0-9a-f]{8}$/);
  assert.match(reg.body.manageUrl, /^\/bridge\/manage\?token=[0-9a-f]{64}$/);
  // Halaman manage berprefiks tetap memvalidasi token (route + action berprefiks).
  const manage = await handleApi(req(`/bridge/manage?token=${reg.body.token}`), env);
  assert.equal(manage.status, 200);
  assert.match(await manage.text(), /action="\/bridge\/api\/manage\?token=/, 'form manage memakai action berprefiks');
});

test('mount root (basePath kosong) tetap byte-identik: rute & URL tanpa prefiks', async () => {
  const env = makeEnv();
  fakeTuya();
  const { body } = await doRegister(env);
  assert.equal(body.bridgeUrl, 'https://bridge.test', 'tanpa prefiks saat basePath kosong');
  assert.match(body.statusUrl, /^\/s\//);
  assert.match(body.manageUrl, /^\/manage\?token=/);
});
