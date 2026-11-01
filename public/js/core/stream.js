// The server event stream (SSE): snapshot on connect, then live updates routed to the features.
import { onAccountAlert, onAccountState, renderAccountButton } from '../features/account.js';
import { appendActivity } from '../features/activity.js';
import { scheduleChanges } from '../features/changes.js';
import { appendChat, replaceChat, scheduleReplace } from '../features/chat.js';
import { renderComposer } from '../features/composer.js';
import { retryDelay, streamLost, streamOpened } from '../features/connection.js';
import { notify } from '../features/notify.js';
import { phone, refreshPairing } from '../features/phone.js';
import { renderSidebar, selectProject } from '../features/picker.js';
import { renderRoots } from '../features/settings.js';
import { applyRoster } from '../features/roster.js';
import { noteLiveMessage, setStuckOnline } from '../features/stuck.js';
import { applyNames } from '../features/team.js';
import { applyTeamNames, roleName } from '../office/cast.js';
import { updateTitle } from '../ui/layout.js';
import { setReadOnlyApi } from './api.js';
import { $ } from './dom.js';
import { scenes } from './scenes.js';
import { DEMO_ID, projectName, state } from './state.js';

let source = null;

export function connect() {
  source = new EventSource('/stream');
  const self = source;
  source.addEventListener('open', streamOpened);
  source.addEventListener('error', () => {
    streamLost();
    setStuckOnline(false); // the stuck detector waits for the fresh snapshot (the chat may be stale)
    // A network error is retried by the browser itself (readyState CONNECTING). A refused stream (an HTTP error
    // instead of the event stream) is not: it stays CLOSED for good, so open a new one after a pause.
    if (self === source && self.readyState === EventSource.CLOSED) setTimeout(connect, retryDelay());
  });
  const on = (type, fn) => self.addEventListener(type, (msg) => fn(JSON.parse(msg.data)));

  on('config', (config) => {
    renderRoots(config);
    applyNames(config);
    applyRoster(config.team); // 👥 Kelola tim saved somewhere: the office gets or loses desks, no reload
    if (!$('#phone-modal').hidden) {
      phone.pairing = null; // a device just paired (codes are single-use) or settings changed
      refreshPairing();
    }
  });
  on('snapshot', (snap) => {
    // Opened from a paired phone: laptop-only settings are hidden (the server refuses them anyway).
    state.local = snap.client?.local !== false;
    state.accountAuth = snap.client?.accountAuth ?? state.local; // laptop, or a phone over Tailscale
    state.readOnly = snap.client?.readOnly === true; // a phone on plain WiFi: look, don't act
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
    state.statuses = snap.statuses;
    state.chats = snap.chats;
    state.events = snap.events;
    state.approvals = new Map(snap.approvals.map((a) => [a.id, a]));
    scenes.clear();
    const remembered = location.hash.slice(1) || localStorage.getItem('office.active');
    selectProject(state.projects.some((p) => p.id === remembered) ? remembered : DEMO_ID);
    setStuckOnline(true);
    renderAccountButton(); // after the core UI, so a profile quirk can never blank the office
  });
  on('pairing-reset', () => {
    // Too many wrong codes on a phone: the shown code is dead, show the new one right away.
    if ($('#phone-modal').hidden) return;
    phone.pairing = null;
    refreshPairing();
  });
  on('account', onAccountState);
  on('account-alert', onAccountAlert);
  on('projects', (projects) => {
    state.projects = projects;
    renderSidebar();
  });
  on('status', (status) => {
    state.statuses[status.project] = status;
    scenes.get(status.project)?.setStatus(status);
    renderSidebar();
    if (status.project === state.active) renderComposer();
    updateTitle();
  });
  on('office', (evt) => {
    (state.events[evt.project] ??= []).push(evt);
    scenes.get(evt.project)?.handle(evt, true);
    if (evt.project === state.active) {
      appendActivity(evt, true);
      if (['tool_end', 'stop'].includes(evt.kind)) scheduleChanges();
    }
  });
  on('chat', (msg) => {
    (state.chats[msg.project] ??= []).push(msg);
    noteLiveMessage(msg); // a sample of the browser/server clock difference (stuck detector)
    if (msg.project === state.active) appendChat(msg);
    if (msg.kind === 'result') {
      notify(msg.ok ? 'done' : 'error', msg.ok ? `✓ Tugas selesai — ${projectName(msg.project)}` : `■ Tugas berhenti — ${projectName(msg.project)}`, msg.ok ? 'Tim sudah menyelesaikan permintaanmu.' : msg.text || 'Cek chat untuk detailnya.', msg.project);
    } else if (msg.kind === 'error') {
      notify('error', `⚠ Ada kendala — ${projectName(msg.project)}`, msg.text.slice(0, 120), msg.project);
    }
    renderSidebar();
  });
  on('chat_update', onChatUpdate);
  on('approval', (approval) => {
    if (approval.status === 'pending' && !state.approvals.has(approval.id)) {
      notify('ask', `✋ ${roleName(approval.role)} minta izin — ${projectName(approval.project)}`, approval.label, approval.project);
    }
    state.approvals.set(approval.id, approval);
    if (approval.project === state.active) {
      const msg = state.chats[approval.project]?.findLast((m) => m.approvalId === approval.id);
      if (msg) replaceChat(msg);
    }
    updateTitle();
    renderSidebar();
  });
}

// Server ids count up (`m<n>`): an unknown id newer than the oldest message this page holds falls inside the
// window the page should have, so the page missed it; an older one simply fell out of the snapshot window.
const idNumber = (id) => Number(/^m(\d+)$/.exec(id ?? '')?.[1] ?? 0);
const RESYNC_GAP_MS = 5000;
let lastResync = 0;

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

/** Reopens the event stream: its snapshot carries every message as the server has it now. */
function resync() {
  if (Date.now() - lastResync < RESYNC_GAP_MS) return;
  lastResync = Date.now();
  source?.close();
  connect();
}
