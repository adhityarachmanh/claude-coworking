// ✅ The GitHub checks of the last push, as a chip in the Changes tab's git bar (server: src/github-ci.js, status.ci).
import { $, escapeHtml } from '../core/dom.js';
import { state } from '../core/state.js';

const LOOK = {
  pending: ['⏳', 'CI: menunggu GitHub…', 'run'],
  running: ['⏳', 'CI berjalan', 'run'],
  success: ['✅', 'CI lulus', 'ok'],
  failure: ['❌', 'CI gagal', 'fail'],
  login: ['🔑', 'CI: login GitHub dulu', 'muted'],
  error: ['⚠', 'CI tidak terbaca', 'muted'],
};

/** Redraws the chip for the open project (hidden when there was no push this run, or the repo has no CI). */
export function renderCi() {
  const el = $('#ch-git-ci');
  if (!el) return;
  const ci = state.active ? state.statuses[state.active]?.ci : null;
  const look = ci && LOOK[ci.state];
  if (!look) {
    el.hidden = true;
    return;
  }
  const [icon, text, tone] = look;
  const running = ci.runs?.filter((r) => r.status !== 'completed').length ?? 0;
  el.hidden = false;
  el.className = `ch-git-ci ${tone}`;
  el.innerHTML = `${icon} ${escapeHtml(text)}${ci.state === 'running' && running ? ` (${running})` : ''}`;
  el.title = (ci.runs ?? []).map((r) => `${r.name}: ${r.status === 'completed' ? r.conclusion : r.status}`).join('\n') || text;
  if (ci.url) el.href = ci.url;
  else el.removeAttribute('href');
}
