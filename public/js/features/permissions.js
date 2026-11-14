// 🛡️ Aturan izin (/permissions): Claude Code's saved allow / ask / deny rules per settings file — what
// "Izinkan selalu" on a permission card stores. Anyone may look; only the laptop may change them
// (the server refuses `permissions-edit` from every other device).
import { api, toast } from '../core/api.js';
import { PERMISSION_PRESETS, planPreset } from '../core/permission-presets.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { guardCap } from './engine.js';

const perm = { project: null, scopes: [], busy: false, plan: null };
const LISTS = [
  ['allow', 'allow', 'jalan tanpa bertanya'],
  ['ask', 'ask', 'selalu tanya'],
  ['deny', 'deny', 'selalu ditolak'],
];
const LIST_TONE = { allow: 'ok', ask: 'warn', deny: 'bad' };
// Same format the server checks (src/permissions.js): `Tool` or `Tool(pattern)`.
const RULE = /^[A-Za-z][\w-]*(\([^\u0000-\u001f\u007f]+\))?$/;
const APPLIED = {
  restarted: 'Claude Code project ini dimulai ulang agar aturan langsung berlaku.',
  pending: 'Berlaku setelah giliran / tugas latar yang berjalan selesai.',
  none: 'Berlaku saat Claude Code berikutnya dijalankan.',
};

export function openPermissions() {
  if (guardCap('permissions')) return;
  if (state.active === DEMO_ID) return toast('Demo tidak punya aturan izin. Pilih project sungguhan.');
  perm.project = state.active;
  const name = state.projects.find((p) => p.id === perm.project)?.name ?? '';
  $('#perm-project').textContent = name ? `· ${name}` : '';
  // Changing rules changes what Claude Code may do without asking: laptop only (the server enforces it).
  $('#perm-add').hidden = !state.local;
  $('#perm-ro').hidden = state.local;
  $('#perm-add-error').textContent = '';
  perm.plan = null; // a preset plan from the previous project is meaningless here
  $('#perm-presets').hidden = !state.local; // presets write rules: laptop only, like the add form
  renderPresetPlan();
  closeModal('settings-modal'); // opened from ⚙: one dialog at a time
  openModal('perm-modal');
  loadPermissions();
}

async function loadPermissions() {
  const project = perm.project;
  const list = $('#perm-list');
  if (!perm.scopes.length || list.dataset.project !== project) list.innerHTML = '<p class="muted"><span class="spinner" aria-hidden="true"></span> Memuat…</p>';
  try {
    const { scopes } = await api(`/api/projects/${project}/permissions`);
    if (project !== perm.project) return;
    perm.scopes = scopes;
    list.dataset.project = project;
    renderPermissions();
    if (perm.plan) renderPresetPlan(); // the plan's skip/add statuses follow the fresh rules
  } catch (err) {
    if (project !== perm.project) return;
    perm.scopes = [];
    list.innerHTML = `<div class="state-error">Gagal membaca aturan izin: ${escapeHtml(err.message)}</div>`;
  }
}

function ruleRow(scope, list, rule) {
  const moves = state.local
    ? LISTS.filter(([to]) => to !== list)
        .map(([to]) => `<button type="button" class="ghost" data-perm="move" data-to="${to}" title="Pindahkan ke ${to}">→ ${to}</button>`)
        .join('')
    : '';
  const remove = state.local ? '<button type="button" class="ghost danger-text" data-perm="remove" title="Hapus aturan ini">🗑 Hapus</button>' : '';
  return `<li data-scope="${scope}" data-list="${list}" data-rule="${escapeHtml(rule)}"><code>${escapeHtml(rule)}</code>${moves || remove ? `<span class="perm-acts">${moves}${remove}</span>` : ''}</li>`;
}

function renderPermissions() {
  const total = perm.scopes.reduce((n, s) => n + LISTS.reduce((m, [l]) => m + s.rules[l].length, 0), 0);
  $('#perm-count').textContent = `· ${total} aturan`;
  $('#perm-list').innerHTML = perm.scopes
    .map((s) => {
      const count = LISTS.reduce((m, [l]) => m + s.rules[l].length, 0);
      const head = `<div class="perm-scope-head"><b>${escapeHtml(s.label)}</b><code class="perm-file">${escapeHtml(s.file)}</code></div><p class="muted small">${escapeHtml(s.hint)}</p>`;
      if (s.error) return `<section class="perm-scope">${head}<div class="state-error">${escapeHtml(s.error)}</div></section>`;
      if (!count) return `<section class="perm-scope">${head}<p class="muted small perm-empty">${s.exists ? 'Belum ada aturan.' : 'File belum ada — dibuat saat aturan pertama ditambahkan.'}</p></section>`;
      const groups = LISTS.filter(([l]) => s.rules[l].length)
        .map(([l, label, meaning]) => `<div class="perm-group"><span class="pill ${LIST_TONE[l]}">${label}</span> <small class="muted">${meaning}</small><ul class="perm-rules">${s.rules[l].map((r) => ruleRow(s.scope, l, r)).join('')}</ul></div>`)
        .join('');
      return `<section class="perm-scope">${head}${groups}</section>`;
    })
    .join('');
}

async function edit(body, done) {
  if (perm.busy) return;
  perm.busy = true;
  try {
    const res = await api(`/api/projects/${perm.project}/permissions-edit`, body);
    done?.();
    toast(`Tersimpan di ${res.file}. ${APPLIED[res.applied] ?? APPLIED.none}`, 'ok');
  } catch (err) {
    toast(err.message);
    $('#perm-add-error').textContent = body.action === 'add' ? err.message : '';
  } finally {
    perm.busy = false;
    loadPermissions(); // shows the file as it is now (also after a refusal)
  }
}

// ---------- Presets: one click writes real allow rules through the same add API as a typed rule ----------
// Never deny, never remove, never write without an explicit Terapkan: the plan shows every rule with
// why it would be added or skipped (a user deny/ask anywhere wins — Claude Code: deny → ask → allow).

function renderPresetPlan() {
  const panel = $('#perm-preset-plan');
  const preset = PERMISSION_PRESETS.find((p) => p.id === perm.plan);
  if (!preset) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  const scope = $('#perm-add-scope').value;
  const where = perm.scopes.find((s) => s.scope === scope);
  if (!where) {
    panel.hidden = false;
    panel.innerHTML = `<div class="perm-plan-head"><b>${escapeHtml(preset.label)}</b><span class="muted small"><span class="spinner" aria-hidden="true"></span> Memuat aturan…</span></div>`;
    return;
  }
  if (where.error) {
    panel.hidden = false;
    panel.innerHTML = `<div class="state-error">Preset tidak bisa direncanakan (${escapeHtml(where.label)}): ${escapeHtml(where.error)}</div>`;
    return;
  }
  const labelOf = (s) => perm.scopes.find((x) => x.scope === s)?.label ?? s;
  const plan = planPreset(preset.rules, perm.scopes);
  const addable = plan.filter((p) => p.status === 'add').length;
  const items = plan.map((p) => {
    if (p.status === 'add') return `<li><span class="pill ok">tambah</span><code>${escapeHtml(p.rule)}</code></li>`;
    const why = p.status === 'allow'
      ? `sudah tercakup allow <code>${escapeHtml(p.via.rule)}</code> (${escapeHtml(labelOf(p.via.scope))})`
      : p.status === 'ask'
        ? `aturan ask <code>${escapeHtml(p.via.rule)}</code> (${escapeHtml(labelOf(p.via.scope))}) dievaluasi lebih dulu — Claude tetap ditanya`
        : `aturan deny <code>${escapeHtml(p.via.rule)}</code> (${escapeHtml(labelOf(p.via.scope))}) selalu menang atas allow`;
    return `<li><span class="pill ${p.status === 'allow' ? '' : LIST_TONE[p.status]}">lewati</span><code>${escapeHtml(p.rule)}</code><small class="muted">${why}</small></li>`;
  }).join('');
  panel.innerHTML = `
    <div class="perm-plan-head"><b>${escapeHtml(preset.label)}</b><span class="muted small">→ ${escapeHtml(where.label)} <code class="perm-file">${escapeHtml(where.file)}</code> · ${addable} akan ditambahkan${addable < plan.length ? `, ${plan.length - addable} dilewati` : ''}</span></div>
    <ul>${items}</ul>
    ${addable
      ? '<div class="perm-plan-acts"><button type="button" class="primary" data-plan="apply">Terapkan</button><button type="button" class="ghost" data-plan="close">Batal</button></div>'
      : `<p class="muted small" role="status">Tidak ada yang perlu ditambahkan — aturan yang sudah ada mencakup semuanya.</p><div class="perm-plan-acts"><button type="button" class="ghost" data-plan="close">Tutup</button></div>`}`;
  panel.hidden = false;
}

async function applyPreset() {
  const preset = PERMISSION_PRESETS.find((p) => p.id === perm.plan);
  const scope = $('#perm-add-scope').value;
  if (!preset || !scope || perm.busy) return;
  // Re-planned right before writing: between the preview and this click the files may have changed.
  const addable = planPreset(preset.rules, perm.scopes).filter((p) => p.status === 'add');
  if (!addable.length) return renderPresetPlan();
  perm.busy = true;
  let added = 0;
  let applied = 'none';
  try {
    for (const item of addable) {
      const res = await api(`/api/projects/${perm.project}/permissions-edit`, { scope, action: 'add', list: 'allow', rule: item.rule });
      added++;
      applied = res.applied ?? 'none';
    }
    const skipped = preset.rules.length - added;
    toast(`Preset ${preset.label}: ${added} aturan ditambahkan${skipped ? `, ${skipped} dilewati` : ''}. ${APPLIED[applied] ?? APPLIED.none}`, 'ok');
    perm.plan = null;
    renderPresetPlan();
  } catch (err) {
    toast(err.message);
    $('#perm-add-error').textContent = `${added ? `${added} aturan tersimpan, lalu gagal: ` : ''}${err.message}`;
  } finally {
    perm.busy = false;
    loadPermissions(); // shows the files as they are now (also after a refusal mid-way)
  }
}

export function initPermissions() {
  $('#btn-permissions').addEventListener('click', openPermissions);
  $('#perm-refresh').addEventListener('click', loadPermissions);
  $('#perm-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const rule = $('#perm-add-rule').value.trim();
    const error = !rule ? 'Tulis aturannya dulu.' : !RULE.test(rule) ? 'Format: Tool atau Tool(pola), mis. Bash(npm run test:*), Read(src/**), WebFetch(domain:example.com).' : '';
    $('#perm-add-error').textContent = error;
    $('#perm-add-rule').setAttribute('aria-invalid', String(Boolean(error)));
    if (error) return $('#perm-add-rule').focus();
    const scope = $('#perm-add-scope').value;
    const list = $('#perm-add-list').value;
    edit({ scope, action: 'add', list, rule }, () => ($('#perm-add-rule').value = ''));
  });
  $('#perm-add-rule').addEventListener('input', () => {
    $('#perm-add-error').textContent = '';
    $('#perm-add-rule').removeAttribute('aria-invalid');
  });
  // Presets target the same source picker as a manual add; changing it re-plans (pure, no request).
  $('#perm-add-scope').addEventListener('change', () => {
    if (perm.plan) renderPresetPlan();
  });
  $('#perm-presets').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset]');
    if (!btn || perm.busy) return;
    perm.plan = perm.plan === btn.dataset.preset ? null : btn.dataset.preset;
    renderPresetPlan();
  });
  $('#perm-preset-plan').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-plan]');
    if (!btn || perm.busy) return;
    if (btn.dataset.plan === 'apply') applyPreset();
    else {
      perm.plan = null;
      renderPresetPlan();
    }
  });
  $('#perm-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-perm]');
    if (!btn) return;
    const { scope, list, rule } = btn.closest('li[data-rule]').dataset;
    const where = perm.scopes.find((s) => s.scope === scope);
    const label = `${where?.label ?? scope} (${where?.file ?? ''})`;
    if (btn.dataset.perm === 'remove') {
      if (!window.confirm(`Hapus aturan ${list}:\n\n${rule}\n\ndari ${label}?`)) return;
      edit({ scope, action: 'remove', list, rule });
    } else {
      const to = btn.dataset.to;
      if (to === 'allow' && !window.confirm(`Pindahkan ke allow? Claude Code akan menjalankan ini tanpa bertanya:\n\n${rule}`)) return;
      edit({ scope, action: 'move', list, rule, to });
    }
  });
}
