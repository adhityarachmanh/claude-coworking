// 🧰 Persiapan (⚙ → Sistem, and once on a fresh install): Node.js, Claude Code, OpenCode and Tailscale in one
// place. The server (src/setup/service.js) installs into its own per-user runtime; this screen only shows state,
// asks before acting, and never sends a URL, package name or path - just one allowlisted target id.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { setupSummary, normalizeSetup, itemView, shouldAutoOpen } from '../core/setup-view.js';
import { state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

const SEEN_KEY = 'office.setupSeen';
const up = { view: null, busy: false };

const isLocal = () => state.local !== false;
const seen = () => {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true; // private mode: keep it manual instead of popping up on every load
  }
};
const rememberSeen = () => {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {}
};

function rowHtml(row) {
  const badge = `<span class="setup-badge ${row.ready ? 'ok' : row.optional ? 'muted' : 'warn'}">${escapeHtml(row.badge)}</span>`;
  const detail = [row.detail, row.hint].filter(Boolean).map((line) => `<small class="muted">${escapeHtml(line)}</small>`).join('');
  const actions = [];
  if (row.install) actions.push(`<button type="button" class="primary" data-setup-install="${escapeHtml(row.install)}">Pasang</button>`);
  if (row.login) actions.push(`<button type="button" class="ghost" data-setup-login="${escapeHtml(row.login)}">Buka terminal login</button>`);
  return `<li class="setup-item state-${escapeHtml(row.state)}" data-setup-row="${escapeHtml(row.id)}">
    <div class="setup-main"><b>${escapeHtml(row.label)}</b> ${badge}${detail}</div>
    ${actions.length ? `<div class="setup-item-actions">${actions.join('')}</div>` : ''}
  </li>`;
}

function jobHtml(job) {
  if (!job) return '';
  const running = job.state === 'running';
  const percent = job.percent == null ? '' : `<span id="setup-job-percent">${job.percent}%</span>`;
  const label = job.step || (running ? `Memasang ${job.target}…` : `Selesai: ${job.target}`);
  const error = job.error || job.hint ? `<p class="field-error" role="alert">${escapeHtml(job.error ?? '')}${job.hint ? ` ${escapeHtml(job.hint)}` : ''}</p>` : '';
  return `<div id="setup-job" class="setup-job ${running ? 'running' : escapeHtml(job.state)}" role="status" aria-live="polite">
    <div class="setup-job-head"><span id="setup-job-label">${escapeHtml(label)}</span>${percent}</div>
    <progress id="setup-progress" max="100"${job.percent == null ? '' : ` value="${job.percent}"`} aria-label="Kemajuan pemasangan"></progress>
    ${error}
    ${running && job.cancellable ? '<button type="button" id="setup-cancel" class="ghost">Batalkan</button>' : ''}
  </div>`;
}

function render() {
  const view = up.view;
  if (!view) return;
  const summary = $('#setup-summary');
  if (summary) summary.textContent = setupSummary(view);
  const box = $('#setup-items');
  if (box) {
    const opts = { local: isLocal(), readOnly: state.readOnly, busy: view.busy || up.busy, supported: view.supported };
    box.innerHTML = view.items.map((item) => rowHtml(itemView(item, opts))).join('');
    const job = $('#setup-job');
    if (view.job && view.job.state !== 'done') {
      const holder = document.createElement('div');
      holder.innerHTML = jobHtml(view.job);
      const next = holder.firstElementChild;
      if (job) job.replaceWith(next);
      else box.before(next);
    } else job?.remove();
  }
  const note = $('#setup-note');
  if (note) {
    note.textContent = !view.supported
      ? 'Pemasangan satu-klik baru tersedia di Windows. Di macOS/Linux, pasang Node.js dan CLI lewat terminal; status di bawah tetap membantu.'
      : state.readOnly
        ? 'Hanya lihat lewat WiFi. Pemasangan dan login hanya dari laptop atau lewat Tailscale.'
        : 'Adhitron memasang Node.js dan CLI ke folder miliknya sendiri (tanpa admin, tanpa mengubah PATH sistem). Tidak ada yang dipasang tanpa persetujuanmu.';
  }
  const cancel = $('#setup-cancel');
  if (cancel) cancel.disabled = !view.job || view.job.state !== 'running' || !view.job.cancellable;
  const refresh = $('#setup-refresh');
  if (refresh) refresh.disabled = view.probing || view.busy || !isLocal() || state.readOnly;
}

function open() {
  render();
  openModal('setup-modal');
  const first = $('#setup-items button');
  first?.focus({ preventScroll: true });
}

function maybeAutoOpen() {
  const view = up.view;
  // Only a truly fresh install (no real project yet), like the tour: an existing office opens it from ⚙.
  const fresh = (state.projects ?? []).every((project) => project?.id === 'demo');
  if (!fresh) return;
  if (!view || !shouldAutoOpen(view, { local: isLocal(), readOnly: state.readOnly, seen: seen() })) return;
  rememberSeen();
  open();
}

/** The server's config.setup snapshot (or the answer to an action): store, redraw, maybe greet a fresh install. */
export function applySetup(view) {
  const next = normalizeSetup(view);
  if (!next) return;
  up.view = next;
  state.setup = next;
  render();
  maybeAutoOpen();
}

async function action(path, body, okMessage) {
  if (up.busy || state.readOnly || !isLocal()) return;
  up.busy = true;
  render();
  try {
    const data = await api(path, body);
    if (data?.setup) applySetup(data.setup);
    if (okMessage) toast(okMessage, 'ok');
  } catch (err) {
    toast(err?.data?.error ?? err?.message ?? 'Aksi gagal.');
  } finally {
    up.busy = false;
    render();
  }
}

export function initSetup() {
  $('#setup-open')?.addEventListener('click', () => {
    if (!isLocal()) return toast('Persiapan hanya bisa dibuka dari laptop atau lewat Tailscale.');
    open();
  });
  $('#setup-refresh')?.addEventListener('click', () => action('/api/setup/refresh', {}, null));
  $('#setup-cancel')?.addEventListener('click', () => action('/api/setup/cancel', {}, 'Pemasangan dibatalkan.'));
  $('#setup-items')?.addEventListener('click', (e) => {
    const install = e.target.closest('[data-setup-install]')?.dataset.setupInstall;
    const login = e.target.closest('[data-setup-login]')?.dataset.setupLogin;
    if (install) {
      if (!window.confirm(`Pasang ${install} sekarang?\n\nAdhitron mengunduh dari sumber resmi dan memasangnya ke folder data aplikasi. Tidak ada perubahan pada PATH sistem.`)) return;
      const label = install === 'node' ? 'Node.js' : install === 'claude' ? 'Claude Code' : install === 'opencode' ? 'OpenCode' : 'Tailscale';
      action('/api/setup/install', { target: install }, `Memasang ${label}…`);
    } else if (login) {
      action('/api/setup/login-terminal', { target: login }, 'Terminal login dibuka. Setelah masuk, tekan Periksa ulang.');
    }
  });
  if (state.setup) applySetup(state.setup);
}
