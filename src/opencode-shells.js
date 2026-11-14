// OpenCode shells (its background service, `opencode api shell.*`): a bash call of an OpenCode turn found among the
// service's running shells gets a task id `oc:<sh_…>`, so the chat row shows its output live, the stuck detector can
// see "no new output for 3 min", and ⧗ Pindah ke latar / stop work like they do for Claude Code's tasks.
// When a call is not found there (an older OpenCode, a tool that is not a service shell), nothing changes: the row
// keeps the time-only rule (running 10+ min).
//
// Shells of ACP-hosted sessions (src/acp-session.js) are invisible to that service (it is another process), but the
// tool call's metadata names the shell and OpenCode writes its output to a file we can read directly:
//   <data>/opencode/shell/<project.id>/<sh_id>.out
// The project folder is found by scanning one level of shell/ (its id is never computed here) and cached.
// Stopping one is a guarded kill: only a process whose command line carries the exact command text AND whose
// ancestry reaches our own ACP child is killed; anything ambiguous fails closed (409, nothing killed).
import os from 'node:os';
import path from 'node:path';
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { execFileTree } from './proc.js';
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

// ---------- shells of ACP-hosted sessions: the output file (read) and the guarded stop (kill) ----------

/** The last 8 KB of a shell's output, like Claude Code's get_task_output. */
const OUTPUT_FILE_TAIL = OUTPUT_TAIL;

/** The shell/ root under OpenCode's data dir (`OFFICE_OPENCODE_SHELL_DIR` is a test hook). */
export function shellOutBase() {
  if (process.env.OFFICE_OPENCODE_SHELL_DIR) return process.env.OFFICE_OPENCODE_SHELL_DIR;
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'opencode', 'shell');
}

let outDirCache = null; // the project folder that had a hit before: tried first on the next read

/**
 * The output file `<base>/<project.id>/<shellId>.out`, or null. The project folder is never computed — it is one
 * `readdir` away, and the folder that answered before is tried first.
 */
export function shellOutputFile(shellId) {
  const id = String(shellId ?? '').replace(/^oc:/, '');
  if (!/^sh_[\w-]{1,100}$/.test(id)) return null;
  const base = shellOutBase();
  let dirs;
  try {
    dirs = readdirSync(base);
  } catch {
    return null;
  }
  const hit = (dir) => {
    const file = path.join(base, dir, `${id}.out`);
    try {
      return statSync(file).isFile() ? file : null;
    } catch {
      return null;
    }
  };
  if (outDirCache) {
    const file = hit(outDirCache);
    if (file) return file;
  }
  for (const dir of dirs) {
    if (dir.startsWith('.')) continue;
    const file = hit(dir);
    if (file) {
      outDirCache = dir;
      return file;
    }
  }
  return null;
}

/** mtimeMs of a shell's output file (the "no output for 3 min" stuck chip), or null. */
export function shellFileMtime(shellId) {
  const file = shellOutputFile(shellId);
  if (!file) return null;
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** { output, truncated, mtimeMs } of a shell's output file: its last 8 KB. null = no file (yet / any more). */
export function shellFileTail(shellId, bytes = OUTPUT_FILE_TAIL) {
  const file = shellOutputFile(shellId);
  if (!file) return null;
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size, mtimeMs } = fstatSync(fd);
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return { output: buf.toString('utf8'), truncated: size > len, mtimeMs };
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

/** The running processes as [{ pid, ppid, pgrp?, command }] for the guarded shell stop. */
export async function listShellProcesses() {
  if (process.platform === 'win32') {
    const out = await new Promise((resolve) =>
      execFileTree('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress -Depth 3'], { timeout: 12_000 }, (err, stdout) => resolve(err ? '' : String(stdout ?? ''))),
    );
    try {
      const data = JSON.parse(out);
      const rows = Array.isArray(data) ? data : [data];
      return rows.filter((r) => Number.isFinite(r?.ProcessId)).map((r) => ({ pid: r.ProcessId, ppid: Number(r.ParentProcessId) || 0, command: String(r.CommandLine ?? '') }));
    } catch {
      return [];
    }
  }
  // Linux: one bounded pass over /proc
  const list = [];
  let names;
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let command = '';
    let stat = '';
    try {
      command = (await import('node:fs')).readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      stat = (await import('node:fs')).readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue; // gone between readdir and read
    }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    list.push({ pid: Number(name), ppid: Number(fields[1]) || 0, pgrp: Number(fields[2]) || 0, command });
  }
  return list;
}

const isAncestorOf = (pid, of, byId) => {
  let cur = byId.get(of);
  for (let i = 0; i < 20 && cur; i++) {
    if (cur.pid === pid) return true;
    cur = byId.get(cur.ppid);
  }
  return false;
};

/**
 * The one process tree running `command` (its command line contains the exact command text) whose ancestry reaches
 * `ancestorPid` (our ACP child). The chain ACP child → shell wrapper → real command may match several processes:
 * the topmost one wins, its tree kill takes the rest. Only a UNIQUE tree is returned — none or ambiguous → null,
 * and the caller must fail closed (nothing killed).
 */
export function matchShellProcess(command, ancestorPid, list) {
  const want = String(command ?? '').trim();
  const pid = Number(ancestorPid);
  if (!want || !Number.isFinite(pid) || pid <= 0 || !Array.isArray(list)) return null;
  const byId = new Map(list.filter((p) => Number.isFinite(p?.pid)).map((p) => [p.pid, p]));
  const hits = [...byId.values()].filter((p) => p.command?.includes(want) && p.pid !== pid && isAncestorOf(pid, p.pid, byId));
  const tops = hits.filter((p) => hits.every((q) => q.pid === p.pid || isAncestorOf(p.pid, q.pid, byId)));
  return tops.length === 1 ? tops[0] : null;
}
