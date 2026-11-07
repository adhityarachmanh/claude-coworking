// 🔔 Web Push to paired phones: the app's policy on top of src/webpush.js (docs/design-web-push.md §B4–§C).
//
// - Subscriptions live on the device record (persisted.remote.devices[].push): unpairing a device (Cabut, idle)
//   removes its subscription with it. Never in a backup (hub.exportState() drops `remote`).
// - What is pushed and when follows the phone's own 🔔 settings through notifyPlan() (public/js/core/notify-rules.js,
//   the same pure rules the page uses), with quiet hours evaluated on the phone's clock (its timezone).
// - Payloads are minimal (project name, role name, tool NAME only: never a command, path, chat or error text): they
//   show on the lock screen, and the push service sees their size (padded) and the opaque Topic.
// - Izinkan / Tolak from the notification: a single-use action token per (approval, device), 256-bit, kept only as
//   a SHA-256 hash in memory, 15 minutes (POST /api/push/act, src/routes/push.js).
import { createHash, randomBytes } from 'node:crypto';
import { NOTIFY_KINDS, cleanNotifySettings, isTime, notifyPlan } from '../public/js/core/notify-rules.js';
import { CATALOG } from './role-catalog.js';
import { DEVICE_IDLE_MS } from './remote.js';
import { MAX_PLAINTEXT, PUSH_SERVICE_HOSTS, WebPushError, endpointAllowed, ensureVapidKeys, sendPush, subscriptionKeys } from './webpush.js';

export const ACT_TTL_MS = 15 * 60 * 1000;
/** A page's "I am visible" report counts this long (the page repeats it every 30 s while visible). */
export const VISIBLE_TTL_MS = 90 * 1000;
const MAX_IN_FLIGHT = 4; // concurrent requests to push services
const MAX_WAITING = 200; // beyond this, new pushes are dropped (best effort)
const MAX_FAILURES = 3; // consecutive 400/401/403 answers: the subscription is dropped (usually a VAPID key mismatch)
const DEFAULT_BACKOFF_S = 60;
const MAX_BACKOFF_S = 60 * 60;
const FINAL_LRU = 200; // final states of answered approvals (for the 409 of a late action)
const SPENT_LRU = 500; // hashes of used/dropped action tokens → approval id
const ACT_FAILURE_LIMIT = 20; // failed actions per IP per minute before 429
const ACT_FAILURE_WINDOW_MS = 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const TAB_RE = /^[\w-]{1,64}$/;
const MAX_TABS = 20;

/** Per push type: Urgency, TTL (s), Topic prefix (null = no Topic). `answered` replaces `ask` (same Topic). */
export const PUSH_SPEC = Object.freeze({
  ask: Object.freeze({ urgency: 'high', ttl: 600, topic: 'a' }),
  answered: Object.freeze({ urgency: 'normal', ttl: 600, topic: 'a' }),
  done: Object.freeze({ urgency: 'normal', ttl: 900, topic: 'd' }),
  error: Object.freeze({ urgency: 'normal', ttl: 3600, topic: 'e' }),
  queue: Object.freeze({ urgency: 'normal', ttl: 3600, topic: 'q' }),
  test: Object.freeze({ urgency: 'normal', ttl: 60, topic: null }),
});

/**
 * Tools whose permission may be granted from the lock screen (allow-list, security review MEDIUM-2): in-project
 * file reads/edits. Anything else (Bash, PowerShell, WebFetch/WebSearch, every mcp__*, unknown tools) gets only
 * Tolak + "open the app".
 */
export const LOCKSCREEN_SAFE_TOOLS = Object.freeze(new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS', 'TodoWrite', 'TodoRead']));
/** Izinkan from the notification: a tool permission, a safe tool, and the device opted in. */
const lockscreenAllows = (approval, device) => approval.kind === 'tool' && LOCKSCREEN_SAFE_TOOLS.has(approval.tool) && device.push?.settings?.lockscreenAllow === true;
const TEST_COOLDOWN_MS = 10_000; // POST /api/push/test: one per device per 10 s

const QUEUE_REASON_LABEL = Object.freeze({ restart: 'Server dimulai ulang', failed: 'Ada tugas yang gagal', rate_limit: 'Batas pemakaian tercapai', budget: 'Batas anggaran tercapai' });

/** A refusal meant for the caller, with its HTTP status (and an optional extra body). */
export class PushError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest('base64url');
const cut = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const plainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A Map used as a small LRU: insertion order, oldest dropped past `max`. */
function remember(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

// ---------- validation (the API boundary) ----------

/** A valid IANA zone name (e.g. "Asia/Jakarta"), or null. */
function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/**
 * The 🔔 settings a phone sends with its subscription → what is stored. Throws PushError(400) on a malformed body.
 * Shape: { enabled?, events: { ask, done, error: {popup, sound} | boolean }, quiet: { enabled, from, to, allowAsk },
 *   favoritesOnly, favorites?, volume?, tzOffsetMin, tz?, lockscreenAllow }
 * tzOffsetMin: minutes EAST of UTC (Jakarta = 420), i.e. -Date#getTimezoneOffset(). tz (IANA) wins when valid.
 * lockscreenAllow: true only when sent as true (fail-closed; the UI sends it explicitly, ON by default there).
 * favorites: accepted for compatibility but not stored: the server's own favourites list is used (always current).
 */
export function parseSettings(raw) {
  const bad = (why) => new PushError(400, `Pengaturan notifikasi tidak valid: ${why}.`);
  if (!plainObject(raw)) throw bad('bukan objek');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw bad('enabled');
  if (raw.events !== undefined && !plainObject(raw.events)) throw bad('events');
  const events = {};
  for (const kind of NOTIFY_KINDS) {
    const e = raw.events?.[kind];
    if (e !== undefined && typeof e !== 'boolean' && !plainObject(e)) throw bad(`events.${kind}`);
    events[kind] = typeof e === 'boolean' ? { popup: e, sound: e } : e;
  }
  const q = raw.quiet;
  if (q !== undefined && !plainObject(q)) throw bad('quiet');
  if (q?.from !== undefined && !isTime(q.from)) throw bad('quiet.from (JJ:MM)');
  if (q?.to !== undefined && !isTime(q.to)) throw bad('quiet.to (JJ:MM)');
  if (!Number.isInteger(raw.tzOffsetMin) || raw.tzOffsetMin < -720 || raw.tzOffsetMin > 840) throw bad('tzOffsetMin (bilangan bulat menit, -720..840)');
  if (raw.lockscreenAllow !== undefined && typeof raw.lockscreenAllow !== 'boolean') throw bad('lockscreenAllow');
  if (raw.favoritesOnly !== undefined && typeof raw.favoritesOnly !== 'boolean') throw bad('favoritesOnly');
  if (raw.favorites !== undefined && (!Array.isArray(raw.favorites) || raw.favorites.length > 1000 || raw.favorites.some((f) => typeof f !== 'string' || f.length > 200))) throw bad('favorites');
  const clean = cleanNotifySettings({ ...raw, events });
  const tz = validTimeZone(raw.tz);
  return {
    enabled: raw.enabled !== false,
    events: clean.events,
    quiet: clean.quiet,
    favoritesOnly: clean.favoritesOnly,
    volume: clean.volume,
    tzOffsetMin: raw.tzOffsetMin,
    ...(tz ? { tz } : {}),
    lockscreenAllow: raw.lockscreenAllow === true, // fail-closed: Izinkan from the lock screen only when sent explicitly
  };
}

/** A browser's PushSubscription JSON → { endpoint, p256dh, auth }. Throws PushError(400). */
export function parseSubscription(raw, allowedHosts = PUSH_SERVICE_HOSTS) {
  const endpoint = raw?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 1024 || !endpointAllowed(endpoint, allowedHosts)) throw new PushError(400, 'Endpoint push tidak diizinkan.');
  const { p256dh, auth } = raw.keys ?? {};
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 64) throw new PushError(400, 'Kunci subscription tidak valid.');
  try {
    subscriptionKeys(p256dh, auth); // 65-byte point on P-256, 16-byte auth secret
  } catch (err) {
    throw new PushError(400, err instanceof WebPushError ? err.message : 'Kunci subscription tidak valid.');
  }
  return { endpoint, p256dh, auth };
}

/**
 * The phone's wall clock for notifyPlan()'s quiet hours: only getHours/getMinutes are used there.
 * IANA zone when the phone sent one (DST-correct), else its UTC offset.
 */
export function phoneClock(settings, now = Date.now()) {
  if (settings.tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: settings.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
      const h = Number(parts.find((p) => p.type === 'hour').value);
      const m = Number(parts.find((p) => p.type === 'minute').value);
      return { getHours: () => h, getMinutes: () => m };
    } catch {
      // fall through to the offset
    }
  }
  const d = new Date(now + (settings.tzOffsetMin ?? 0) * 60_000);
  return { getHours: () => d.getUTCHours(), getMinutes: () => d.getUTCMinutes() };
}

// ---------- the service ----------

export class PushService {
  /**
   * @param {object} options
   * @param {object} options.hub
   * @param {object} options.remote  RemoteAccess
   * @param {(projectId: string) => object|null} [options.queueSummary]  TaskQueue#summary
   * @param {(deviceId: string) => boolean} [options.hasStream]  the device has an open event stream
   * @param {typeof fetch} [options.fetch]  the push services' HTTP client (tests inject a fake push service)
   * @param {readonly string[]} [options.allowedHosts]  push service allowlist (tests only; never from env)
   * @param {() => number} [options.now]
   * @param {() => void} [options.onChange]  a device's push state changed (📱 badges)
   * @param {(msg: string) => void} [options.log]  info
   * @param {(msg: string) => void} [options.warn]  failures (sanitised: no endpoint, key or payload)
   */
  constructor({ hub, remote, queueSummary = () => null, hasStream = () => false, fetch, allowedHosts = PUSH_SERVICE_HOSTS, now = Date.now, onChange = () => {}, log = console.log, warn = console.error }) {
    this.hub = hub;
    this.remote = remote;
    this.queueSummary = queueSummary;
    this.hasStream = hasStream;
    this.fetch = fetch;
    this.allowedHosts = allowedHosts;
    this.now = now;
    this.onChange = onChange;
    this.log = log;
    this.warn = warn;
    this.tokens = new Map(); // sha256(token) -> { approvalId, deviceId, exp }
    this.spent = new Map(); // sha256(token) -> approvalId (used, expired or dropped tokens)
    this.finals = new Map(); // approvalId -> 'allowed'|'denied'|'cancelled'
    this.delivered = new Map(); // approvalId -> Set(deviceId) that got the "ask" push
    this.answering = null; // { approvalId, deviceId } while /api/push/act resolves an approval
    this.visible = new Map(); // deviceId -> Map(tab -> { visible, at })
    this.lastTest = new Map(); // deviceId -> time of the last test push
    this.backoff = new Map(); // deviceId -> epoch ms until which nothing is sent (429/503)
    this.queuePauses = new Map(); // projectId -> pause reason already announced
    this.history = []; // newest notifications sent (in memory; laptop-only view)
    this.actFailures = new Map(); // ip -> [timestamps]
    this.inFlight = 0;
    this.waiting = [];
    this.pending = new Set(); // promises of sends in progress (idle() for tests)
  }

  // ---------- keys, devices ----------

  /** The VAPID public key (applicationServerKey), created on first use. */
  publicKey() {
    return ensureVapidKeys(this.remote.state, () => this.hub.save()).publicKey;
  }

  /** Opaque Topic for one project and push type: never the project id itself (Topic travels unencrypted). */
  topic(prefix, projectId) {
    const state = this.remote.state;
    if (!state.pushSalt) {
      state.pushSalt = randomBytes(16).toString('base64url');
      this.hub.save();
    }
    return prefix + sha256(`${state.pushSalt}\0${projectId}`).slice(0, 20);
  }

  /** Devices that may get pushes now: phone access on, paired over https, subscribed, not idle. */
  targets() {
    if (!this.remote.enabled) return [];
    const now = this.now();
    return this.remote.state.devices.filter((d) => d.push && d.transport === 'https' && now - (d.lastSeen ?? d.created ?? 0) <= DEVICE_IDLE_MS);
  }

  deviceById(id) {
    return this.remote.state.devices.find((d) => d.id === id) ?? null;
  }

  /** What the device's own page needs (snapshot `client.push`): never the endpoint or keys. */
  clientInfo(device) {
    if (!device || device.transport !== 'https') return null;
    return { subscribed: Boolean(device.push), settings: device.push?.settings ?? null };
  }

  // ---------- subscription API ----------

  subscribe(device, body) {
    const sub = parseSubscription(body?.subscription, this.allowedHosts);
    const settings = parseSettings(body?.settings);
    // The same browser re-paired as a new device: only the newest record keeps the subscription (no double pushes).
    for (const other of this.remote.state.devices) if (other !== device && other.push?.endpoint === sub.endpoint) delete other.push;
    const same = device.push?.endpoint === sub.endpoint;
    device.push = { ...sub, settings, created: same ? device.push.created : this.now(), lastOk: same ? device.push.lastOk ?? null : null, lastError: null, failures: 0 };
    this.backoff.delete(device.id);
    this.publicKey(); // keys exist before the first push
    this.hub.save();
    this.onChange();
    return { ok: true };
  }

  updateSettings(device, body) {
    if (!device.push) throw new PushError(409, 'HP ini belum berlangganan notifikasi.');
    device.push.settings = parseSettings(body?.settings);
    this.hub.save();
    return { ok: true };
  }

  unsubscribe(device) {
    const had = Boolean(device.push);
    delete device.push;
    this.dropTokens((t) => t.deviceId === device.id);
    if (had) {
      this.hub.save();
      this.onChange();
    }
    return { ok: true };
  }

  /** The page of `deviceId` reports whether one of its tabs is visible (anti-double: no push while it is). */
  setVisible(deviceId, tab, visible) {
    if (typeof visible !== 'boolean') throw new PushError(400, 'visible harus boolean.');
    const key = tab === undefined ? '-' : tab;
    if (typeof key !== 'string' || !TAB_RE.test(key)) throw new PushError(400, 'tab tidak valid.');
    const tabs = this.visible.get(deviceId) ?? new Map();
    tabs.delete(key);
    if (visible) tabs.set(key, { at: this.now() });
    while (tabs.size > MAX_TABS) tabs.delete(tabs.keys().next().value);
    if (tabs.size) this.visible.set(deviceId, tabs);
    else this.visible.delete(deviceId);
    return { ok: true };
  }

  /** A page of this device is open (stream) and visible (reported within VISIBLE_TTL_MS). */
  isVisible(deviceId) {
    const tabs = this.visible.get(deviceId);
    if (!tabs || !this.hasStream(deviceId)) return false;
    const now = this.now();
    return [...tabs.values()].some((t) => now - t.at <= VISIBLE_TTL_MS);
  }

  /** Sends a test notification to this device now, whatever its settings. */
  async test(device) {
    if (!device.push) throw new PushError(409, 'HP ini belum berlangganan notifikasi.');
    const last = this.lastTest.get(device.id) ?? -Infinity;
    const wait = last + TEST_COOLDOWN_MS - this.now();
    if (wait > 0) {
      const retryAfter = Math.ceil(wait / 1000);
      throw new PushError(429, `Tunggu ${retryAfter} detik sebelum tes berikutnya.`, { retryAfter });
    }
    this.lastTest.set(device.id, this.now());
    const payload = this.payload('test', { project: '', projectName: 'Adhit Office', role: 'Adhit Office', label: 'Tes notifikasi', silent: false, title: '🔔 Tes notifikasi', body: 'Notifikasi dari Adhit Office berfungsi.' });
    const result = await this.enqueue(device.id, payload, PUSH_SPEC.test);
    this.record({ type: 'test', project: '', projectName: 'Adhit Office', role: 'Adhit Office', devices: [device.name] });
    return { ok: Boolean(result?.ok), status: result?.status ?? null };
  }

  // ---------- forgetting ----------

  /** A device was unpaired (Cabut, idle): its tokens and in-memory state go. Its record (and subscription) is already gone. */
  forgetDevice(id) {
    this.dropTokens((t) => t.deviceId === id);
    this.visible.delete(id);
    this.backoff.delete(id);
    this.lastTest.delete(id);
    for (const set of this.delivered.values()) set.delete(id);
  }

  /** Phone access switched off: no action token stays usable. */
  forgetAll() {
    this.dropTokens(() => true);
    this.visible.clear();
    this.delivered.clear();
  }

  dropTokens(match) {
    for (const [hash, t] of this.tokens) {
      if (!match(t)) continue;
      this.tokens.delete(hash);
      remember(this.spent, hash, t.approvalId, SPENT_LRU);
    }
  }

  sweep() {
    const now = this.now();
    this.dropTokens((t) => t.exp <= now);
  }

  // ---------- events (hub.observers) ----------

  /** hub.observers entry: never throws (it runs inside every broadcast). */
  observe(type, data) {
    try {
      if (type === 'approval') this.onApproval(data);
      else if (type === 'chat') this.onChat(data);
      else if (type === 'queue') this.onQueue(data);
    } catch (err) {
      this.warn(`Push: event ${type} gagal diproses: ${err?.message ?? err}`);
    }
  }

  /** Records which queues are paused already (at start): only a pause that happens later is announced. */
  seedQueues(projectIds) {
    for (const id of projectIds) {
      const s = this.queueSummary(id);
      if (s?.paused && s.reason !== 'user') this.queuePauses.set(id, s.reason);
    }
  }

  onApproval(a) {
    if (!a?.id) return;
    if (a.status === 'pending') {
      if (this.delivered.has(a.id)) return;
      this.sweep();
      const pending = [...this.hub.approvals.values()].filter((e) => e.approval.project === a.project).length;
      const got = new Set();
      this.delivered.set(a.id, got);
      const label = a.kind === 'question' ? 'Pertanyaan' : a.kind === 'plan' ? 'Rencana' : cut(String(a.tool ?? '').replace(/[^\w.:-]/g, ''), 40) || 'Tool';
      this.fanOut('ask', a.project, (device, plan) => {
        got.add(device.id);
        const fields = { project: a.project, role: this.roleName(a.role), label, approvalId: a.id, silent: !plan.sound, pending };
        // Izinkan / Tolak only for a tool permission; Izinkan only where the device allows it on the lock screen.
        if (a.kind === 'tool') Object.assign(fields, { t: this.issueToken(a.id, device.id), allowAllowed: lockscreenAllows(a, device) });
        return fields;
      });
      return;
    }
    // Answered (here, on the laptop, another phone) or cancelled: tokens die, the ask notification is replaced.
    remember(this.finals, a.id, a.status, FINAL_LRU);
    this.dropTokens((t) => t.approvalId === a.id);
    const got = this.delivered.get(a.id);
    this.delivered.delete(a.id);
    if (!got?.size) return;
    const skip = this.answering?.approvalId === a.id ? this.answering.deviceId : null;
    for (const id of got) {
      if (id === skip) continue; // that phone already shows its own answer
      const device = this.deviceById(id);
      if (!device?.push || !this.remote.enabled) continue;
      const payload = this.payload('answered', { project: a.project, role: this.roleName(a.role), approvalId: a.id, status: a.status, silent: true });
      this.enqueue(id, payload, PUSH_SPEC.answered, this.topic(PUSH_SPEC.answered.topic, a.project));
    }
  }

  onChat(m) {
    if (!m?.project) return;
    if (m.kind === 'result') this.fanOut(m.ok ? 'done' : 'error', m.project, () => ({ project: m.project, role: this.roleName('claude') }));
    else if (m.kind === 'error') this.fanOut('error', m.project, () => ({ project: m.project, role: this.roleName('claude') }));
  }

  onQueue(q) {
    const id = q?.project;
    if (!id) return;
    const s = this.queueSummary(id);
    if (!s?.paused || s.reason === 'user') {
      this.queuePauses.delete(id);
      return;
    }
    if (this.queuePauses.get(id) === s.reason) return; // edge-triggered: once per pause
    this.queuePauses.set(id, s.reason);
    // "Antrian dijeda" follows the device's "Berhenti / error" toggle (Lead decision, Q4).
    this.fanOut('queue', id, () => ({ project: id, role: this.roleName('claude'), label: QUEUE_REASON_LABEL[s.reason] ?? '' }), 'error');
  }

  /**
   * One event to every eligible device: its 🔔 settings (notifyPlan, phone clock), not while a page of that device
   * is visible (the page alerts itself). `build(device, plan)` → payload fields.
   */
  fanOut(type, projectId, build, planKind = type) {
    const spec = PUSH_SPEC[type];
    const favorite = (this.hub.persisted.favorites ?? []).includes(projectId);
    const topic = spec.topic ? this.topic(spec.topic, projectId) : undefined;
    const sent = [];
    let sample = null;
    for (const device of this.targets()) {
      const settings = device.push.settings ?? {};
      if (settings.enabled === false) continue;
      if (this.isVisible(device.id)) continue;
      const plan = notifyPlan(planKind, settings, { away: true, favorite, now: phoneClock(settings, this.now()) });
      if (!plan.popup) continue;
      const fields = build(device, plan);
      sample ??= fields;
      const payload = this.payload(type, { silent: !plan.sound, ...fields });
      this.enqueue(device.id, payload, spec, topic);
      sent.push(device.name);
    }
    if (sent.length) {
      this.record({
        type,
        project: sample?.project ?? projectId ?? '',
        projectName: sample?.projectName ?? this.hub.projects.get(projectId)?.name ?? 'project',
        role: sample?.role ?? '',
        devices: sent.slice(0, 20),
      });
    }
  }

  /** One line of the laptop's notification history (the payload carries only what the lock screen shows). */
  record(entry) {
    this.history.push({ at: this.now(), ...entry });
    if (this.history.length > 30) this.history.splice(0, this.history.length - 30);
  }

  /** Newest first, for ⚙ → Notifikasi. */
  historyView() {
    return [...this.history].reverse();
  }

  // ---------- payload, tokens ----------

  roleName(role) {
    const custom = this.hub.persisted.teamNames?.[role];
    return cut(custom || CATALOG[role]?.name || (role === 'claude' || !role ? 'Adhit - Lead' : 'Claude'), 40);
  }

  /** The decrypted push body (public/sw.js parsePayload). Strings are cut so it always fits one record. */
  payload(type, fields) {
    const p = {
      v: 1,
      type,
      project: cut(fields.project, 200),
      projectName: cut(fields.projectName ?? this.hub.projects.get(fields.project)?.name ?? 'project', 40),
      role: cut(fields.role, 40),
      label: cut(fields.label, 60),
      approvalId: cut(fields.approvalId, 200),
      t: fields.t ?? '',
      allowAllowed: fields.allowAllowed === true,
      silent: fields.silent === true,
      ts: this.now(),
    };
    if (fields.pending !== undefined) p.pending = fields.pending;
    if (fields.status) p.status = fields.status;
    if (fields.title) Object.assign(p, { title: cut(fields.title, 80), body: cut(fields.body, 120) });
    const text = JSON.stringify(p);
    if (Buffer.byteLength(text) > MAX_PLAINTEXT) throw new Error('payload push terlalu besar'); // cannot happen with the cuts above
    return text;
  }

  issueToken(approvalId, deviceId) {
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(sha256(token), { approvalId, deviceId, exp: this.now() + ACT_TTL_MS });
    return token;
  }

  // ---------- sending ----------

  /** Queues one send (at most MAX_IN_FLIGHT at a time). Resolves with { ok, status } or null when dropped. */
  enqueue(deviceId, payload, spec, topic, options = {}) {
    if (this.waiting.length >= MAX_WAITING) {
      this.warn('Push: antrian pengiriman penuh, notifikasi dilewati');
      return Promise.resolve(null);
    }
    const job = new Promise((resolve) => this.waiting.push({ deviceId, payload, spec, topic, options, resolve }));
    this.pending.add(job);
    job.finally(() => this.pending.delete(job));
    this.pump();
    return job;
  }

  pump() {
    while (this.inFlight < MAX_IN_FLIGHT && this.waiting.length) {
      const job = this.waiting.shift();
      this.inFlight++;
      this.sendNow(job)
        .catch((err) => {
          this.warn(`Push: gagal: ${err?.message ?? err}`);
          return null;
        })
        .then((result) => {
          this.inFlight--;
          job.resolve(result);
          this.pump();
        });
    }
  }

  /** Waits until every queued push is done (tests, shutdown). */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  async sendNow({ deviceId, payload, spec, topic }) {
    const device = this.deviceById(deviceId);
    if (!device?.push || !this.remote.enabled) return null;
    const until = this.backoff.get(deviceId);
    if (until && until > this.now()) return { ok: false, status: 429 }; // the push service asked us to wait: dropped
    this.backoff.delete(deviceId);
    const sub = { endpoint: device.push.endpoint, keys: { p256dh: device.push.p256dh, auth: device.push.auth } };
    let res;
    try {
      res = await sendPush(sub, payload, { vapid: ensureVapidKeys(this.remote.state, () => this.hub.save()), ttl: spec.ttl, urgency: spec.urgency, topic: topic ?? undefined, fetch: this.fetch, allowedHosts: this.allowedHosts, now: this.now() });
    } catch (err) {
      if (err instanceof WebPushError && (err.code === 'endpoint-not-allowed' || err.code === 'bad-subscription')) {
        this.dropSubscription(device, `subscription tidak valid (${err.code})`);
        return { ok: false, status: null };
      }
      // Network: laptop offline, push service down. Not counted against the subscription; the event is dropped.
      this.warn(`Push ke "${device.name}" gagal: ${err instanceof WebPushError ? err.code : 'error'}${err?.cause?.code ? ` (${err.cause.code})` : ''}`);
      return { ok: false, status: null };
    }
    this.handleAnswer(device, res);
    return { ok: res.ok, status: res.status };
  }

  /** What the push service answered (docs/design-web-push.md §B4). */
  handleAnswer(device, { ok, status, retryAfter }) {
    const push = device.push;
    if (!push) return;
    if (ok) {
      const changed = push.failures || push.lastError;
      Object.assign(push, { lastOk: this.now(), lastError: null, failures: 0 });
      this.hub.scheduleSave();
      if (changed) this.onChange();
      return;
    }
    if (status === 404 || status === 410) return this.dropSubscription(device, `push service: ${status} (subscription kedaluwarsa)`);
    if (status === 429 || status === 503) {
      const wait = Math.min(Math.max(retryAfter ?? DEFAULT_BACKOFF_S, 1), MAX_BACKOFF_S);
      this.backoff.set(device.id, this.now() + wait * 1000);
      this.warn(`Push ke "${device.name}": push service sibuk (${status}), jeda ${wait} detik`);
      return;
    }
    push.lastError = status;
    push.failures = (push.failures ?? 0) + 1;
    if (status === 413) this.warn(`Push ke "${device.name}": payload terlalu besar (413)`);
    else this.warn(`Push ke "${device.name}" ditolak: ${status}`);
    if ([400, 401, 403].includes(status) && push.failures >= MAX_FAILURES) return this.dropSubscription(device, `${MAX_FAILURES}× ditolak (${status})`);
    this.hub.scheduleSave();
    this.onChange();
  }

  dropSubscription(device, why) {
    if (!device.push) return;
    delete device.push;
    this.dropTokens((t) => t.deviceId === device.id);
    this.backoff.delete(device.id);
    this.log(`Push: langganan "${device.name}" dihapus: ${why}`);
    this.hub.save();
    this.onChange();
  }

  // ---------- Izinkan / Tolak from the notification ----------

  /** Too many failed actions from this IP in the last minute. */
  actLimited(ip) {
    const now = this.now();
    const list = (this.actFailures.get(ip) ?? []).filter((t) => now - t < ACT_FAILURE_WINDOW_MS);
    if (list.length) this.actFailures.set(ip, list);
    else this.actFailures.delete(ip);
    return list.length >= ACT_FAILURE_LIMIT;
  }

  actFailed(ip) {
    if (this.actFailures.size > 1000) this.actFailures.clear(); // bounded memory
    const list = this.actFailures.get(ip) ?? [];
    list.push(this.now());
    this.actFailures.set(ip, list);
  }

  /**
   * POST /api/push/act after the route's transport checks (TLS, Tailscale, Origin, https device cookie).
   * @param {{ device: object, t: unknown, a: unknown, ip: string }} input
   * @returns {{ status: number, body: object }}
   */
  act({ device, t, a, ip = '' }) {
    if (this.actLimited(ip)) return { status: 429, body: { error: 'Terlalu banyak percobaan. Coba lagi sebentar lagi.' } };
    const fail = (status, body) => {
      this.actFailed(ip);
      return { status, body };
    };
    if (typeof t !== 'string' || !TOKEN_RE.test(t) || (a !== 'allow' && a !== 'deny')) return fail(400, { error: 'Permintaan tidak valid.' });
    this.sweep();
    const hash = sha256(t);
    const entry = this.tokens.get(hash);
    if (!entry) {
      // Used already, or dropped because the approval was answered elsewhere: say how it ended.
      const approvalId = this.spent.get(hash);
      const final = approvalId ? this.finals.get(approvalId) : null;
      if (final) return fail(409, { status: final });
      return fail(410, { error: 'Tombol ini sudah tidak berlaku. Buka aplikasi untuk menjawab.' });
    }
    // Single use: gone now, whatever happens next.
    this.tokens.delete(hash);
    remember(this.spent, hash, entry.approvalId, SPENT_LRU);
    if (entry.deviceId !== device.id) return fail(403, { error: 'Token bukan untuk perangkat ini.' });
    if (entry.exp <= this.now()) return fail(410, { error: 'Tombol ini sudah kedaluwarsa. Buka aplikasi untuk menjawab.' });
    const approval = this.hub.approvals.get(entry.approvalId)?.approval;
    if (!approval || approval.status !== 'pending') return fail(409, { status: this.finals.get(entry.approvalId) ?? 'gone' });
    const allow = a === 'allow';
    if (allow && !lockscreenAllows(approval, device)) return fail(403, { error: 'Izin ini tidak bisa diberikan dari notifikasi. Buka aplikasi untuk menjawab.' });
    this.answering = { approvalId: approval.id, deviceId: device.id };
    let resolved;
    try {
      resolved = this.hub.resolveApproval(approval.id, { allow, answeredBy: { via: 'push', device: device.name } });
    } finally {
      this.answering = null;
    }
    if (!resolved) return fail(409, { status: this.finals.get(approval.id) ?? 'gone' });
    const projectName = this.hub.projects.get(approval.project)?.name ?? approval.project;
    this.log(`Izin ${approval.tool ?? 'tool'} di "${projectName}" ${allow ? 'diizinkan' : 'ditolak'} dari HP "${device.name}" (notifikasi)`);
    return { status: 200, body: { ok: true, status: allow ? 'allowed' : 'denied' } };
  }
}

/** The `approval` event for a read-only (plain-WiFi) client: who answered from which phone is not sent. */
export function wifiApproval(approval) {
  if (!approval?.answeredBy) return approval;
  return { ...approval, answeredBy: { via: approval.answeredBy.via } };
}
