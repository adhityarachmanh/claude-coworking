// src/webpush.js: VAPID (RFC 8292) and aes128gcm push encryption (RFC 8291 / RFC 8188), checked against the
// RFCs' own known-answer vectors byte for byte, plus a browser-side decryptor written here from the RFCs.
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';
import { MAX_PLAINTEXT, PUSH_SERVICE_HOSTS, VAPID_SUBJECT, WebPushError, aes128gcm, encrypt, endpointAllowed, ensureVapidKeys, generateVapidKeys, sendPush, subscriptionKeys, vapidAuthorization, vapidJwt } from '../src/webpush.js';

const b = (s) => Buffer.from(s, 'base64url');
const u = (buf) => Buffer.from(buf).toString('base64url');

// RFC 8291 Appendix A (inputs and every intermediate value, verbatim).
const KAT = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  keyInfo: 'V2ViUHVzaDogaW5mbwAEJXGyvs3942BVGq8e0PTNNmwRzr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0EwbZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAvMBKiiujwa7t45ewP',
  prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** The browser's side (RFC 8291 §3 + RFC 8188 §2), independent of the code under test. */
function uaDecrypt(body, uaPrivate, authSecret) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  assert.ok(ciphertext.length <= rs, 'one record');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--; // padding
  assert.equal(record[end], 2, 'last-record delimiter');
  return { plaintext: record.subarray(0, end), paddedLength: record.length, rs };
}

/** A browser subscription with known keys. */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  return { ecdh, auth, keys: { p256dh: u(ecdh.getPublicKey()), auth: u(auth) } };
}

test('RFC 8291 Appendix A: every intermediate value and the final body, byte for byte', () => {
  const { body, debug } = encrypt({ plaintext: KAT.plaintext, p256dh: KAT.uaPublic, auth: KAT.authSecret, salt: b(KAT.salt), asPrivate: b(KAT.asPrivate), padTo: 0 });
  assert.equal(u(debug.asPublic), KAT.asPublic);
  assert.equal(u(debug.ecdhSecret), KAT.ecdhSecret);
  assert.equal(u(debug.keyInfo), KAT.keyInfo);
  assert.equal(u(debug.prk), KAT.prkKey);
  assert.equal(u(debug.ikm), KAT.ikm);
  assert.equal(u(debug.cek), KAT.cek);
  assert.equal(u(debug.nonce), KAT.nonce);
  assert.equal(u(debug.header), KAT.header);
  assert.equal(u(debug.ciphertext), KAT.ciphertext);
  assert.equal(u(body), KAT.body);
  assert.ok(body.equals(Buffer.concat([b(KAT.header), b(KAT.ciphertext)])));
  // and the user agent of the RFC opens it
  assert.equal(String(uaDecrypt(body, b(KAT.uaPrivate), b(KAT.authSecret)).plaintext), KAT.plaintext);
});

test('RFC 8188 §3.1: aes128gcm, one record, rs 4096, empty keyid', () => {
  const { body, header } = aes128gcm({ ikm: b('yqdlZ-tYemfogSmv7Ws5PQ'), salt: b('I1BsxtFttlv3u_Oo94xnmw'), plaintext: Buffer.from('I am the walrus') });
  assert.equal(u(body), 'I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg');
  assert.equal(header.length, 21);
  assert.equal(header.readUInt32BE(16), 4096);
  assert.equal(header[20], 0);
  assert.throws(() => aes128gcm({ ikm: Buffer.alloc(16), salt: Buffer.alloc(15), plaintext: Buffer.alloc(1) }), /salt/);
});

test('round trip with padding to multiples of 256; the largest payload fits 4096 bytes; one byte more is refused', () => {
  const ua = browser();
  for (const size of [0, 1, 255, 256, 1000, MAX_PLAINTEXT]) {
    const plaintext = Buffer.alloc(size, 0x61);
    const { body } = encrypt({ plaintext, ...ua.keys });
    const out = uaDecrypt(body, ua.ecdh.getPrivateKey(), ua.auth);
    assert.ok(out.plaintext.equals(plaintext), `size ${size}`);
    assert.equal(out.rs, 4096);
    assert.ok(body.length <= 4096, `size ${size}: ${body.length}`);
    assert.ok(out.paddedLength % 256 === 0 || out.paddedLength === MAX_PLAINTEXT + 1, `padded ${out.paddedLength}`);
    assert.equal(body.length, 86 + out.paddedLength + 16);
  }
  assert.equal(MAX_PLAINTEXT, 3993);
  // two payloads of different kinds but similar size look the same to the push service
  assert.equal(encrypt({ plaintext: 'x'.repeat(250), ...ua.keys }).body.length, encrypt({ plaintext: 'y'.repeat(10), ...ua.keys }).body.length);
  assert.throws(() => encrypt({ plaintext: Buffer.alloc(MAX_PLAINTEXT + 1), ...ua.keys }), (e) => e instanceof WebPushError && e.code === 'too-large');
  // every message uses a fresh salt and ephemeral key
  const one = encrypt({ plaintext: 'a', ...ua.keys }).body;
  const two = encrypt({ plaintext: 'a', ...ua.keys }).body;
  assert.ok(!one.subarray(0, 86).equals(two.subarray(0, 86)));
});

test('subscription keys are validated: p256dh must be an uncompressed point on P-256, auth 16 bytes', () => {
  const ua = browser();
  assert.doesNotThrow(() => subscriptionKeys(ua.keys.p256dh, ua.keys.auth));
  const point = ua.ecdh.getPublicKey();
  const compressed = u(ua.ecdh.getPublicKey(null, 'compressed')); // 33 bytes
  const offCurve = Buffer.from(point);
  offCurve[64] ^= 1;
  for (const bad of [compressed, u(offCurve), u(point.subarray(0, 64)), u(Buffer.concat([Buffer.from([5]), point.subarray(1)])), 'not base64!', '', 42]) {
    assert.throws(() => subscriptionKeys(bad, ua.keys.auth), (e) => e instanceof WebPushError && e.code === 'bad-subscription', String(bad).slice(0, 20));
  }
  for (const bad of [u(Buffer.alloc(15)), u(Buffer.alloc(17)), undefined]) assert.throws(() => subscriptionKeys(ua.keys.p256dh, bad), WebPushError);
});

test('VAPID: 65-byte public key, ES256 JWT (aud = push service origin, exp within 24 h, sub) verified with crypto.verify', () => {
  const vapid = generateVapidKeys();
  const pub = b(vapid.publicKey);
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 4);
  const now = Date.UTC(2026, 10, 1, 12);
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def';
  const jwt = vapidJwt({ endpoint, vapid, now });
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(b(h)), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(b(c));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, VAPID_SUBJECT);
  assert.equal(claims.sub, 'https://github.com/adhityarachmanh/claude-coworking', 'no email address is sent');
  assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600);
  const sig = b(s);
  assert.equal(sig.length, 64, 'raw r || s');
  // The public key as browsers / push services see it (raw point) verifies the signature.
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: u(pub.subarray(1, 33)), y: u(pub.subarray(33)) }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, sig));
  assert.ok(!verify('sha256', Buffer.from(`${h}.${c}x`), { key, dsaEncoding: 'ieee-p1363' }, sig));
  // cached per push service until an hour before expiry
  assert.equal(vapidJwt({ endpoint: 'https://fcm.googleapis.com/other', vapid, now: now + 60_000 }), jwt);
  assert.notEqual(vapidJwt({ endpoint, vapid, now: now + 11.5 * 3600_000 }), jwt);
  assert.notEqual(vapidJwt({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', vapid, now }), jwt);
  assert.match(vapidAuthorization({ endpoint, vapid, now }), new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`));
  assert.throws(() => vapidJwt({ endpoint, vapid, subject: 'someone@example.com' }), WebPushError);
});

test('VAPID keys: created once in persisted.remote.vapid, reused, and never in a backup', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-vapid-'));
  try {
    const hub = new Hub({ dataDir: dir });
    hub.persisted.remote ??= { enabled: false, devices: [] };
    let saves = 0;
    const keys = ensureVapidKeys(hub.persisted.remote, () => saves++);
    assert.equal(saves, 1);
    assert.equal(ensureVapidKeys(hub.persisted.remote, () => saves++), keys);
    assert.equal(saves, 1);
    assert.ok(keys.privateJwk.d && keys.created);
    const exported = JSON.stringify(hub.exportState());
    assert.ok(!exported.includes(keys.privateJwk.d) && !exported.includes(keys.publicKey), 'not in the backup state');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('endpoint allowlist: only https:443 on FCM, Mozilla autopush, Apple and WNS', () => {
  const ok = [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:443/wp/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGx',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ];
  const bad = [
    'http://fcm.googleapis.com/fcm/send/abc', // not https
    'https://fcm.googleapis.com:8443/x', // other port
    'https://evilfcm.googleapis.com.attacker.net/x',
    'https://fcm.googleapis.com.attacker.net/x',
    'https://notfcm.googleapis.com/x', // whole labels only
    'https://xnotify.windows.com/x',
    'https://192.168.1.10/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://user:pw@fcm.googleapis.com/x',
    'file:///etc/passwd',
    'not a url',
    '',
  ];
  for (const e of ok) assert.ok(endpointAllowed(e), e);
  for (const e of bad) assert.ok(!endpointAllowed(e), e);
  assert.deepEqual([...PUSH_SERVICE_HOSTS], ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com']);
});

test('sendPush: encrypted body + headers through an injected fetch; refuses before sending what it must', async () => {
  const ua = browser();
  const vapid = generateVapidKeys();
  const sent = [];
  const fakeFetch = async (url, init) => {
    sent.push({ url, init });
    return new Response(null, { status: 201 });
  };
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: ua.keys };
  const res = await sendPush(subscription, { v: 1, type: 'ask', title: 'Backend minta izin' }, { vapid, ttl: 1800, urgency: 'high', topic: 'aAbB_-09', fetch: fakeFetch });
  assert.deepEqual(res, { status: 201, ok: true, retryAfter: null });
  const [{ url, init }] = sent;
  assert.equal(url, subscription.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error', 'redirects are never followed (SSRF)');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(init.headers.TTL, '1800');
  assert.equal(init.headers.Urgency, 'high');
  assert.equal(init.headers.Topic, 'aAbB_-09');
  assert.match(init.headers.Authorization, /^vapid t=.+, k=/);
  assert.deepEqual(JSON.parse(uaDecrypt(init.body, ua.ecdh.getPrivateKey(), ua.auth).plaintext), { v: 1, type: 'ask', title: 'Backend minta izin' });
  assert.equal(init.body.length % 256, (86 + 16) % 256, 'padded');

  // the push service's answer is passed back (gone / throttled), never thrown
  const gone = await sendPush(subscription, 'x', { vapid, fetch: async () => new Response('gone', { status: 410 }) });
  assert.deepEqual(gone, { status: 410, ok: false, retryAfter: null });
  const busy = await sendPush(subscription, 'x', { vapid, fetch: async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }) });
  assert.equal(busy.retryAfter, 120);
  await assert.rejects(sendPush(subscription, 'x', { vapid, fetch: async () => { throw new Error('ECONNRESET'); } }), (e) => e.code === 'network');

  // refused before any request
  const before = sent.length;
  const refuse = (sub, opts, code) => assert.rejects(sendPush(sub, 'x', { vapid, fetch: fakeFetch, ...opts }), (e) => e instanceof WebPushError && e.code === code, code);
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://192.168.1.5/push', 'https://fcm.googleapis.com:444/x', 'https://example.com/push', `https://fcm.googleapis.com/${'a'.repeat(1100)}`]) await refuse({ ...subscription, endpoint }, {}, 'endpoint-not-allowed');
  await refuse(subscription, { topic: 'has space' }, 'bad-topic');
  await refuse(subscription, { topic: 'x'.repeat(33) }, 'bad-topic');
  await refuse(subscription, { urgency: 'urgent' }, 'bad-urgency');
  await refuse(subscription, { ttl: -1 }, 'bad-ttl');
  await refuse(subscription, { vapid: null }, 'no-vapid');
  await refuse({ ...subscription, keys: { p256dh: 'AAAA', auth: ua.keys.auth } }, {}, 'bad-subscription');
  assert.equal(sent.length, before, 'nothing was sent');
  // tests may widen the allowlist explicitly (never via env)
  await sendPush({ ...subscription, endpoint: 'https://push.test.example/x' }, 'x', { vapid, fetch: fakeFetch, allowedHosts: ['push.test.example'] });
  assert.equal(sent.length, before + 1);
});
