// OpenCode shells (its background service, `opencode api shell.*`): a bash call of an OpenCode turn found among the
// service's running shells gets a task id `oc:<sh_…>`, so the chat row shows its output live, the stuck detector can
// see "no new output for 3 min", and ⧗ Pindah ke latar / stop work like they do for Claude Code's tasks.
// When a call is not found there (an older OpenCode, a tool that is not a service shell), nothing changes: the row
// keeps the time-only rule (running 10+ min).
import { openCodeApi } from './opencode-auth.js';

export const OC_TASK = /^oc:(sh_[\w-]{1,100})$/;
const OUTPUT_TAIL = 8192; // like Claude Code's get_task_output: the last 8 KB
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const loc = (dir) => ({ 'location[directory]': dir });

/** The service's running shells in this folder: [{ id, command, status, time }]. */
export async function runningShells(bin, dir) {
  const list = await openCodeApi(bin, 'shell.list', { params: loc(dir), timeout: 15_000 });
  return (Array.isArray(list) ? list : []).filter((s) => s && /^sh_/.test(s.id) && s.status === 'running');
}

/**
 * The shell running `command` (whitespace-insensitive; OpenCode may wrap it, so containment counts too), not one of
 * `taken`. The newest one wins when several match.
 */
export function matchShell(shells, command, taken = new Set()) {
  const want = norm(command);
  if (!want) return null;
  const free = shells.filter((s) => !taken.has(s.id));
  const exact = free.filter((s) => norm(s.command) === want);
  const loose = exact.length ? exact : free.filter((s) => norm(s.command).includes(want) || (norm(s.command).length > 8 && want.includes(norm(s.command))));
  return loose.sort((a, b) => (b.time?.started ?? 0) - (a.time?.started ?? 0))[0] ?? null;
}

/** { output, truncated } of a shell: its last 8 KB (one more read from the right cursor when it is longer). */
export async function shellOutput(bin, dir, id) {
  const first = await openCodeApi(bin, 'shell.output', { params: { id, ...loc(dir) }, timeout: 15_000 });
  const size = Number(first?.size ?? 0);
  if (size <= OUTPUT_TAIL || String(first?.output ?? '').length >= size) {
    const text = String(first?.output ?? '');
    return { output: text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text, truncated: text.length > OUTPUT_TAIL || Boolean(first?.truncated) };
  }
  const tail = await openCodeApi(bin, 'shell.output', { params: { id, ...loc(dir), cursor: String(size - OUTPUT_TAIL) }, timeout: 15_000 });
  return { output: String(tail?.output ?? ''), truncated: true };
}

/** Stops one shell (OpenCode's shell.remove: terminates it and drops its output). */
export const stopShell = (bin, dir, id) => openCodeApi(bin, 'shell.remove', { params: { id, ...loc(dir) }, timeout: 15_000 });

/** ⧗ Pindah ke latar: the session's running blocking tools carry on in the background (session.background). */
export const backgroundSession = (bin, sessionId) => openCodeApi(bin, 'session.background', { params: { sessionID: sessionId }, timeout: 15_000 });
