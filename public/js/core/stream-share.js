// One server event stream (SSE) for every tab of this origin.
//
// Why: the server is plain HTTP/1.1, and browsers open at most 6 connections per host. Each EventSource holds one
// for good, so with a handful of Adhit Office tabs open every other request (API calls, assets) queued forever.
//
// How: the tabs elect one leader. Only the leader opens the EventSource; it applies every event itself and relays it
// (the raw JSON text) over a BroadcastChannel, which only reaches pages of this same origin. Followers apply the
// relayed events through the very same handlers. A tab that joins late asks for a sync: the leader keeps the last
// snapshot plus the events since, and sends both (replayed quietly: no chimes for old news).
//
// Election: Web Locks (navigator.locks, secure contexts: localhost, HTTPS/Tailscale) — the lock is held while leading
// and the browser hands it to the next tab the moment the leader closes or crashes. Without Web Locks (a phone on
// plain-HTTP WiFi) followers probe the leader every second; no answer within ~2 s and a follower takes over (ties:
// the lower tab id stays leader). No BroadcastChannel at all: every tab keeps its own stream, as before.
//
// Per-tab things never travel: API calls keep this page's own token (core/state.js `auth`), the active project
// stays per tab (hash / localStorage), and the snapshot's `client` block is the same for every tab of one origin.

const CHANNEL = 'adhit-office.stream';
const LOCK = 'adhit-office.stream-leader';
const MAX_LOG = 2000; // events kept after the snapshot for late joiners; beyond that a joiner triggers a fresh snapshot
const RESYNC_GAP_MS = 5000;

/** Timings (ms). A plain object so a test could shorten them. */
export const SHARE_TIMING = {
  tickMs: 250, // fallback election: how often a follower checks on the leader
  probeMs: 1000, // fallback: a probe per second while the leader answers
  firstProbeMs: 500, // fallback: nobody answers the first probe → nobody leads yet
  takeoverMs: 2000, // fallback: an unanswered probe this old → the leader is gone (closed, frozen)
  jitterMs: 400, // fallback: spreads simultaneous takeovers (fewer duelling leaders)
};

/** Random tab id; crypto.getRandomValues also works on plain HTTP (randomUUID does not). */
function randomId() {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return Array.from(words, (n) => n.toString(36).padStart(7, '0')).join('');
}

/** Runs `fn`; an exception is reported like an uncaught one, without stopping the caller's loop. */
function guarded(fn) {
  try {
    fn();
  } catch (err) {
    queueMicrotask(() => {
      throw err;
    });
  }
}

/**
 * Starts sharing. `types`: the SSE event names to relay. `apply(type, raw, live)`: runs the handler for one event
 * (`live` false while replaying history). `online(bool)`: the stream (this tab's or the leader's) is up / down.
 * `retryDelay()`: pause before reopening a stream the server refused.
 * Returns { resync() } — ask for a fresh snapshot (rate-limited).
 */
export function startStreamShare({ url, types, apply, online, retryDelay }) {
  const id = randomId();
  const useLocks = typeof navigator.locks?.request === 'function';

  let running = false;
  let channel = null;
  let shownOnline = null; // what this page last reported to `online` (null = nothing yet)

  // Leader.
  let leader = false;
  let source = null;
  let retryTimer = 0;
  let sourceOnline = false;
  let cache = { snapshot: null, log: [], overflow: false };
  let lastResync = 0;

  // Follower.
  let leaderId = null;
  let synced = false;

  // Election.
  let releaseLock = null;
  let lockAbort = null;
  let tickTimer = 0;
  let probe = { sentAt: 0, answered: true, first: true };
  let takeoverAt = 0;
  const jitter = Math.random() * SHARE_TIMING.jitterMs;

  const post = (msg) => channel?.postMessage({ ...msg, from: id });

  function setOnline(on) {
    if (shownOnline === on) return;
    shownOnline = on;
    guarded(() => online(on));
  }

  function markRole() {
    document.documentElement.dataset.streamRole = !running ? 'off' : leader ? 'leader' : 'follower';
  }

  // ---------- leader ----------

  function lead() {
    if (leader || !running) return;
    leader = true;
    leaderId = id;
    takeoverAt = 0;
    markRole();
    post({ t: 'leader' });
    openSource();
  }

  function openSource() {
    clearTimeout(retryTimer);
    source?.close();
    const es = new EventSource(url);
    source = es;
    es.addEventListener('open', () => {
      if (es !== source) return;
      sourceOnline = true;
      setOnline(true);
      post({ t: 'conn', online: true });
    });
    es.addEventListener('error', () => {
      if (es !== source) return;
      sourceOnline = false;
      setOnline(false);
      post({ t: 'conn', online: false });
      // A network error is retried by the browser itself (readyState CONNECTING). A refused stream (an HTTP error
      // instead of the event stream) is not: it stays CLOSED for good, so open a new one after a pause.
      if (es.readyState === EventSource.CLOSED) retryTimer = setTimeout(() => leader && openSource(), retryDelay());
    });
    for (const type of types) es.addEventListener(type, (msg) => es === source && relay(type, msg.data));
  }

  /** One event from the server: remembered for late joiners, relayed to the other tabs, applied here. */
  function relay(type, raw) {
    if (type === 'snapshot') cache = { snapshot: raw, log: [], overflow: false };
    else if (cache.snapshot && !cache.overflow) {
      cache.log.push([type, raw]);
      if (cache.log.length > MAX_LOG) cache = { snapshot: cache.snapshot, log: [], overflow: true };
    }
    post({ t: 'event', type, raw });
    guarded(() => apply(type, raw, true));
  }

  /** A tab joined: send it the snapshot and what happened since. No snapshot yet: the coming broadcast reaches it. */
  function answerHello(to) {
    if (!cache.snapshot) return;
    if (cache.overflow) return resyncNow(true); // too much history to replay: everyone takes a fresh snapshot
    post({ t: 'sync', to, snapshot: cache.snapshot, log: cache.log, online: sourceOnline });
  }

  /** Reopens the event stream: its snapshot (relayed to every tab) carries everything as the server has it now. */
  function resyncNow(force = false) {
    if (!force && Date.now() - lastResync < RESYNC_GAP_MS) return;
    lastResync = Date.now();
    openSource();
  }

  /** Stops leading: the stream closes, the followers hear it at once (and look for the next leader). */
  function resign() {
    if (!leader) return;
    leader = false;
    clearTimeout(retryTimer);
    source?.close();
    source = null;
    sourceOnline = false;
    cache = { snapshot: null, log: [], overflow: false };
    if (leaderId === id) leaderId = null;
    post({ t: 'resign' });
    markRole();
  }

  // ---------- follower ----------

  function follow(newLeader) {
    leaderId = newLeader;
    synced = false;
    takeoverAt = 0;
    probe.answered = true;
  }

  function onEvent({ from, type, raw }) {
    if (type === 'snapshot') {
      // A fresh snapshot from whoever leads now: adopt it (replaces everything this page holds).
      leaderId = from;
      synced = true;
      guarded(() => apply(type, raw, true));
      return;
    }
    if (from !== leaderId || !synced) return; // not synced yet: the sync carries this event in its log
    guarded(() => apply(type, raw, true));
  }

  function onSync({ from, snapshot, log, online: on }) {
    leaderId = from;
    synced = true;
    setOnline(on);
    guarded(() => apply('snapshot', snapshot, false));
    for (const [type, raw] of log) guarded(() => apply(type, raw, false));
  }

  function leaderGone() {
    leaderId = null;
    synced = false;
    setOnline(false); // the banner only shows if no new leader is up within a couple of seconds
    // Web Locks hand the lock to the next tab by themselves; the fallback takes over after its jitter.
    if (!useLocks) takeoverAt = Date.now() + jitter;
  }

  // ---------- messages ----------

  function onMessage({ data: m }) {
    if (!m || typeof m !== 'object' || m.from === id || typeof m.from !== 'string') return;
    switch (m.t) {
      case 'hello':
        if (leader) answerHello(m.from);
        break;
      case 'probe':
        if (leader) post({ t: 'beat' });
        break;
      case 'leader':
      case 'beat':
        if (leader) {
          if (!useLocks) duel(m.from);
        } else if (m.from !== leaderId) {
          follow(m.from);
          // A new leader is opening its stream (its snapshot follows); on first load there is nothing to take back.
          if (m.t === 'leader' && shownOnline) setOnline(false);
          else post({ t: 'hello' }); // a leader this page never synced with
        } else {
          probe.answered = true;
          takeoverAt = 0;
        }
        break;
      case 'resign':
        if (!leader && m.from === leaderId) leaderGone();
        break;
      case 'resync':
        if (leader) resyncNow();
        break;
      case 'conn':
        if (!leader && m.from === leaderId) setOnline(m.online === true);
        break;
      case 'event':
        if (!leader && types.includes(m.type) && typeof m.raw === 'string') onEvent(m);
        break;
      case 'sync':
        if (!leader && m.to === id && typeof m.snapshot === 'string' && Array.isArray(m.log)) onSync(m);
        break;
    }
  }

  /** Fallback only: two leaders at once (simultaneous takeover). The lower id keeps leading. */
  function duel(other) {
    if (other < id) {
      resign();
      follow(other);
      setOnline(false);
      post({ t: 'hello' });
    } else {
      post({ t: 'leader' }); // tell the other one it lost
    }
  }

  // ---------- election ----------

  function requestLock() {
    lockAbort = new AbortController();
    navigator.locks
      .request(LOCK, { signal: lockAbort.signal }, () => {
        if (!running) return undefined; // stopped while waiting: let the next tab have it
        return new Promise((resolve) => {
          releaseLock = resolve;
          lead();
        });
      })
      .catch(() => {}); // AbortError: stopped before the lock was granted
  }

  /** Fallback election: probe the leader; no answer in time → take over. */
  function tick() {
    if (leader) return;
    const now = Date.now();
    if (takeoverAt && now >= takeoverAt) return lead();
    if (!probe.answered) {
      const limit = probe.first ? SHARE_TIMING.firstProbeMs : SHARE_TIMING.takeoverMs;
      if (!takeoverAt && now - probe.sentAt > limit) takeoverAt = now + (probe.first ? 0 : jitter);
      return;
    }
    if (now - probe.sentAt >= SHARE_TIMING.probeMs) {
      probe = { sentAt: now, answered: false, first: probe.first && !leaderId };
      post({ t: 'probe' });
    }
  }

  // ---------- lifecycle ----------

  function start(restored = false) {
    if (running) return;
    running = true;
    leaderId = null;
    synced = false;
    takeoverAt = 0;
    probe = { sentAt: 0, answered: true, first: true };
    if (restored) setOnline(false); // back from the back/forward cache: offline until the fresh state is in
    markRole();
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
    if (!channel) return lead(); // nothing to share with: this tab keeps its own stream
    channel.onmessage = onMessage;
    post({ t: 'hello' });
    if (useLocks) requestLock();
    else {
      tick();
      tickTimer = setInterval(tick, SHARE_TIMING.tickMs);
    }
  }

  /** Leaves the election and closes the stream (page hidden in the back/forward cache, frozen, or closing). */
  function stop() {
    if (!running) return;
    resign();
    running = false;
    releaseLock?.();
    releaseLock = null;
    lockAbort?.abort();
    lockAbort = null;
    clearInterval(tickTimer);
    channel?.close();
    channel = null;
    markRole();
  }

  // pagehide covers closing, reloading, navigating away and entering the back/forward cache; freeze covers a
  // background tab the browser suspends. Either way the stream must not keep a connection (or the lead) here.
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', (e) => e.persisted && start(true));
  document.addEventListener('freeze', stop);
  document.addEventListener('resume', () => start(true));

  start();

  return {
    resync() {
      if (leader) resyncNow();
      else post({ t: 'resync' });
    },
  };
}
