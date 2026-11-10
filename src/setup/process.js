// Runs a setup installer process with a deadline and a signal. Node's spawn `timeout` only kills the direct child;
// setup installers (npm, winget) may start helpers, so killTree (src/proc.js) stops the whole tree. Output is kept
// line by line: onLine gets every line, and the last 50 are returned for an actionable error hint.
import { spawn } from 'node:child_process';
import { killTree } from '../proc.js';
import { cancelledError } from './runtime.js';

export const MAX_RECENT_LINES = 50;
const KILL_GRACE_MS = 500;

/**
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} options.args
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {typeof spawn} [options.spawnImpl]
 * @param {(line: string, source: 'stdout'|'stderr') => void} [options.onLine]
 * @param {boolean} [options.windowsHide]
 * @returns {Promise<{ code: number|null, signal: string|null, timedOut: boolean, aborted: boolean, lines: string[] }>}
 */
export function runCapturedProcess({ command, args, env, cwd, timeoutMs = 600_000, signal, spawnImpl = spawn, onLine, windowsHide = true } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }

    const lines = [];
    const pending = { stdout: '', stderr: '' };
    let child = null;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer = null;
    let killGrace = null;

    const pushLine = (line, source) => {
      const clean = String(line).replace(/\r$/, '');
      lines.push(clean);
      if (lines.length > MAX_RECENT_LINES) lines.shift();
      if (typeof onLine !== 'function') return;
      try {
        onLine(clean, source);
      } catch {
        // a renderer must never break installation
      }
    };

    const flush = (source) => {
      if (!pending[source]) return;
      const rest = pending[source];
      pending[source] = '';
      pushLine(rest, source);
    };

    const consume = (source) => (chunk) => {
      if (settled) return;
      pending[source] += chunk.toString('utf8');
      let index;
      while ((index = pending[source].indexOf('\n')) >= 0) {
        const line = pending[source].slice(0, index);
        pending[source] = pending[source].slice(index + 1);
        pushLine(line, source);
      }
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killGrace) clearTimeout(killGrace);
      timer = null;
      killGrace = null;
      if (signal) signal.removeEventListener('abort', onAbort);
      child?.stdout?.removeAllListeners?.('data');
      child?.stderr?.removeAllListeners?.('data');
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      flush('stdout');
      flush('stderr');
      cleanup();
      resolve({ ...result, lines: lines.slice() });
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      err.lines = lines.slice();
      reject(err);
    };

    const stop = () => {
      flush('stdout');
      flush('stderr');
      try {
        killTree(child?.pid);
      } catch {
        // already gone
      }
      // A grandchild can keep the pipes open after the tree was asked to stop; do not wait forever for `close`.
      killGrace ??= setTimeout(() => finish({ code: null, signal: null, timedOut, aborted }), KILL_GRACE_MS);
    };

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      stop();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      child = spawnImpl(command, args, {
        env,
        cwd,
        windowsHide,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      fail(err);
      return;
    }
    if (!child || typeof child.on !== 'function') {
      fail(new TypeError('spawnImpl tidak mengembalikan proses anak.'));
      return;
    }

    child.stdout?.on?.('data', consume('stdout'));
    child.stderr?.on?.('data', consume('stderr'));
    child.on('error', fail);
    child.on('close', (code, closeSignal) => finish({ code, signal: closeSignal, timedOut, aborted }));

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        stop();
      }, timeoutMs);
    }
  });
}
