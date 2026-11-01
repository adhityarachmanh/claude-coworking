// The composer: prompt box, send, mode/model/effort controls, read-only state, composer keyboard.
import { api, toast } from '../core/api.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { DEMO_ID, READ_ONLY_HINT, state } from '../core/state.js';
import { setMobileView } from '../ui/layout.js';
import { attachments, clearAttachments } from './attachments.js';
import { localCommand } from './commands.js';
import { connection } from './connection.js';
import { draftSent, flushDraft, scheduleDraftSave } from './draft.js';
import { recall, recallPrompt } from './history.js';
import { renderResumeTurn } from './resume-turn.js';
import { openRewind } from './rewind.js';
import { confirmNew, renderSessionBar } from './sessions.js';
import { MODE_CYCLE, renderStatusline, renderTodos } from './statusline.js';
import { applySuggest, closeSuggest, renderSuggest, searchHistory, suggest } from './suggest.js';
import { backgroundRunning, renderTaskChip, renderTasks, tasksView } from './tasks.js';

// A shorter hint fits a phone-width composer on one line.
const applyPlaceholder = () => {
  $('#prompt').placeholder = state.readOnly ? READ_ONLY_HINT : narrow.matches ? 'Ketik pesan…  ( / command · @file )' : 'Minta sesuatu ke tim…   ( / command · @file · ! shell · Shift+Enter baris baru )';
  $('#prompt').rows = narrow.matches ? 1 : 3;
  autosize();
};
// On a phone the composer starts at one line and grows with the text, like a chat app.
export function autosize() {
  const input = $('#prompt');
  input.style.height = '';
  if (narrow.matches) input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

/** Puts text in the composer to edit before sending (starters, "Edit" on a sent prompt). */
export function fillComposer(text) {
  if (state.readOnly) return;
  if (narrow.matches) setMobileView('chat');
  const input = $('#prompt');
  input.value = text;
  input.focus();
  input.setSelectionRange(text.length, text.length);
  autosize();
  updateBashMode();
  scheduleDraftSave();
}

// ---------- composer ----------

export function renderComposer() {
  const isDemo = state.active === DEMO_ID;
  const st = state.statuses[state.active] ?? {};
  $('#composer').classList.toggle('demo', isDemo);
  $('#btn-stop').hidden = isDemo || !(st.busy || st.queue);
  $('#mode').value = st.mode ?? 'manual';
  renderModelOptions(st.model ?? '');
  $('#effort').value = st.effort ?? '';
  $('#team-mode').checked = st.team ?? true;
  const hint = [];
  // As in the CLI, a message sent mid-turn reaches Claude at its next step instead of waiting for the end.
  if (st.busy) hint.push(st.queue ? `Tim sedang bekerja — ${st.queue} pesan antre, dibaca Claude di langkah berikutnya.` : 'Tim sedang bekerja — pesan baru dibaca Claude di langkah berikutnya.');
  if (st.cliBusy) hint.push('Sesi di terminal sedang berjalan (izinnya dijawab di terminal).');
  if (st.autoApprove) hint.push('⚠ Semua izin otomatis di sesi ini.');
  if (state.readOnly) hint.unshift(`👁 ${READ_ONLY_HINT}.`);
  $('#composer-hint').textContent = hint.join('  ·  ');
  $('#typing').hidden = !(st.busy || st.cliBusy || st.compacting);
  $('#typing-text').textContent = st.compacting ? '✻ Memadatkan konteks percakapan…' : st.busy ? 'Tim sedang bekerja…' : 'Claude Code (terminal) sedang bekerja…';
  renderResumeTurn(st);
  renderTodos(st);
  renderStatusline(st);
  renderSessionBar();
  renderTaskChip(st);
  applyReadOnly();
  renderSendState();
  if (!$('#tasks-modal').hidden && tasksView.project === state.active) renderTasks();
}

// Controls that change something: disabled (with the reason as tooltip) for a phone on plain WiFi.
const ACTION_CONTROLS = ['#prompt', '#btn-send', '#btn-attach', '#btn-stop', '#mode', '#model', '#effort', '#team-mode', '#btn-new', '#btn-demo', '#ch-review', '#ch-message', '#ch-commit button', '#sessions-new', '#refresh-projects', '#team-reset', '#team-form button.primary'];

function applyReadOnly() {
  if (!state.readOnly) return; // fixed per connection: a laptop / Tailscale page never needs undoing
  for (const sel of ACTION_CONTROLS) {
    const el = $(sel);
    if (!el) continue;
    el.disabled = true;
    el.title = READ_ONLY_HINT;
  }
  applyPlaceholder();
}

const OFFLINE_HINT = 'Belum tersambung ke laptop — pesan belum dikirim, teksnya tetap di kotak';

/** Kirim waits for the connection (the text box stays usable, so typing carries on and is kept as a draft). */
export function renderSendState() {
  if (state.readOnly) return; // applyReadOnly owns the button there
  const send = $('#btn-send');
  send.disabled = !connection.online;
  send.title = connection.online ? '' : OFFLINE_HINT;
}

/** The /model picker: the models Claude Code itself offers for this account (Fable, Opus, Sonnet…). */
function renderModelOptions(current) {
  const select = $('#model');
  const models = state.config?.models ?? [];
  if (models.length) {
    const def = models.find((m) => m.value === 'default');
    const opts = [`<option value="" title="${escapeHtml(def?.description ?? '')}">Default${def ? ` (${escapeHtml(def.description.split('·')[0].trim())})` : ''}</option>`];
    for (const m of models) if (m.value !== 'default') opts.push(`<option value="${escapeHtml(m.value)}" title="${escapeHtml(m.description)}">${escapeHtml(m.displayName)}</option>`);
    // A model set with /model that the picker doesn't list (e.g. opus[1m] or a full id) stays selectable.
    if (current && !models.some((m) => m.value === current)) opts.push(`<option value="${escapeHtml(current)}">${escapeHtml(current)}</option>`);
    const html = opts.join('');
    if (select.dataset.html !== html) {
      select.innerHTML = html;
      select.dataset.html = html;
    }
  }
  select.value = current;
  // Effort only for models that support it (as the CLI greys it out).
  const chosen = models.find((m) => m.value === (current || 'default'));
  const noEffort = Boolean(chosen && !chosen.efforts?.length);
  $('#effort').disabled = noEffort || Boolean(state.readOnly);
  $('#effort').title = noEffort ? 'Model ini tidak mendukung pengaturan effort' : '';
}

function cycleMode() {
  const select = $('#mode');
  select.value = MODE_CYCLE[(MODE_CYCLE.indexOf(select.value) + 1) % MODE_CYCLE.length];
  saveSettings();
}

async function sendPrompt() {
  if (state.readOnly) return;
  const input = $('#prompt');
  const text = input.value.trim();
  if ((!text && !attachments.length) || state.active === DEMO_ID) return;
  // Offline the request could only fail: say so and keep everything as it is (text, images, draft).
  if (!connection.online) return toast(`${OFFLINE_HINT}.`);
  const project = state.active;
  flushDraft(); // the stored draft stays until the server has accepted the prompt (draftSent)
  if (!attachments.length && (localCommand(text) || text.startsWith('!'))) {
    input.value = '';
    recall.index = -1;
    autosize();
    closeSuggest();
    updateBashMode();
    const command = text.startsWith('!') ? text.slice(1).trim() : '';
    if (!command) return draftSent(project, text); // handled right here (a local /command)
    api(`/api/projects/${project}/shell`, { command }).then(
      () => draftSent(project, text),
      (err) => {
        input.value = text;
        updateBashMode();
        toast(`Gagal menjalankan: ${err.message}`);
      },
    );
    return;
  }
  const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  input.value = '';
  recall.index = -1;
  autosize();
  clearAttachments();
  closeSuggest();
  try {
    await api(`/api/projects/${project}/prompt`, { text, images });
    draftSent(project, text);
  } catch (err) {
    input.value = text;
    toast(`Gagal mengirim: ${err.message}`);
  }
}

export async function saveSettings() {
  try {
    await api(`/api/projects/${state.active}/settings`, { mode: $('#mode').value, model: $('#model').value, effort: $('#effort').value, team: $('#team-mode').checked });
  } catch (err) {
    toast(err.message);
  }
}

// Bash mode: a prompt starting with ! runs as a shell command; the box shows it.
export function updateBashMode() {
  $('#composer').classList.toggle('bash-mode', $('#prompt').value.startsWith('!'));
}

// When Esc was last pressed while idle (Esc Esc clears the box or opens Rewind).
let lastEsc = 0;

export function initComposerInput() {
  $('#prompt').addEventListener('input', autosize);
  narrow.addEventListener('change', applyPlaceholder);
  applyPlaceholder();
}

export function initComposerControls() {
  $('#prompt').addEventListener('keydown', (e) => {
    const plainArrow = (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
    if (plainArrow && !suggest.items.length && recallPrompt(e.key === 'ArrowUp' ? -1 : 1)) {
      e.preventDefault();
      return;
    }
    if (suggest.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        suggest.index = (suggest.index + (e.key === 'ArrowDown' ? 1 : -1) + suggest.items.length) % suggest.items.length;
        renderSuggest();
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        applySuggest();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSuggest();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendPrompt();
      return;
    }
    // Ctrl+R: search the prompt history (the browser's reload is not what you want while typing).
    if (e.key.toLowerCase() === 'r' && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      searchHistory();
    }
  });
  // Ctrl+B anywhere: the running Bash commands / subagents carry on in the background, as in the CLI.
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'b' || !e.ctrlKey || e.shiftKey || e.altKey || state.active === DEMO_ID || state.readOnly) return;
    if (!(state.statuses[state.active] ?? {}).busy) return;
    e.preventDefault();
    backgroundRunning();
  });
  // Esc stops the running turn, like in the CLI; Esc Esc when idle clears the box, or opens Rewind when it is empty.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || suggest.items.length || state.active === DEMO_ID || state.readOnly) return;
    if (document.querySelector('.modal:not([hidden])')) return; // Esc closes the dialog instead
    const st = state.statuses[state.active] ?? {};
    if (st.busy || st.queue) {
      api(`/api/projects/${state.active}/stop`).catch((err) => toast(err.message));
      return;
    }
    const now = Date.now();
    if (now - lastEsc > 500) {
      lastEsc = now;
      return;
    }
    lastEsc = 0;
    const input = $('#prompt');
    if (input.value.trim()) {
      input.value = '';
      autosize();
      updateBashMode();
      scheduleDraftSave();
      input.focus();
    } else openRewind();
  });

  // Shift+Tab cycles the permission mode, like in the CLI (only from the prompt box, so Tab navigation still works elsewhere).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !e.shiftKey || e.defaultPrevented || state.active === DEMO_ID || state.readOnly) return; // defaultPrevented: Tab picked an autocomplete item
    if (e.target !== $('#prompt') && e.target !== document.body) return;
    e.preventDefault();
    cycleMode();
  });

  $('#prompt').addEventListener('input', updateBashMode);
  $('#btn-send').addEventListener('click', sendPrompt);
  $('#btn-stop').addEventListener('click', () => api(`/api/projects/${state.active}/stop`).catch((err) => toast(err.message)));
  $('#btn-new').addEventListener('click', () => {
    if (confirmNew()) api(`/api/projects/${state.active}/reset`).catch((err) => toast(err.message));
  });
  $('#btn-demo').addEventListener('click', () => api('/api/demo').catch((err) => toast(err.message)));
  for (const id of ['#mode', '#model', '#effort', '#team-mode']) $(id).addEventListener('change', saveSettings);
}
