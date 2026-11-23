// ⚙️ Flag Claude per project: spawn arguments (--fallback-model, --max-turns, --max-budget-usd, --tools,
// --allowedTools, --disallowedTools, --setting-sources) stored as project settings and passed at spawn
// (server: src/hub.js cleanSettings, src/session.js). Claude Code only.
import { api, toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { projectEngine } from './engine.js';

const set = (id, value) => {
  $(id).value = value == null ? '' : String(value);
};
const lines = (id) => $(id).value.split('\n').map((s) => s.trim()).filter(Boolean);

function render() {
  const st = state.statuses[state.active] ?? {};
  $('#claude-flags-project').textContent = state.active ? `· ${projectName(state.active)}` : '';
  set('#cf-fallback', st.claudeFallbackModel ?? '');
  set('#cf-max-turns', st.claudeMaxTurns ?? '');
  set('#cf-budget', st.claudeMaxBudgetUsd ?? '');
  set('#cf-tools', st.claudeTools ?? '');
  $('#cf-allowed').value = (st.claudeAllowedTools ?? []).join('\n');
  $('#cf-disallowed').value = (st.claudeDisallowedTools ?? []).join('\n');
  set('#cf-sources', st.claudeSettingSources ?? '');
  set('#cf-advisor', st.claudeAdvisor ?? '');
  $('#cf-fast').checked = st.claudeFastMode === true;
  $('#cf-suggest').checked = st.claudePromptSuggestions === true;
  set('#cf-autocompact', st.claudeAutocompact ?? '');
  $('#cf-hook-events').checked = st.claudeIncludeHookEvents === true;
  $('#claude-flags-error').textContent = '';
}

export async function openClaudeFlags() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (state.readOnly) return toast('Flag Claude hanya bisa diubah dari laptop atau lewat Tailscale.', 'warn');
  if (projectEngine() !== 'claude') return toast('Flag Claude hanya tersedia saat model Claude aktif.', 'warn');
  openModal('claude-flags-modal');
  render();
}

async function save() {
  const maxTurns = $('#cf-max-turns').value.trim();
  const budget = $('#cf-budget').value.trim();
  const tools = $('#cf-tools').value.trim();
  const fallback = $('#cf-fallback').value.trim();
  const sources = $('#cf-sources').value.trim();
  const advisor = $('#cf-advisor').value.trim();
  const body = {
    claudeFallbackModel: fallback,
    claudeMaxTurns: maxTurns ? Number(maxTurns) : null,
    claudeMaxBudgetUsd: budget ? Number(budget) : null,
    claudeTools: tools || null,
    claudeAllowedTools: lines('#cf-allowed'),
    claudeDisallowedTools: lines('#cf-disallowed'),
    claudeSettingSources: sources || null,
    claudeAdvisor: advisor,
    claudeFastMode: $('#cf-fast').checked,
    claudePromptSuggestions: $('#cf-suggest').checked,
    claudeAutocompact: $('#cf-autocompact').value.trim() || null,
    claudeIncludeHookEvents: $('#cf-hook-events').checked,
  };
  try {
    await api(`/api/projects/${state.active}/settings`, body);
    toast('Flag Claude tersimpan. Berlaku pada pesan berikutnya.', 'ok');
    $('#claude-flags-modal [data-close]')?.click();
  } catch (err) {
    $('#claude-flags-error').textContent = err.message;
  }
}

export function initClaudeFlags() {
  $('#claude-flags-save').addEventListener('click', save);
  $('#auto-mode-save').addEventListener('click', saveAutoMode);
}

const amLines = (id) => $(id).value.split('\n').map((s) => s.trim()).filter(Boolean);

export async function openAutoMode() {
  if (state.readOnly) return toast('Auto mode Claude hanya bisa diubah dari laptop.', 'warn');
  if (projectEngine() !== 'claude') return toast('Auto mode hanya tersedia saat model Claude aktif.', 'warn');
  openModal('auto-mode-modal');
  $('#auto-mode-error').textContent = '';
  try {
    const data = await api('/api/claude/auto-mode');
    $('#am-environment').value = (data.environment ?? []).join('\n');
    $('#am-allow').value = (data.allow ?? []).join('\n');
    $('#am-soft').value = (data.softDeny ?? []).join('\n');
    $('#am-hard').value = (data.hardDeny ?? []).join('\n');
    $('#am-classify').checked = data.classifyAllShell === true;
  } catch (err) {
    $('#auto-mode-error').textContent = err.message;
  }
}

async function saveAutoMode() {
  try {
    await api('/api/claude/auto-mode/save', {
      environment: amLines('#am-environment'),
      allow: amLines('#am-allow'),
      softDeny: amLines('#am-soft'),
      hardDeny: amLines('#am-hard'),
      classifyAllShell: $('#am-classify').checked,
    });
    toast('Aturan Auto mode tersimpan.', 'ok');
    $('#auto-mode-modal [data-close]')?.click();
  } catch (err) {
    $('#auto-mode-error').textContent = err.message;
  }
}
