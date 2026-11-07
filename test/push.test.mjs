// 🔔 Web Push policy (src/push.js) and its routes (src/routes/push.js), against a fake push service injected through
// the constructor (never env): it captures every encrypted request, which the test decrypts with the browser's own
// private key to check what a phone would actually show. No network, no server process.
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hub } from '../src/hub.js';
import { ACT_TTL_MS, LOCKSCREEN_SAFE_TOOLS, PUSH_SPEC, PushService, VISIBLE_TTL_MS, parseSettings, parseSubscription, phoneClock, wifiApproval } from '../src/push.js';
import { RemoteAccess } from '../src/remote.js';
import { buildRouter } from '../src/routes/index.js';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const u = (buf) => Buffer.from(buf).toString('base64url');

/** A browser's push subscription with known keys (so the test can decrypt like the browser does). */
function browser(host = 'fcm.googleapis.com') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from(Array.from({ length: 16 }, (_, i) => i * 7));
  const endpoint = `https://${host}/fcm/send/${u(ecdh.getPublicKey()).slice(0, 24)}`;
  return { ecdh, auth, subscription: { endpoint, keys: { p256dh: u(ecdh.getPublicKey()), auth: u(auth) } } };
}

/** RFC 8291 + RFC 8188 on the receiving side, independent of src/webpush.js. */
function decrypt(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  let end = record.length - 1;
  while (record[end] === 0) end--;
  assert.equal(record[end], 2, 'last-record delimiter');
  return { payload: JSON.parse(record.subarray(0, end).toString('utf8')), padded: record.length };
}

/** The fake push service: records requests; `reply[endpoint]` = status (or { status, retryAfter }), default 201. */
function fakePushService() {
  const sent = [];
  const reply = {};
  const fetch = async (endpoint, { headers, body }) => {
    sent.push({ endpoint, headers, body });
    const r = reply[endpoint] ?? 201;
    const { status, retryAfter } = typeof r === 'number' ? { status: r } : r;
    return { status, headers: new Headers(retryAfter ? { 'retry-after': String(retryAfter) } : {}), body: null };
  };
  return { sent, reply, fetch };
}

test('history: recent sends are persisted in data/push-history.json and survive a restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-push-'));
  dirs.push(dir);
  const hub = new Hub({ dataDir: dir });
  const make = () => new PushService({ hub, remote: new RemoteAccess(hub), dataDir: dir, log: () => {}, warn: () => {} });
  const a = make();
  a.record({ type: 'ask', project: 'p1', projectName: 'toko', role: 'QA', devices: ['Pixel'] });
  const b = make();
  assert.deepEqual(
    b.historyView().map((e) => [e.type, e.projectName, e.role, e.devices]),
    [['ask', 'toko', 'QA', ['Pixel']]],
    'loaded from disk after a restart',
  );
  for (let i = 0; i < 40; i += 1) b.record({ type: 'done', project: 'p1', projectName: 'toko', role: 'Lead', devices: [] });
  const c = make();
  assert.equal(c.historyView().length, 30, 'capped at 30, newest first');
  assert.equal(c.historyView()[0].type, 'done');
  assert.equal(existsSync(path.join(dir, 'push-history.json')), true);
});

const SETTINGS = Object.freeze({ events: { ask: { popup: true, sound: true }, done: { popup: true, sound: true }, error: { popup: true, sound: false } }, quiet: { enabled: false, from: '22:00', to: '07:00', allowAsk: true }, favoritesOnly: false, tzOffsetMin: 420, lockscreenAllow: true });

/** A hub with one project, phone access on, and a PushService wired to the fake push service. */
function setup({ now = Date.parse('2026-11-02T05:00:00Z') } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-push-'));
  dirs.push(dir);
  const hub = new Hub({ dataDir: dir });
  hub.projects.set('p1', { id: 'p1', name: 'toko-online', path: '/x/toko-online', sources: ['folder'] });
  hub.projects.set('p2', { id: 'p2', name: 'blog', path: '/x/blog', sources: ['folder'] });
  hub.ready = true;
  const remote = new RemoteAccess(hub);
  remote.state.enabled = true;
  const clock = { now };
  const svc = fakePushService();
  const streams = new Set();
  const changes = [];
  const logs = [];
  const queue = {};
  const push = new PushService({ hub, remote, fetch: svc.fetch, now: () => clock.now, hasStream: (id) => streams.has(id), queueSummary: (id) => queue[id] ?? null, onChange: () => changes.push(1), log: (m) => logs.push(m), warn: (m) => logs.push(m) });
  hub.observers.add((type, data) => push.observe(type, data));
  const addDevice = (name, { transport = 'https', settings = SETTINGS, host } = {}) => {
    const device = { id: `dev-${name}`, hash: `h-${name}`, name, created: clock.now, lastSeen: clock.now, transport };
    remote.state.devices.push(device);
    const b = browser(host);
    if (settings) push.subscribe(device, { subscription: b.subscription, settings });
    return { device, browser: b };
  };
  /** The decrypted pushes sent to one device's endpoint. */
  const inbox = (phone) => svc.sent.filter((r) => r.endpoint === phone.browser.subscription.endpoint).map((r) => ({ ...decrypt(r.body, phone.browser), headers: r.headers, size: r.body.length }));
  return { hub, remote, push, svc, clock, streams, changes, logs, queue, addDevice, inbox };
}

const ask = (hub, id = 'ap1', extra = {}) => {
  const decisions = [];
  hub.requestApproval('p1', { id, chatId: null, role: 'backend', kind: 'tool', tool: 'Edit', label: '$ rm -rf C:/Users/adhit/secret --token=abc', description: 'hapus', input: { command: 'rm -rf C:/Users/adhit/secret' }, ...extra }, (d) => decisions.push(d));
  return decisions;
};

// ---------- validation ----------

test('subscribe validation: endpoint allowlist, key sizes, settings shape', () => {
  const ok = browser().subscription;
  assert.deepEqual(parseSubscription(ok), { endpoint: ok.endpoint, p256dh: ok.keys.p256dh, auth: ok.keys.auth });
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://192.168.1.5/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://u:p@fcm.googleapis.com/x', `https://fcm.googleapis.com/${'a'.repeat(1100)}`, 42, undefined]) {
    assert.throws(() => parseSubscription({ ...ok, endpoint }), { status: 400 }, String(endpoint).slice(0, 60));
  }
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  for (const keys of [{ ...ok.keys, p256dh: u(ecdh.getPublicKey(null, 'compressed')) }, { ...ok.keys, p256dh: u(Buffer.alloc(65, 4)) }, { ...ok.keys, auth: u(Buffer.alloc(15)) }, { ...ok.keys, auth: 'not base64!' }, {}, { p256dh: 'x'.repeat(300), auth: ok.keys.auth }]) {
    assert.throws(() => parseSubscription({ ...ok, keys }), { status: 400 });
  }

  const s = parseSettings({ ...SETTINGS, favorites: ['p1'], tz: 'Asia/Jakarta' });
  assert.equal(s.tzOffsetMin, 420);
  assert.equal(s.tz, 'Asia/Jakarta');
  assert.equal(s.lockscreenAllow, true);
  assert.equal('favorites' in s, false, 'the server uses its own favourites list');
  assert.equal(parseSettings({ ...SETTINGS, tz: 'Mars/Olympus' }).tz, undefined, 'unknown zone: offset only');
  assert.deepEqual(parseSettings({ tzOffsetMin: 0, events: { done: false } }).events.done, { popup: false, sound: false }, 'boolean shorthand');
  for (const bad of [null, [], 'x', { ...SETTINGS, tzOffsetMin: undefined }, { ...SETTINGS, tzOffsetMin: 7.5 }, { ...SETTINGS, tzOffsetMin: 900 }, { ...SETTINGS, quiet: { from: '25:00' } }, { ...SETTINGS, lockscreenAllow: 'yes' }, { ...SETTINGS, events: [] }, { ...SETTINGS, favorites: 'p1' }, { ...SETTINGS, enabled: 1 }]) {
    assert.throws(() => parseSettings(bad), { status: 400 }, JSON.stringify(bad));
  }
});

test('subscription lives on the device record: publicInfo has no endpoint/keys, revoke removes it, one endpoint = one device', () => {
  const { remote, push, addDevice } = setup();
  const a = addDevice('Android · Chrome');
  assert.equal(a.device.push.endpoint, a.browser.subscription.endpoint);
  assert.ok(remote.state.vapid?.publicKey, 'VAPID keys made on first subscribe');
  const info = JSON.stringify(remote.publicInfo(4317));
  assert.ok(!info.includes(a.browser.subscription.endpoint) && !info.includes(a.browser.subscription.keys.auth), 'publicInfo leaks nothing');
  assert.equal(remote.publicInfo(4317).devices[0].push.lastOk, null);
  assert.deepEqual(push.clientInfo(a.device), { subscribed: true, settings: a.device.push.settings });

  // The same browser paired again as another device record: only the newest keeps the subscription.
  const b = { id: 'dev-new', hash: 'h-new', name: 'Android · Chrome', created: Date.now(), lastSeen: Date.now(), transport: 'https' };
  remote.state.devices.push(b);
  push.subscribe(b, { subscription: a.browser.subscription, settings: SETTINGS });
  assert.equal(a.device.push, undefined);
  assert.ok(b.push);

  remote.revoke('dev-new');
  assert.equal(remote.state.devices.some((d) => d.push), false, 'gone with the record');
  assert.throws(() => push.updateSettings(a.device, { settings: SETTINGS }), { status: 409 });
});

// ---------- events → pushes ----------

test('permission request: urgency high, TTL ~10 min, opaque Topic per project, minimal padded payload with an action token', async () => {
  const { hub, push, svc, addDevice, inbox, remote } = setup();
  const phone = addDevice('Android · Chrome');
  const off = addDevice('Pixel · Chrome', { settings: { ...SETTINGS, lockscreenAllow: false } });
  ask(hub);
  await push.idle();
  const [msg] = inbox(phone);
  assert.equal(msg.headers.Urgency, 'high');
  assert.equal(msg.headers.TTL, String(PUSH_SPEC.ask.ttl));
  assert.ok(PUSH_SPEC.ask.ttl >= 300 && PUSH_SPEC.ask.ttl <= 900);
  assert.match(msg.headers.Topic, /^a[A-Za-z0-9_-]{20}$/);
  assert.ok(!msg.headers.Topic.includes('p1'), 'Topic is opaque');
  assert.equal(msg.headers['Content-Encoding'], 'aes128gcm');
  assert.match(msg.headers.Authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${remote.state.vapid.publicKey}$`));
  assert.equal(msg.padded % 256, 0, 'padded to a multiple of 256 bytes');
  assert.ok(msg.size <= 4096);
  const p = msg.payload;
  assert.equal(p.type, 'ask');
  assert.equal(p.project, 'p1');
  assert.equal(p.projectName, 'toko-online');
  assert.equal(p.role, 'Adhit - Backend');
  assert.equal(p.label, 'Edit', 'tool name only');
  assert.equal(p.approvalId, 'ap1');
  assert.match(p.t, /^[\w-]{43}$/);
  assert.equal(p.allowAllowed, true);
  assert.equal(p.silent, false);
  assert.equal(p.pending, 1);
  const text = JSON.stringify(p);
  for (const secret of ['rm -rf', 'C:/Users', 'secret', 'token=', '$ ', 'hapus']) assert.ok(!text.includes(secret), `payload has no "${secret}"`);
  assert.equal(inbox(off)[0].payload.allowAllowed, false, 'lockscreenAllow false: Tolak only');
  assert.equal(svc.sent.length, 2);

  // Same Topic for the same project, another one for another project.
  hub.requestApproval('p2', { id: 'ap2', role: 'qa', kind: 'question', tool: 'AskUserQuestion', label: 'Pilih database?' }, () => {});
  await push.idle();
  const q = inbox(phone)[1];
  assert.notEqual(q.headers.Topic, msg.headers.Topic);
  assert.equal(q.payload.label, 'Pertanyaan');
  assert.equal(q.payload.t, '', 'no action token for a question');
  assert.ok(!JSON.stringify(q.payload).includes('database'));
});

test('turn done / error / queue paused: urgency, TTL and Topic per type; no error text; queue edge-triggered', async () => {
  const { hub, push, addDevice, inbox, queue } = setup();
  const phone = addDevice('Android · Chrome');
  hub.chat('p1', { kind: 'result', ok: true, text: '' });
  hub.chat('p1', { kind: 'result', ok: false, text: 'Error: ENOENT C:/Users/adhit/secret.txt' });
  hub.chat('p1', { kind: 'error', text: 'Claude Code berhenti (exit 1) C:/path' });
  hub.chat('p1', { kind: 'assistant', text: 'halo' });
  await push.idle();
  const got = inbox(phone);
  assert.deepEqual(got.map((m) => m.payload.type), ['done', 'error', 'error']);
  assert.deepEqual(got.map((m) => [m.headers.Urgency, m.headers.TTL]), [['normal', '900'], ['normal', '3600'], ['normal', '3600']]);
  assert.match(got[0].headers.Topic, /^d/);
  assert.match(got[1].headers.Topic, /^e/);
  assert.equal(got[1].payload.silent, true, 'error sound off in this phone\'s settings');
  for (const m of got) assert.ok(!JSON.stringify(m.payload).includes('C:/'), 'no error text or path');

  queue.p1 = { paused: true, reason: 'failed' };
  hub.broadcast('queue', { project: 'p1', rev: 1 });
  hub.broadcast('queue', { project: 'p1', rev: 2 }); // still the same pause: no second push
  queue.p1 = { paused: true, reason: 'user' };
  hub.broadcast('queue', { project: 'p1', rev: 3 }); // paused by the user: never pushed
  queue.p1 = { paused: false, reason: null };
  hub.broadcast('queue', { project: 'p1', rev: 4 });
  queue.p1 = { paused: true, reason: 'budget' };
  hub.broadcast('queue', { project: 'p1', rev: 5 });
  await push.idle();
  const queued = inbox(phone).filter((m) => m.payload.type === 'queue');
  assert.equal(queued.length, 2);
  assert.match(queued[0].headers.Topic, /^q/);
  assert.equal(queued[0].payload.label, 'Ada tugas yang gagal');

  // A pause already there at start (seedQueues) is not news; "Antrian dijeda" follows the error toggle.
  const fresh = setup();
  const p2 = fresh.addDevice('X', { settings: { ...SETTINGS, events: { ...SETTINGS.events, error: { popup: false, sound: false } } } });
  fresh.queue.p1 = { paused: true, reason: 'restart' };
  fresh.push.seedQueues(['p1']);
  fresh.hub.broadcast('queue', { project: 'p1' });
  fresh.queue.p2 = { paused: true, reason: 'failed' };
  fresh.hub.broadcast('queue', { project: 'p2' });
  await fresh.push.idle();
  assert.equal(fresh.inbox(p2).length, 0);
});

test('quiet hours are evaluated in the phone\'s timezone; ask passes with allowAsk', async () => {
  // 16:30 UTC: 23:30 in Jakarta (quiet 22:00–07:00), 16:30 in London.
  const { hub, push, addDevice, inbox } = setup({ now: Date.parse('2026-11-02T16:30:00Z') });
  const quiet = { enabled: true, from: '22:00', to: '07:00', allowAsk: true };
  const jakarta = addDevice('Jakarta', { settings: { ...SETTINGS, quiet, tzOffsetMin: 420 } });
  const london = addDevice('London', { settings: { ...SETTINGS, quiet, tzOffsetMin: 0 } });
  const zone = addDevice('Zone', { settings: { ...SETTINGS, quiet, tzOffsetMin: 0, tz: 'Asia/Jakarta' } }); // IANA wins
  const strict = addDevice('Strict', { settings: { ...SETTINGS, quiet: { ...quiet, allowAsk: false }, tzOffsetMin: 420 } });
  hub.chat('p1', { kind: 'result', ok: true });
  ask(hub);
  await push.idle();
  assert.deepEqual(inbox(jakarta).map((m) => m.payload.type), ['ask']);
  assert.deepEqual(inbox(zone).map((m) => m.payload.type), ['ask']);
  assert.deepEqual(inbox(london).map((m) => m.payload.type), ['done', 'ask']);
  assert.deepEqual(inbox(strict).map((m) => m.payload.type), []);
  const c = phoneClock({ tzOffsetMin: -300 }, Date.parse('2026-11-02T03:15:00Z'));
  assert.deepEqual([c.getHours(), c.getMinutes()], [22, 15]);
});

test('favorites only (the server\'s favourites), 🔔 off on the phone, phone access off', async () => {
  const { hub, push, remote, addDevice, inbox } = setup();
  const fav = addDevice('Fav', { settings: { ...SETTINGS, favoritesOnly: true } });
  const off = addDevice('Off', { settings: { ...SETTINGS, enabled: false } });
  hub.persisted.favorites = ['p2'];
  hub.chat('p1', { kind: 'result', ok: true });
  hub.chat('p2', { kind: 'result', ok: true });
  await push.idle();
  assert.deepEqual(inbox(fav).map((m) => m.payload.project), ['p2']);
  assert.equal(inbox(off).length, 0);
  remote.state.enabled = false;
  hub.chat('p2', { kind: 'result', ok: true });
  await push.idle();
  assert.equal(inbox(fav).length, 1, 'nothing is pushed while phone access is off');
});

test('no push to a device while one of its pages is visible (open stream + recent report)', async () => {
  const { hub, push, clock, streams, addDevice, inbox } = setup();
  const phone = addDevice('Android · Chrome');
  const other = addDevice('Tablet');
  push.setVisible(phone.device.id, 'tab1', true);
  hub.chat('p1', { kind: 'result', ok: true });
  await push.idle();
  assert.equal(inbox(phone).length, 1, 'visible report without an open stream: the page is gone');
  streams.add(phone.device.id);
  hub.chat('p1', { kind: 'result', ok: true });
  ask(hub);
  await push.idle();
  assert.equal(inbox(phone).length, 1, 'visible page: it alerts itself');
  assert.equal(inbox(other).length, 3, 'other devices still get theirs');
  clock.now += VISIBLE_TTL_MS + 1000;
  hub.chat('p1', { kind: 'result', ok: true });
  await push.idle();
  assert.equal(inbox(phone).length, 2, 'a stale report (no refresh) counts as hidden');
  push.setVisible(phone.device.id, 'tab1', true);
  push.setVisible(phone.device.id, 'tab1', false);
  hub.chat('p1', { kind: 'result', ok: true });
  await push.idle();
  assert.equal(inbox(phone).length, 3, 'hidden again');
  assert.throws(() => push.setVisible(phone.device.id, 'bad tab!', true), { status: 400 });
  assert.throws(() => push.setVisible(phone.device.id, 't', 'yes'), { status: 400 });
});

test('push service answers: 410/404 drop the subscription, 429 backs off, 3× 403 drop it, failures logged without the endpoint', async () => {
  const { hub, push, svc, clock, addDevice, changes, logs } = setup();
  const gone = addDevice('Gone');
  const busy = addDevice('Busy');
  const bad = addDevice('Bad');
  svc.reply[gone.browser.subscription.endpoint] = 410;
  svc.reply[busy.browser.subscription.endpoint] = { status: 429, retryAfter: 120 };
  svc.reply[bad.browser.subscription.endpoint] = 403;
  const before = changes.length;
  hub.chat('p1', { kind: 'result', ok: true });
  await push.idle();
  assert.equal(gone.device.push, undefined, '410: subscription deleted');
  assert.ok(changes.length > before, '📱 updated');
  assert.ok(busy.device.push, '429: kept');
  const sentTo = (phone) => svc.sent.filter((r) => r.endpoint === phone.browser.subscription.endpoint).length;
  hub.chat('p1', { kind: 'result', ok: true });
  await push.idle();
  assert.equal(sentTo(busy), 1, 'backing off: nothing sent during Retry-After');
  assert.equal(sentTo(gone), 1, 'a deleted subscription gets nothing');
  clock.now += 121_000;
  delete svc.reply[busy.browser.subscription.endpoint];
  hub.chat('p1', { kind: 'result', ok: true });
  await push.idle();
  assert.equal(sentTo(busy), 2, 'sent again after Retry-After');
  assert.ok(busy.device.push.lastOk);
  assert.equal(bad.device.push, undefined, 'dropped after 3 refusals');
  assert.equal(sentTo(bad), 3);
  const log = logs.join('\n');
  for (const p of [gone, busy, bad]) assert.ok(!log.includes(p.browser.subscription.endpoint) && !log.includes(p.browser.subscription.keys.auth), 'no endpoint/keys in the log');
  assert.match(log, /Gone/);
});

// ---------- actions ----------

test('act: allow resolves once (single use → 409 with the final state), other phones get "answered", the laptop sees answeredBy', async () => {
  const { hub, push, addDevice, inbox, logs } = setup();
  const phone = addDevice('Android · Chrome');
  const tablet = addDevice('Tablet');
  const events = [];
  hub.observers.add((type, data) => type === 'approval' && events.push(structuredClone(data)));
  const decisions = ask(hub);
  await push.idle();
  const t = inbox(phone)[0].payload.t;
  assert.notEqual(t, inbox(tablet)[0].payload.t, 'one token per device');
  assert.equal([...push.tokens.keys()].some((k) => k === t), false, 'stored hashed, never the token itself');

  const ok = push.act({ device: phone.device, t, a: 'allow', ip: '100.64.0.9' });
  assert.deepEqual(ok, { status: 200, body: { ok: true, status: 'allowed' } });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].allow, true);
  assert.equal(decisions[0].always, undefined, 'never "selalu"');
  assert.deepEqual(events.at(-1).answeredBy, { via: 'push', device: 'Android · Chrome' });
  assert.deepEqual(wifiApproval(events.at(-1)).answeredBy, { via: 'push' }, 'no phone name over WiFi');
  assert.match(logs.join('\n'), /diizinkan dari HP "Android · Chrome"/);
  await push.idle();
  assert.equal(inbox(phone).length, 1, 'the answering phone gets no "answered" push');
  const [, answered] = inbox(tablet);
  assert.equal(answered.payload.type, 'answered');
  assert.equal(answered.payload.approvalId, 'ap1');
  assert.equal(answered.payload.silent, true);
  assert.equal(answered.headers.Topic, inbox(tablet)[0].headers.Topic, 'same Topic as the ask');

  assert.deepEqual(push.act({ device: phone.device, t, a: 'allow' }), { status: 409, body: { status: 'allowed' } }, 'single use');
  const tabletToken = inbox(tablet)[0].payload.t;
  assert.deepEqual(push.act({ device: tablet.device, t: tabletToken, a: 'deny' }), { status: 409, body: { status: 'allowed' } }, 'answered elsewhere: its token died with it');
  assert.equal(decisions.length, 1);
});

test('act: answered on the laptop → "answered" push and 409; expiry; wrong device; lockscreenAllow false; deny; bad input; rate limit', async () => {
  const { hub, push, clock, addDevice, inbox } = setup();
  const phone = addDevice('Android · Chrome');
  const thief = addDevice('Other');
  const locked = addDevice('Locked', { settings: { ...SETTINGS, lockscreenAllow: false } });

  ask(hub, 'a1');
  await push.idle();
  hub.resolveApproval('a1', { allow: false }); // on the laptop
  await push.idle();
  assert.equal(inbox(phone).at(-1).payload.type, 'answered');
  assert.equal(inbox(phone).at(-1).payload.status, 'denied');
  assert.deepEqual(push.act({ device: phone.device, t: inbox(phone)[0].payload.t, a: 'allow' }), { status: 409, body: { status: 'denied' } });

  const d2 = ask(hub, 'a2');
  await push.idle();
  const t2 = inbox(phone).at(-1).payload.t;
  assert.equal(push.act({ device: thief.device, t: t2, a: 'allow' }).status, 403, 'bound to the device');
  assert.equal(push.act({ device: phone.device, t: t2, a: 'allow' }).status, 410, 'and burnt by the attempt');
  assert.equal(d2.length, 0);

  ask(hub, 'a3');
  await push.idle();
  const t3 = inbox(phone).at(-1).payload.t;
  clock.now += ACT_TTL_MS + 1;
  assert.equal(push.act({ device: phone.device, t: t3, a: 'allow' }).status, 410, 'expired after 15 min');
  clock.now += 1;

  const d4 = ask(hub, 'a4');
  await push.idle();
  const t4 = inbox(locked).at(-1).payload.t;
  assert.equal(push.act({ device: locked.device, t: t4, a: 'allow' }).status, 403, 'Izinkan off on this device');
  assert.equal(d4.length, 0);
  const d5 = ask(hub, 'a5');
  await push.idle();
  assert.deepEqual(push.act({ device: locked.device, t: inbox(locked).at(-1).payload.t, a: 'deny' }), { status: 200, body: { ok: true, status: 'denied' } }, 'Tolak still works');
  assert.equal(d5[0].allow, false);

  for (const body of [{ t: 'short', a: 'allow' }, { t: 'x'.repeat(43), a: 'always' }, { t: 42, a: 'allow' }, {}]) assert.equal(push.act({ device: phone.device, ...body, ip: 'b' }).status, 400);
  // Revoked device / phone access off: its tokens are gone.
  ask(hub, 'a6');
  await push.idle();
  push.forgetDevice(phone.device.id);
  assert.equal(push.act({ device: phone.device, t: inbox(phone).at(-1).payload.t, a: 'deny' }).status, 410);
  ask(hub, 'a7');
  await push.idle();
  push.forgetAll();
  assert.equal(push.act({ device: thief.device, t: inbox(thief).at(-1).payload.t, a: 'deny' }).status, 410);

  // 20 failures a minute from one IP: 429 (noise damper; tokens are 256-bit).
  for (let i = 0; i < 20; i++) push.act({ device: phone.device, t: 'y'.repeat(43), a: 'deny', ip: 'flood' });
  assert.equal(push.act({ device: phone.device, t: 'y'.repeat(43), a: 'deny', ip: 'flood' }).status, 429);
  assert.notEqual(push.act({ device: phone.device, t: 'y'.repeat(43), a: 'deny', ip: 'calm' }).status, 429);
});

// ---------- routes ----------

/** A fake response for route handlers (json() uses writeHead + end). */
const fakeRes = () => {
  const res = { status: 0, body: null, headers: {}, setHeader: (k, v) => (res.headers[k] = v), writeHead: (s) => (res.status = s), end: (b) => (res.body = b ? JSON.parse(b) : null) };
  return res;
};

test('routes: TLS + Tailscale + https device for every /api/push/*; act also needs the exact https Origin and no office token', async () => {
  const { push, hub, addDevice, inbox } = setup();
  const router = buildRouter();
  const pushRoutes = router.routes.filter((r) => r.pattern.startsWith('/api/push/'));
  assert.deepEqual(pushRoutes.map((r) => r.pattern).sort(), ['/api/push/act', '/api/push/history', '/api/push/settings', '/api/push/subscribe', '/api/push/test', '/api/push/unsubscribe', '/api/push/vapid', '/api/push/visible']);
  assert.deepEqual(router.routes.filter((r) => r.noToken).map((r) => r.pattern), ['/api/push/act'], 'the only path without x-office-token');
  assert.ok(pushRoutes.every((r) => r.maxBody && r.maxBody <= 4096), 'small bodies only');

  const phone = addDevice('Android · Chrome', { settings: null });
  const httpPhone = { id: 'h', name: 'http', transport: 'http' };
  const ORIGIN = 'https://office.test:4318';
  const ctx = (device, tailscale = true) => ({ hub, push, device, isTailscale: () => tailscale, httpsInfo: () => ({ url: ORIGIN }), isLocal: () => false });
  const req = ({ encrypted = true, origin = ORIGIN } = {}) => ({ socket: { encrypted, remoteAddress: '100.100.1.2' }, headers: origin ? { origin } : {} });
  const call = async (p, body, c, r) => {
    const res = fakeRes();
    await router.match('POST', p).route.handler(c, r, res, {}, body);
    return res;
  };

  for (const p of pushRoutes.filter((r) => r.pattern !== '/api/push/history').map((r) => r.pattern)) {
    assert.equal((await call(p, {}, ctx(phone.device), req({ encrypted: false }))).status, 403, `${p} over plain http`);
    assert.equal((await call(p, {}, ctx(phone.device, false), req())).status, 403, `${p} not over Tailscale`);
    assert.equal((await call(p, {}, ctx(httpPhone), req())).status, 401, `${p} with an http-paired device`);
    assert.equal((await call(p, {}, ctx(null), req())).status, 401, `${p} unpaired`);
  }
  // 📜 History is laptop-only (LOCAL_ONLY in server.js): a phone is refused, the laptop reads it.
  assert.equal((await call('/api/push/history', {}, ctx(phone.device), req())).status, 403, 'history: phone refused');
  assert.deepEqual((await call('/api/push/history', {}, { ...ctx(null), isLocal: () => true }, req())).body, { entries: [] });

  const vapid = await call('/api/push/vapid', {}, ctx(phone.device), req());
  assert.match(vapid.body.publicKey, /^B[\w-]{86}$/);
  assert.equal((await call('/api/push/subscribe', { subscription: { endpoint: 'https://evil.example/x', keys: phone.browser.subscription.keys }, settings: SETTINGS }, ctx(phone.device), req())).status, 400);
  assert.equal((await call('/api/push/subscribe', { subscription: phone.browser.subscription, settings: { events: {} } }, ctx(phone.device), req())).status, 400, 'tzOffsetMin required');
  assert.deepEqual((await call('/api/push/subscribe', { subscription: phone.browser.subscription, settings: SETTINGS }, ctx(phone.device), req())).body, { ok: true });
  assert.deepEqual((await call('/api/push/settings', { settings: { ...SETTINGS, lockscreenAllow: false } }, ctx(phone.device), req())).body, { ok: true });
  assert.equal(phone.device.push.settings.lockscreenAllow, false);
  assert.deepEqual((await call('/api/push/visible', { visible: true, tab: 'abc' }, ctx(phone.device), req())).body, { ok: true });
  const tested = await call('/api/push/test', {}, ctx(phone.device), req());
  assert.deepEqual(tested.body, { ok: true, status: 201 });
  assert.equal(inbox(phone)[0].payload.type, 'test');

  // act: Origin must be present and exactly the https origin
  ask(hub, 'r1');
  push.setVisible(phone.device.id, 'abc', false);
  await push.idle();
  const t = inbox(phone).at(-1).payload.t;
  for (const origin of [null, 'https://evil.example', 'http://office.test:4318', 'https://office.test:4317']) assert.equal((await call('/api/push/act', { t, a: 'deny' }, ctx(phone.device), req({ origin }))).status, 403, String(origin));
  assert.equal((await call('/api/push/act', { t, a: 'deny' }, { ...ctx(phone.device), httpsInfo: () => ({ url: null }) }, req())).status, 403, 'no https origin at all');
  const done = await call('/api/push/act', { t, a: 'deny' }, ctx(phone.device), req());
  assert.deepEqual([done.status, done.body], [200, { ok: true, status: 'denied' }]);
  assert.equal((await call('/api/push/act', null, ctx(phone.device), req())).status, 400, 'null body');

  assert.deepEqual((await call('/api/push/unsubscribe', {}, ctx(phone.device), req())).body, { ok: true });
  assert.equal(phone.device.push, undefined);
  assert.equal((await call('/api/push/test', {}, ctx(phone.device), req())).status, 409, 'not subscribed');
});

test('security: lockscreenAllow is fail-closed; Izinkan only for allow-listed file tools, enforced in act() too', async () => {
  assert.equal(parseSettings({ tzOffsetMin: 0 }).lockscreenAllow, false, 'absent → Tolak only');
  assert.equal(parseSettings({ tzOffsetMin: 0, lockscreenAllow: true }).lockscreenAllow, true);
  const { hub, push, addDevice, inbox } = setup();
  const { lockscreenAllow: _drop, ...implicit } = SETTINGS;
  const phone = addDevice('Android · Chrome');
  const quiet = addDevice('Implicit', { settings: implicit });
  const risky = ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'mcp__github__create_issue', 'Task', 'SomethingNew', ''];
  for (const [i, tool] of risky.entries()) {
    const decisions = ask(hub, `risky${i}`, { tool });
    await push.idle();
    const p = inbox(phone).at(-1).payload;
    assert.equal(p.allowAllowed, false, `${tool || '(none)'}: Tolak only`);
    assert.match(p.t, /^[A-Za-z0-9_-]{43}$/, 'still a token for Tolak');
    const refused = push.act({ device: phone.device, t: p.t, a: 'allow', ip: `r${i}` });
    assert.equal(refused.status, 403, `${tool}: allow refused server-side even with a valid token`);
    assert.equal(decisions.length, 0, 'not resolved');
  }
  for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'TodoWrite']) assert.ok(LOCKSCREEN_SAFE_TOOLS.has(tool), tool);
  const decisions = ask(hub, 'safe', { tool: 'Write' });
  await push.idle();
  assert.equal(inbox(quiet).at(-1).payload.allowAllowed, false, 'device without lockscreenAllow: Tolak only');
  assert.equal(push.act({ device: quiet.device, t: inbox(quiet).at(-1).payload.t, a: 'allow' }).status, 403);
  const p = inbox(phone).at(-1).payload;
  assert.equal(p.allowAllowed, true);
  assert.equal(push.act({ device: phone.device, t: p.t, a: 'allow' }).status, 200);
  assert.equal(decisions[0].allow, true);
  // Tolak works for a risky tool
  const d2 = ask(hub, 'risky-deny', { tool: 'Bash' });
  await push.idle();
  assert.equal(push.act({ device: phone.device, t: inbox(phone).at(-1).payload.t, a: 'deny' }).status, 200);
  assert.equal(d2[0].allow, false);
});

test('POST /api/push/test: one per device per 10 s (429 + Retry-After)', async () => {
  const { push, hub, clock, addDevice } = setup();
  const router = buildRouter();
  const a = addDevice('A');
  const b = addDevice('B');
  const ctx = (device) => ({ hub, push, device, isTailscale: () => true, httpsInfo: () => ({ url: 'https://o.test:4318' }) });
  const req = { socket: { encrypted: true }, headers: {} };
  const call = async (device) => {
    const res = fakeRes();
    await router.match('POST', '/api/push/test').route.handler(ctx(device), req, res, {}, {});
    return res;
  };
  assert.equal((await call(a.device)).status, 200);
  const again = await call(a.device);
  assert.equal(again.status, 429);
  assert.equal(again.body.retryAfter, 10);
  assert.equal(again.headers['Retry-After'], '10');
  assert.equal((await call(b.device)).status, 200, 'per device');
  clock.now += 10_000;
  assert.equal((await call(a.device)).status, 200, 'after the cooldown');
});
