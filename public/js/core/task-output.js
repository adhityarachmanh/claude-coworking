// A shell command's output while it runs (Claude Code's get_task_output), shared by the task monitor
// (features/tasks.js) and the live output under a running Bash/PowerShell row in the chat (features/live-output.js).
import { api } from './api.js';
import { escapeHtml } from './dom.js';

export const OUTPUT_POLL_MS = 2000;
export const TRUNCATED_NOTE = '… hanya 8 KB terakhir yang ditampilkan.';

/** { text, truncated } of a shell task (Claude Code keeps the last 8 KB). */
export async function fetchTaskOutput(project, taskId) {
  const r = await api(`/api/projects/${project}/task-output`, { taskId });
  return { text: String(r.output ?? ''), truncated: Boolean(r.truncated) };
}

/** The "only the last 8 KB" note, or '' when the output is complete. */
export const truncatedNote = (out) => (out?.truncated ? `<p class="muted small out-note">${TRUNCATED_NOTE}</p>` : '');

/** The last `n` non-empty lines (a compact preview under a collapsed row), escaped. */
export function tailHtml(text, n = 8) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim()).slice(-n);
  return lines.map((l) => `<span>${escapeHtml(l)}</span>`).join('');
}

/** Within `slack` px of the bottom: new lines keep it scrolled down (the user hasn't scrolled up to read). */
export const nearBottom = (el, slack = 32) => el.scrollHeight - el.scrollTop - el.clientHeight < slack;
