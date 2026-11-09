// Activity tab: the office event log of the active project.
import { $, escapeHtml } from '../core/dom.js';
import { time } from '../core/format.js';
import { state } from '../core/state.js';
import { roleColor, roleName } from '../office/cast.js';

// ---------- activity ----------

const KIND_ICON = { prompt: '💬', delegate: '➜', agent_stop: '✓', tool_start: '•', tool_fail: '✗', ask: '✋', ask_done: '👍', stop: '🎉', error: '⚠', say: '💭', tests: '🧪', huddle: '🗣' };

/** "dari Adhitron - Tech Lead " when a specialist (not the lead) handed the work over. */
const fromPrefix = (from) => (from && from !== 'claude' ? `dari ${roleName(from)} ` : '');

export function appendActivity(evt, prepend) {
  if (!KIND_ICON[evt.kind]) return;
  const li = document.createElement('li');
  li.className = `k-${evt.kind}`;
  const text = evt.kind === 'delegate' ? `${fromPrefix(evt.from)}→ ${evt.agentType}: ${evt.label}` : evt.kind === 'say' ? evt.text : evt.label ?? '';
  li.innerHTML = `<time>${time(evt.ts)}</time><span class="dot" style="background:${roleColor(evt.role)}"></span><span><b>${escapeHtml(roleName(evt.role))}</b> ${KIND_ICON[evt.kind]} ${escapeHtml(text)}</span>`;
  const list = $('#activity');
  list.querySelector('.activity-empty')?.remove();
  if (prepend) list.prepend(li);
  else list.append(li);
  while (list.children.length > 200) list.lastElementChild.remove();
}

export function renderActivity() {
  const list = $('#activity');
  list.innerHTML = '';
  for (const evt of [...(state.events[state.active] ?? [])].reverse()) appendActivity(evt, false);
  if (!list.children.length) list.innerHTML = '<li class="activity-empty">Belum ada aktivitas di project ini.</li>';
}
