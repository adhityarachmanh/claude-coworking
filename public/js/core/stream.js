// The server event stream (SSE): snapshot on connect, then live updates routed to the features.
// One stream per browser, shared by every tab of this origin (core/stream-share.js).
import { onAccountAlert, onAccountState, renderAccountButton } from '../features/account.js';
import { appendActivity } from '../features/activity.js';
import { scheduleAttention, loadAttention } from '../features/attention.js';
import { scheduleChanges } from '../features/changes.js';
import { appendChat, renderChat, replaceChat, scheduleReplace } from '../features/chat.js';
import { applyClaudeCheck } from '../features/claude-check.js';
import { applyOpenCodeCheck } from '../features/opencode-check.js';
import { applyAppUpdate } from '../features/app-update.js';
import { renderComposer } from '../features/composer.js';
import { retryDelay, streamLost, streamOpened } from '../features/connection.js';
import { notify } from '../features/notify.js';
import { answerForResult, speakAnswer } from '../features/tts.js';
import { phone, refreshPairing } from '../features/phone.js';
import { renderSidebar, selectProject } from '../features/picker.js';
import { onApprovalUpdate, onPushSnapshot, pushProjectsChanged } from '../features/push.js';
import { applyRoutines } from '../features/routines.js';
import { applySetup } from '../features/setup.js';
import { renderRoots, syncConcurrencySection } from '../features/settings.js';
import { maybeAutoTour } from '../features/tour.js';
import { applyRoster } from '../features/roster.js';
import { applySpotify } from '../features/spotify.js';
import { reloadSoon } from '../features/opencode-account.js';
import { engineChangeNeedsReload } from './engine-caps.js';
import { onGithubLogin } from '../features/pull-request.js';
import { onQueueEvent } from '../features/queue-all.js';
import { onRoleMapChanged } from '../features/role-map.js';
import { renderCi } from '../features/ci-status.js';
import { noteLiveMessage, setStuckOnline } from '../features/stuck.js';
import { applyNames } from '../features/team.js';
import { applyTeamNames, roleName } from '../office/cast.js';
import { updateTitle } from '../ui/layout.js';
import { setReadOnlyApi } from './api.js';
import { $ } from './dom.js';
import { startStreamShare } from './stream-share.js';
import { brain, scenes } from './scenes.js';
import { DEMO_ID, projectName, state } from './state.js';

let share = null;

/**
 * Adds one chat message to the project's timeline, or updates the newest message with the same id (the snapshot and
 * the live stream can both carry it). Returns `{ message, added }`: `added` false means no second row was created.
 */
export function mergeChatMessage(msg) {
  const list = (state.chats[msg.project] ??= []);
  const known = list.findLast((m) => m.id === msg.id);
  if (known) {
    Object.assign(known, msg);
    return { message: known, added: false };
  }
  list.push(msg);
  return { message: msg, added: true };
}

// One handler per server event. `live` is false while a tab that just joined replays what it missed
// (core/stream-share.js): the state catches up, but old news never chimes or animates again.
const handlers = {
  routines: (list) => {
    applyRoutines(list);
    scheduleAttention();
  },
  config(config) {
    renderRoots(config);
    renderComposer(); // ⭐/🔧 config fields the composer renders (favorite models) arrive with the same push
    applyNames(config);
    applyRoster(config.team); // 👥 Kelola tim saved somewhere: the office gets or loses desks, no reload
    applyClaudeCheck(config.claudeCheck); // Claude Code updated: contract check result (banner + ⚙)
    applyOpenCodeCheck(config.opencodeCheck); // the same for OpenCode (silent when not installed)
    applyAppUpdate(config.appUpdate); // ⬆ a newer Adhitron: banner + ⚙
    applySetup(config.setup); // 🧰 Persiapan: Node/Claude/OpenCode/Tailscale + a running install
    if (!$('#phone-modal').hidden) {
      phone.pairing = null; // a device just paired (codes are single-use) or settings changed
      refreshPairing();
    }
  },
  snapshot(snap) {
    // Opened from a paired phone: laptop-only settings are hidden (the server refuses them anyway).
    state.local = snap.client?.local !== false;
    state.accountAuth = snap.client?.accountAuth ?? state.local; // laptop, or a phone over Tailscale
    state.readOnly = snap.client?.readOnly === true; // a phone on plain WiFi: look, don't act
    state.secure = snap.client?.secure === true; // the https (Tailscale) origin
    state.push = snap.client?.push ?? null; // https: this device's subscription as the server knows it
    setReadOnlyApi(snap.client?.readOnlyApi); // what such a phone may still call: the server's own list
    document.body.classList.toggle('remote-client', !state.local);
    document.body.classList.toggle('read-only', state.readOnly);
    $('#btn-phone').hidden = !state.local;
    $('#btn-settings').hidden = !state.local;
    state.account = snap.account ?? null;
    renderRoots(snap.config);
    applyTeamNames(snap.config?.teamNames); // before the first render, so nothing shows the old names
    applyRoster(snap.config?.team, { rebuild: false }); // desks for the active team; the scenes are rebuilt below
    state.projects = snap.projects;
    maybeAutoTour(); // a truly fresh install (no projects) gets the four-step tour once
    state.statuses = snap.statuses;
    state.chats = snap.chats;
    state.events = snap.events;
    state.approvals = new Map(snap.approvals.map((a) => [a.id, a]));
    scenes.clear();
    const remembered = location.hash.slice(1) || localStorage.getItem('office.active');
    selectProject(state.projects.some((p) => p.id === remembered) ? remembered : DEMO_ID);
    onPushSnapshot(); // a notification's ?p=&ap= wins over the remembered project; https: resubscribe once
    setStuckOnline(true);
    renderAccountButton(); // after the core UI, so a profile quirk can never blank the office
    applySpotify(snap.spotify, { snapshot: true }); // ♪ absent = this server has no Spotify support
    applyClaudeCheck(snap.config?.claudeCheck); // after state.readOnly: WiFi gets the passive notice
    applyOpenCodeCheck(snap.config?.opencodeCheck);
    applyAppUpdate(snap.config?.appUpdate); // ⬆ a newer Adhitron (banner)
    applySetup(snap.config?.setup); // 🧰 Persiapan (may open itself once on a fresh local install)
    loadAttention(); // after state.readOnly: a WiFi page skips it instead of earning a 403
  },
  'pairing-reset'() {
    // Too many wrong codes on a phone: the shown code is dead, show the new one right away.
    if ($('#phone-modal').hidden) return;
    phone.pairing = null;
    refreshPairing();
  },
  account(s, live) {
    if (live) return onAccountState(s);
    state.account = { ...state.account, ...s }; // replayed: the state only, no "Login berhasil" toast for old news
    renderAccountButton();
  },
  spotify: (s) => applySpotify(s),
  'account-alert': (alert, live) => live && onAccountAlert(alert),
  // Akun changed the DEFAULT engine (this or another device): a fresh page shows the new default.
  // ONE project changing engine also emits `engine` with its id. The status/projects events update in place, but
  // chat/activity/history keep the old engine's cache; reload every open client so two windows never diverge and
  // look like one of them rolled the switch back.
  engine: (data, live) => live && engineChangeNeedsReload(data) && reloadSoon(),
  'github-login': (login, live) => live && onGithubLogin(login), // ⇡ PR dialog: gh login finished / failed
  'role-map': (data, live) => live && onRoleMapChanged(), // 🧭 the AI mapped names / another device changed the map
  projects(projects) {
    state.projects = projects;
    // Another tab may have purged/forgotten the project this tab is showing: do not stay on a dead page.
    if (state.active !== DEMO_ID && !projects.some((p) => p.id === state.active)) selectProject(DEMO_ID);
    renderSidebar();
    pushProjectsChanged(); // favourites changed: a phone with push tells the server
  },
  status(status) {
    state.statuses[status.project] = status;
    scenes.get(status.project)?.setStatus(status);
    renderSidebar();
    if (status.project === state.active) {
      renderComposer();
      renderCi();
    }
    if (!$('#settings-modal').hidden) syncConcurrencySection(); // ⚡ "Saat ini X dari Y project sedang bekerja."
    updateTitle();
    scheduleAttention();
  },
  office(evt, live) {
    (state.events[evt.project] ??= []).push(evt);
    scenes.get(evt.project)?.handle(evt, live);
    if (live && evt.project === state.active) brain.event(evt); // 🧠 Mode Otak: signals and pulses
    if (evt.project === state.active) {
      appendActivity(evt, true);
      if (['tool_end', 'stop'].includes(evt.kind)) scheduleChanges();
    }
  },
  chat(msg, live) {
    // The snapshot already holds the messages up to now: the same message arriving again (snapshot + stream) must
    // not double the row. A known id updates its newest row instead of pushing a second one.
    const { added, message } = mergeChatMessage(msg);
    if (!added) {
      if (msg.project === state.active) scheduleReplace(message);
      renderSidebar();
      return;
    }
    if (live) noteLiveMessage(msg); // a sample of the browser/server clock difference (stuck detector)
    if (msg.project === state.active) appendChat(msg);
    if (!live) {
      // replayed history: no notification for it
    } else if (msg.kind === 'result') {
      notify(msg.ok ? 'done' : 'error', msg.ok ? `✓ Tugas selesai — ${projectName(msg.project)}` : `■ Tugas berhenti — ${projectName(msg.project)}`, msg.ok ? 'Tim sudah menyelesaikan permintaanmu.' : msg.text || 'Cek chat untuk detailnya.', msg.project);
      // 🔊 TTS reads the finished answer of the project on screen; the raw streaming text is never read.
      // Only an assistant message after the previous result belongs to this turn: an empty turn must not re-read an old answer.
      if (msg.ok && msg.project === state.active) {
        const last = answerForResult(state.chats[msg.project], msg);
        if (last) speakAnswer(last.text);
      }
    } else if (msg.kind === 'error') {
      notify('error', `⚠ Ada kendala — ${projectName(msg.project)}`, msg.text.slice(0, 120), msg.project);
    }
    renderSidebar();
    if (live) scheduleAttention();
  },
  chat_update: (update) => onChatUpdate(update),
  // Any project's queue changed: 🌐 Semua antrian redraws itself while it is open (debounced there).
  queue: () => onQueueEvent(),
  // ▶ A queued item really started: only the "Antrian mulai" event (off by default) shows a popup/sound.
  'queue-start': (data) => notify('queue', `▶ Antrian mulai — ${projectName(data.project)}`, 'Item yang menunggu mulai berjalan.', data.project),
  chat_reset({ project }) {
    state.chats[project] = [];
    if (project === state.active) renderChat();
  },
  // Retention pruned old messages: drop exactly those ids, keeping everything else the page already shows.
  chat_prune({ project, ids }) {
    const list = state.chats[project];
    if (!Array.isArray(list) || !Array.isArray(ids) || !ids.length) return;
    const drop = new Set(ids);
    for (let i = list.length - 1; i >= 0; i -= 1) if (drop.has(list[i]?.id)) list.splice(i, 1);
    if (project === state.active) renderChat();
  },
  approval(approval, live) {
    if (live && approval.status === 'pending' && !state.approvals.has(approval.id)) {
      notify('ask', `✋ ${roleName(approval.role)} minta izin — ${projectName(approval.project)}`, approval.label, approval.project);
    }
    if (live) onApprovalUpdate(state.approvals.get(approval.id), approval); // "Dijawab dari HP (…)" on the laptop
    state.approvals.set(approval.id, approval);
    if (approval.project === state.active) {
      const msg = state.chats[approval.project]?.findLast((m) => m.approvalId === approval.id);
      if (msg) replaceChat(msg);
    }
    updateTitle();
    renderSidebar();
    scheduleAttention();
  },
};

/**
 * Connects to the server's event stream. Every tab of this origin shares one (core/stream-share.js): the browser's
 * 6-connections-per-host limit on HTTP/1.1 would otherwise let a few open tabs block every other request.
 */
export function connect() {
  share ??= startStreamShare({
    url: '/stream',
    types: Object.keys(handlers),
    apply: (type, raw, live) => handlers[type](JSON.parse(raw), live),
    online(on) {
      if (on) return streamOpened();
      streamLost();
      setStuckOnline(false); // the stuck detector waits for the fresh snapshot (the chat may be stale)
    },
    retryDelay,
  });
}

// Server ids count up (`m<n>`): an unknown id newer than the oldest message this page holds falls inside the
// window the page should have, so the page missed it; an older one simply fell out of the snapshot window.
const idNumber = (id) => Number(/^m(\d+)$/.exec(id ?? '')?.[1] ?? 0);

/** A live change to a chat message; one this page never received is fetched again instead of dropped. */
export function onChatUpdate({ project, id, patch }) {
  const list = state.chats[project] ?? [];
  const msg = list.findLast((m) => m.id === id);
  if (msg) {
    Object.assign(msg, patch);
    if (project === state.active) scheduleReplace(msg);
    return;
  }
  const oldest = list.length ? Math.min(...list.map((m) => idNumber(m.id))) : 0;
  if (idNumber(id) > oldest) resync();
}

/** A fresh snapshot from the server (the stream's leader tab reopens it; rate-limited there). */
function resync() {
  share?.resync();
}
