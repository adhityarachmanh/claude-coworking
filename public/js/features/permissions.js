// 🛡️ Aturan izin (/permissions): Claude Code's saved allow / ask / deny rules per settings file — what
// "Izinkan selalu" on a permission card stores. Anyone may look; only the laptop may change them
// (the server refuses `permissions-edit` from every other device).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';

const perm = { project: null, scopes: [], busy: false };
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
  if (state.active === DEMO_ID) return toast('Demo tidak punya aturan izin. Pilih project sungguhan.');
  perm.project = state.active;
  const name = state.projects.find((p) => p.id === perm.project)?.name ?? '';
  $('#perm-project').textContent = name ? `· ${name}` : '';
  // Changing rules changes what Claude Code may do without asking: laptop only (the server enforces it).
  $('#perm-add').hidden = !state.local;
  $('#perm-ro').hidden = state.local;
  $('#perm-add-error').textContent = '';
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
