// The server event stream (SSE): snapshot on connect, then live updates routed to the features.
import { onAccountAlert, onAccountState, renderAccountButton } from '../features/account.js';
import { appendActivity } from '../features/activity.js';
import { scheduleChanges } from '../features/changes.js';
import { appendChat, replaceChat } from '../features/chat.js';
import { renderComposer } from '../features/composer.js';
import { notify } from '../features/notify.js';
import { phone, refreshPairing } from '../features/phone.js';
import { renderSidebar, selectProject } from '../features/picker.js';
import { renderRoots } from '../features/settings.js';
import { applyNames } from '../features/team.js';
import { applyTeamNames, roleName } from '../office/cast.js';
import { updateTitle } from '../ui/layout.js';
import { setReadOnlyApi } from './api.js';
import { $ } from './dom.js';
import { scenes } from './scenes.js';
import { DEMO_ID, projectName, state } from './state.js';

export function connect() {
  const source = new EventSource('/stream');
  const conn = $('#conn');
  source.addEventListener('open', () => {
    conn.textContent = 'terhubung';
    conn.className = 'pill ok';
  });
  source.addEventListener('error', () => {
    conn.textContent = 'server mati — jalankan start-office';
    conn.className = 'pill bad';
  });
  const on = (type, fn) => source.addEventListener(type, (msg) => fn(JSON.parse(msg.data)));

  on('config', (config) => {
    renderRoots(config);
    applyNames(config);
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
    state.projects = snap.projects;
    state.statuses = snap.statuses;
    state.chats = snap.chats;
    state.events = snap.events;
    state.approvals = new Map(snap.approvals.map((a) => [a.id, a]));
    scenes.clear();
    const remembered = location.hash.slice(1) || localStorage.getItem('office.active');
    selectProject(state.projects.some((p) => p.id === remembered) ? remembered : DEMO_ID);
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
    if (msg.project === state.active) appendChat(msg);
    if (msg.kind === 'result') {
      notify(msg.ok ? 'done' : 'error', msg.ok ? `✓ Tugas selesai — ${projectName(msg.project)}` : `■ Tugas berhenti — ${projectName(msg.project)}`, msg.ok ? 'Tim sudah menyelesaikan permintaanmu.' : msg.text || 'Cek chat untuk detailnya.', msg.project);
    } else if (msg.kind === 'error') {
      notify('error', `⚠ Ada kendala — ${projectName(msg.project)}`, msg.text.slice(0, 120), msg.project);
    }
    renderSidebar();
  });
  on('chat_update', ({ project, id, patch }) => {
    const msg = state.chats[project]?.findLast((m) => m.id === id);
    if (!msg) return;
    Object.assign(msg, patch);
    if (project === state.active) replaceChat(msg);
  });
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
