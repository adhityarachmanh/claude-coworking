// ⏰ OpenCode automations (2.4): list schedules and create/pause/resume/delete them from the app. OpenCode owns the
// timer and the runs; the dialog only wraps its API (server: src/opencode-automations.js).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { projectEngine } from './engine.js';

let rows = [];
let mcpNames = null; // server names of this project, asked once per dialog open (null = not asked yet)

const fmtAt = (ts) => (Number.isFinite(ts) ? new Date(ts).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : '');
const OUTCOME = { fired: 'jalan', late: 'terlambat', skipped: 'dilewati', disabled: 'nonaktif', failed: 'gagal', expired: 'kedaluwarsa' };

function triggerText(t) {
  if (!t) return '';
  if (t.type === 'at') return `Sekali: ${t.at}`;
  if (t.type === 'every') return `Tiap ${t.every}`;
  if (t.type === 'cron') return `Cron ${t.cron}${t.tz ? ` (${t.tz})` : ''}`;
  if (t.type === 'event') return `Event ${t.server}/${t.event}`;
  return t.type;
}

function render() {
  const list = $('#oc-auto-list');
  if (!rows.length) {
    list.innerHTML = '<li class="muted small">Belum ada automation di project ini.</li>';
    return;
  }
  list.innerHTML = rows
    .map((a) => {
      const next = a.status === 'active' && a.nextDueAt ? ` · berikutnya ${fmtAt(a.nextDueAt)}` : '';
      const last = a.lastOutcome ? ` · terakhir ${OUTCOME[a.lastOutcome] ?? a.lastOutcome}${a.lastRunAt ? ` ${fmtAt(a.lastRunAt)}` : ''}` : '';
      const output = a.lastOutput ? `<small class="muted auto-out">${escapeHtml(a.lastOutput.split('\n')[0].slice(0, 160))}</small>` : '';
      const actions = state.local
        ? `<span class="perm-acts">${
            a.status === 'active'
              ? `<button type="button" class="ghost" data-auto-act="pause" data-id="${escapeHtml(a.id)}">Jeda</button>`
              : a.status === 'paused'
                ? `<button type="button" class="ghost" data-auto-act="resume" data-id="${escapeHtml(a.id)}">Lanjutkan</button>`
                : ''
          }<button type="button" class="ghost danger-text" data-auto-act="delete" data-id="${escapeHtml(a.id)}">Hapus</button></span>`
        : '';
      return `<li class="auto-row" data-id="${escapeHtml(a.id)}"><div><b>${escapeHtml(a.name)}</b> <small class="muted">${escapeHtml(a.status)} · ${escapeHtml(triggerText(a.trigger))}${escapeHtml(next + last)}</small>${output}</div>${actions}</li>`;
    })
    .join('');
}

async function load() {
  $('#oc-auto-error').textContent = '';
  try {
    const data = await api('/api/opencode-automations');
    rows = Array.isArray(data.automations) ? data.automations : [];
    render();
  } catch (err) {
    rows = [];
    $('#oc-auto-list').innerHTML = '';
    $('#oc-auto-error').textContent = err.message;
  }
}

/** The project's MCP servers as a datalist, so an event trigger does not have to be typed from memory. */
async function loadMcpNames() {
  if (mcpNames) return mcpNames;
  try {
    const data = await api(`/api/projects/${state.active}/mcp`);
    mcpNames = (Array.isArray(data.servers) ? data.servers : []).map((s) => String(s?.name ?? '')).filter(Boolean).slice(0, 100);
  } catch {
    mcpNames = []; // status unavailable: free typing still works
  }
  const list = $('#oc-auto-server-list');
  if (list) list.innerHTML = mcpNames.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
  return mcpNames;
}

function syncFields() {
  const trigger = $('#oc-auto-trigger').value;
  for (const box of document.querySelectorAll('[data-trigger-field]')) box.hidden = box.dataset.triggerField !== trigger;
  const action = $('#oc-auto-action').value;
  for (const box of document.querySelectorAll('[data-action-field]')) box.hidden = box.dataset.actionField !== action;
  if (trigger === 'event') loadMcpNames();
}

async function save() {
  const name = $('#oc-auto-name').value.trim();
  const type = $('#oc-auto-trigger').value;
  const trigger = { type };
  if (type === 'every') trigger.every = $('#oc-auto-every').value.trim();
  else if (type === 'cron') trigger.cron = $('#oc-auto-cron').value.trim();
  else if (type === 'at') trigger.at = $('#oc-auto-at').value.trim();
  else {
    trigger.server = $('#oc-auto-server').value.trim();
    trigger.event = $('#oc-auto-event').value.trim();
  }
  const actionType = $('#oc-auto-action').value;
  const action = actionType === 'code' ? { type: 'code', code: $('#oc-auto-code').value } : { type: 'prompt', prompt: $('#oc-auto-prompt').value };
  const expires = $('#oc-auto-expires').value.trim();
  const body = { project: state.active, name, trigger, action, ...(expires ? { expires } : {}) };
  $('#oc-auto-save').disabled = true;
  $('#oc-auto-error').textContent = '';
  try {
    await api('/api/opencode-automations/save', body);
    $('#oc-auto-name').value = '';
    $('#oc-auto-prompt').value = '';
    $('#oc-auto-code').value = '';
    $('#oc-auto-every').value = '';
    $('#oc-auto-cron').value = '';
    $('#oc-auto-at').value = '';
    $('#oc-auto-server').value = '';
    $('#oc-auto-event').value = '';
    $('#oc-auto-expires').value = '';
    toast('Automation tersimpan di OpenCode.', 'ok');
    await load();
  } catch (err) {
    $('#oc-auto-error').textContent = err.message;
  } finally {
    $('#oc-auto-save').disabled = false;
  }
}

async function act(id, action) {
  if (!id) return;
  if (action === 'delete' && !window.confirm('Hapus automation ini dari OpenCode?')) return;
  try {
    await api('/api/opencode-automations/action', { id, action });
    await load();
  } catch (err) {
    $('#oc-auto-error').textContent = err.message;
  }
}

export function openAutomations() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (projectEngine() !== 'opencode') return toast('Automation hanya tersedia untuk project OpenCode.', 'warn');
  if (state.config?.engines?.opencode?.available === false) return toast('OpenCode tidak terpasang di laptop ini.', 'warn');
  openModal('oc-automations-modal');
  $('#oc-auto-title').textContent = `Automation OpenCode · ${projectName(state.active)}`;
  $('#oc-auto-create').hidden = !state.local;
  mcpNames = null; // this dialog may have opened for another project
  const names = $('#oc-auto-server-list');
  if (names) names.innerHTML = '';
  syncFields();
  load();
}

export function initAutomations() {
  $('#oc-auto-trigger').addEventListener('change', syncFields);
  $('#oc-auto-action').addEventListener('change', syncFields);
  $('#oc-auto-save').addEventListener('click', save);
  $('#oc-auto-list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-auto-act]');
    if (button) act(button.dataset.id, button.dataset.autoAct);
  });
}
