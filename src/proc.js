// Child processes with a deadline that also stops their children. Node's execFile `timeout` only kills the direct
// child (on Windows: TerminateProcess on that one pid), so a CLI that started a shell, a test runner or a node
// grandchild leaves it running, and that grandchild may keep the stdout pipe open so the callback never comes.
import { execFile, spawn } from 'node:child_process';

const WIN = process.platform === 'win32';

/**
 * Stops a process and everything it started. Windows: taskkill /T /F (the whole tree). Elsewhere: SIGTERM to the
 * process group (-pid; execFileTree starts its children as group leaders), falling back to the pid alone for a
 * process that leads no group (e.g. the long-lived sessions spawned without `detached`).
 */
export function killTree(pid) {
  if (!pid) return;
  if (WIN) {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

/** After killTree, how long the pipes may stay open (a grandchild holding them) before they are closed here. */
const PIPE_GRACE_MS = 5000;

/**
 * execFile with `timeout` enforced by killTree instead of Node's single-process kill. Same callback shape as
 * execFile; on a timeout `err.killed` is true (as with execFile's own timeout), so callers need no change. A run
 * that finished normally just as the timer fired keeps its normal result.
 */
export function execFileTree(command, args, { timeout = 0, ...options } = {}, callback = () => {}) {
  let timedOut = false;
  let timer = null;
  let grace = null;
  // POSIX: its own process group, so killTree(-pid) reaches the grandchildren. Windows: unchanged (detached
  // would give it a console of its own; taskkill /T already follows the tree).
  const child = execFile(command, args, { ...options, ...(WIN ? {} : { detached: true }) }, (err, out, errOut) => {
    clearTimeout(timer);
    clearTimeout(grace);
    if (err && timedOut) err.killed = true;
    callback(err, out, errOut);
  });
  if (timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, PIPE_GRACE_MS);
      grace.unref?.();
    }, timeout);
    timer.unref?.();
  }
  return child;
}
