// Pure view helpers for the setup screen (features/setup.js). No DOM: the shapes the server is allowed to send,
// how each row reads, and what the progress bar shows - importable by the UI tests without a browser.

/** Rows shown in the wizard, in order. npm/git/winget are diagnostic details, not install targets of their own. */
export const SETUP_ROWS = Object.freeze(['node', 'claude', 'opencode', 'tailscale']);

const ITEM_STATES = new Set(['ready', 'missing', 'outdated', 'unsupported', 'unknown']);
const ORIGINS = new Set(['runtime', 'system', 'bundled']);
const JOB_STATES = new Set(['running', 'done', 'failed', 'cancelled']);

const text = (value, max = 120) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** A server setup view, validated field by field. Anything malformed is dropped instead of rendered. */
export function normalizeSetup(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const items = Array.isArray(raw.items)
    ? raw.items
        .filter((item) => item && typeof item === 'object' && SETUP_ROWS.includes(item.id))
        .map((item) => ({
          id: item.id,
          label: text(item.label, 80) || item.id,
          state: ITEM_STATES.has(item.state) ? item.state : 'unknown',
          optional: item.optional === true,
          version: text(item.version, 60) || null,
          login: item.login === true ? true : item.login === false ? false : null,
          origin: ORIGINS.has(item.origin) ? item.origin : null,
          hint: text(item.hint, 240) || null,
        }))
    : [];
  const job = raw.job && typeof raw.job === 'object' && JOB_STATES.has(raw.job.state) ? jobView(raw.job) : null;
  const order = new Map(SETUP_ROWS.map((id, index) => [id, index]));
  items.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  return {
    supported: raw.supported === true,
    probing: raw.probing === true,
    busy: raw.busy === true,
    needsSetup: raw.needsSetup === true,
    firstRun: raw.firstRun === true,
    items,
    job,
    at: Number.isFinite(raw.at) ? raw.at : 0,
  };
}

/** One row: what it is, how it reads, and the one action that makes sense right now. */
export function itemView(item, { local = true, readOnly = false, busy = false, supported = true } = {}) {
  const ready = item.state === 'ready';
  const canAct = local && !readOnly && supported && !busy;
  const badge = ready
    ? item.login === false && (item.id === 'claude' || item.id === 'opencode')
      ? 'Perlu login'
      : 'Siap'
    : item.optional
      ? 'Opsional'
      : item.state === 'unsupported'
        ? 'Tidak didukung'
        : 'Belum siap';
  const detail = [
    item.version ? `v${item.version.replace(/^v/i, '')}` : '',
    item.origin === 'runtime' ? 'runtime Adhitron' : item.origin === 'system' ? 'terpasang di sistem' : '',
    item.login === true ? 'sudah login' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    id: item.id,
    label: item.label,
    optional: item.optional,
    state: item.state,
    ready,
    badge,
    detail,
    hint: item.hint,
    install: !ready && canAct ? item.id : null,
    login: ready && item.login === false && (item.id === 'claude' || item.id === 'opencode') && canAct ? item.id : null,
  };
}

/** Progress is clamped; a job without a percent is indeterminate instead of showing a fake 0%. */
export function jobView(job) {
  const percent = Number.isFinite(job?.percent) ? Math.min(100, Math.max(0, Math.round(job.percent))) : null;
  return {
    target: text(job?.target, 20),
    state: JOB_STATES.has(job?.state) ? job.state : 'failed',
    step: text(job?.step, 120),
    percent,
    cancellable: job?.cancellable !== false,
    error: text(job?.error, 300) || null,
    hint: text(job?.hint, 300) || null,
  };
}

/** `2/3 siap` for the section line, with the first missing mandatory step named. */
export function setupSummary(view) {
  if (!view) return 'Memeriksa…';
  if (!view.supported) return 'Instalasi satu-klik baru tersedia di Windows. Di sistem lain, pasang manual lewat tautan.';
  const mandatory = view.items.filter((item) => !item.optional);
  const ready = mandatory.filter((item) => item.state === 'ready').length;
  const missing = mandatory.find((item) => item.state !== 'ready');
  if (view.busy || view.job?.state === 'running') return `Memasang ${view.job?.target ?? 'komponen'}…`;
  if (!missing) return `${ready}/${mandatory.length} siap · tetap bisa memakai mesin yang sudah ada`;
  return `${ready}/${mandatory.length} siap · berikutnya: ${missing.label}`;
}

/** Open the wizard by itself only on a fresh local install, once per browser. */
export function shouldAutoOpen(view, { local = true, readOnly = false, seen = false } = {}) {
  return Boolean(view && local && !readOnly && !seen && view.needsSetup);
}
