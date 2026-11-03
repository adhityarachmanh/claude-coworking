// Claude Code / OpenCode update detector, browser side (pure, no DOM): what the banner says and what ⚙ shows, from
// the server's config.claudeCheck / config.opencodeCheck (src/claude-check.js publicView, the same shape for both).
// Server text is only ever shown via textContent.

export const OK_HIDE_MS = 10_000; // "semua cek lulus" is good news: it goes away by itself
export const PASSIVE_HIDE_MS = 30_000; // read-only WiFi: a passive notice, no buttons, gone after a while
export const HINT_COMMAND = 'npm run test:claude';
export const OPENCODE_HINT_COMMAND = 'npm run test:opencode';
const MAX_NAMES = 3;

/**
 * The 202 answer of ▶ Cek kompatibilitas (running: true) can arrive after the run's own `config` events already said
 * it finished (a fast check): applying it then would show "running" for good. True = ignore that answer.
 */
export function staleRunReply(current, reply) {
  return Boolean(current && reply && reply.running && !current.running && (current.lastCheckedAt ?? 0) > (reply.lastCheckedAt ?? 0));
}

/** One banner per finished check: the version it checked and when. */
export const bannerKey = (view) => `${view.checkedVersion}|${view.lastCheckedAt}`;

/** "a, b, c, +2 lagi" */
export function failingList(names = []) {
  const shown = names.slice(0, MAX_NAMES).join(', ');
  return names.length > MAX_NAMES ? `${shown}, +${names.length - MAX_NAMES} lagi` : shown;
}

/**
 * The banner for this check, or null. `seen` = the key of the banner this browser already dismissed (or saw auto-hide).
 * ok: only after an automatic check of a NEW version (a first install or a manual run is no news), auto-hides.
 * warning/failed: laptop + Tailscale get a dismissible banner with the command for details; read-only WiFi a passive
 * notice (no button, no command: nothing it could act on there).
 * @returns {null | { key: string, tone: 'ok'|'warn'|'err', text: string, hintCommand: string|null, dismissible: boolean,
 *   autoHideMs: number|null, passive: boolean }}
 */
export function claudeCheckBanner(view, { readOnly = false, seen = null, name = 'Claude Code', hintCommand = HINT_COMMAND } = {}) {
  if (!view || view.running || !view.lastCheckedAt || !view.checkedVersion) return null;
  if (view.version && view.version !== view.checkedVersion) return null; // news about a version no longer installed
  const key = bannerKey(view);
  if (seen === key) return null;
  const v = `v${view.checkedVersion}`;
  if (view.result === 'ok') {
    if (view.trigger !== 'auto' || !view.previousVersion || view.previousVersion === view.checkedVersion) return null;
    return { key, tone: 'ok', text: `${name} diperbarui ke ${v} — semua cek kontrak lulus ✅`, hintCommand: null, dismissible: !readOnly, autoHideMs: readOnly ? PASSIVE_HIDE_MS : OK_HIDE_MS, passive: readOnly };
  }
  if (view.result !== 'warning' && view.result !== 'failed') return null; // skipped: shown in ⚙ only
  const n = view.failing?.length ?? 0;
  const text = `⚠ ${name} ${v}: ${n} cek kontrak gagal${n ? ` (${failingList(view.failing)})` : ''} — beberapa fitur mungkin bermasalah.`;
  if (readOnly) return { key, tone: 'warn', text, hintCommand: null, dismissible: false, autoHideMs: PASSIVE_HIDE_MS, passive: true };
  return { key, tone: view.result === 'failed' ? 'err' : 'warn', text, hintCommand, dismissible: true, autoHideMs: null, passive: false };
}

const RESULT_TEXT = {
  ok: () => '✓ semua cek lulus',
  warning: (v) => `⚠ ${v.failing.length} cek gagal: ${failingList(v.failing)}`,
  failed: (v) => `✕ ${v.failing.length} cek gagal: ${failingList(v.failing)}`,
  skipped: (v) => `— dilewati${v.reason ? ` (${v.reason})` : ''}`,
};

/** The status line in ⚙ → Kompatibilitas Claude Code / OpenCode. `fmtDate` formats a timestamp. */
export function claudeCheckStatus(view, fmtDate = (ts) => new Date(ts).toISOString(), { name = 'Claude Code', modelLabel = '1 request Haiku' } = {}) {
  if (!view) return '';
  if (!view.available) return `${name} tidak ditemukan di laptop ini.`;
  const parts = [`Terpasang: ${view.version ? `v${view.version}` : 'versi belum terbaca'}.`];
  if (view.running) parts.push('⏳ Cek kompatibilitas sedang berjalan…');
  else if (view.waiting) parts.push('⏳ Menunggu giliran yang berjalan selesai sebelum cek…');
  if (view.lastCheckedAt && view.result) {
    const how = view.trigger === 'manual' ? 'manual' : 'otomatis';
    const token = view.result === 'skipped' ? '' : view.usedModel ? `, ${modelLabel}` : ', tanpa token';
    parts.push(`Cek terakhir (${how}${token}) ${fmtDate(view.lastCheckedAt)}, v${view.checkedVersion}: ${RESULT_TEXT[view.result](view)}.`);
  } else if (!view.running) parts.push('Belum pernah dicek.');
  if (view.lastGoodVersion && view.lastGoodVersion !== view.version) parts.push(`Terakhir lulus: v${view.lastGoodVersion}.`);
  return parts.join(' ');
}

/** OpenCode (config.opencodeCheck): the same banner, its own name and contract command. */
export const openCodeCheckBanner = (view, opts = {}) => claudeCheckBanner(view, { ...opts, name: 'OpenCode', hintCommand: OPENCODE_HINT_COMMAND });
/** OpenCode's ⚙ status line (its automatic check never uses a model). */
export const openCodeCheckStatus = (view, fmtDate) => claudeCheckStatus(view, fmtDate, { name: 'OpenCode', modelLabel: 'model' });
