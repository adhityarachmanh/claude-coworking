// Child processes with a deadline that also stops their children. Node's execFile `timeout` only kills the direct
// child (on Windows: TerminateProcess on that one pid), so a CLI that started a shell, a test runner or a node
// grandchild leaves it running, and that grandchild may keep the stdout pipe open so the callback never comes.
import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { childEnv } from './child-env.js';

const WIN = process.platform === 'win32';

/**
 * Stops a process and everything it started. Windows: taskkill /T /F (the whole tree). Elsewhere: SIGTERM to the
 * process group (-pid; execFileTree starts its children as group leaders), falling back to the pid alone for a
 * process that leads no group (e.g. the long-lived sessions spawned without `detached`).
 */
export function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return;
  if (WIN) {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * After the first SIGTERM: a grandchild that ignores it, or one forked a hair after the group signal was sent
 * (the kernel already walked the group), must not keep the pipe open or outlive the deadline. SIGKILL hits every
 * member again. Only escalated while the group still exists — a fully dead group makes the call a no-op (ESRCH).
 */
const KILL_ESCALATE_MS = 2000;

/** After killTree, how long the pipes may stay open (a grandchild holding them) before they are closed here. */
const PIPE_GRACE_MS = 5000;

/** execFile's default output cap; a caller may pass its own. */
const MAX_BUFFER = 1024 * 1024;

/**
 * execFile's contract (`err, stdout, stderr`; `encoding`, `maxBuffer`, `cwd`, `env`, `shell`) on top of `spawn`,
 * which is the only API that honours `detached` — and without a new process group nothing can reach the
 * grandchildren. Error shape follows execFile: `code` is the exit code (or the spawn errno such as ENOENT),
 * `signal` the signal, `cmd` the command line; an oversized output reports ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
 */
function spawnExecFile(command, args, options, finish) {
  const { encoding = 'utf8', maxBuffer = MAX_BUFFER, ...spawnOptions } = options;
  const text = encoding !== 'buffer' && Buffer.isEncoding(encoding) ? encoding : null;
  const child = spawn(command, args, {
    cwd: spawnOptions.cwd,
    env: spawnOptions.env ?? childEnv(),
    shell: spawnOptions.shell ?? false,
    uid: spawnOptions.uid,
    gid: spawnOptions.gid,
    signal: spawnOptions.signal,
    windowsHide: !!spawnOptions.windowsHide,
    windowsVerbatimArguments: !!spawnOptions.windowsVerbatimArguments,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // its own process group: killTree(-pid) then reaches every grandchild
  });
  const out = [];
  const errOut = [];
  let outLen = 0;
  let errLen = 0;
  let overflow = '';
  let settled = false;
  // A StringDecoder (not chunk.toString) keeps a multi-byte character whole when the pipe splits it between chunks:
  // execFile does the same through `setEncoding`. maxBuffer still counts BYTES, like execFile.
  const outText = text ? new StringDecoder(text) : null;
  const errText = text ? new StringDecoder(text) : null;
  const close = () => {
    if (outText) out.push(outText.end());
    if (errText) errOut.push(errText.end());
  };
  const done = (err) => {
    if (settled) return;
    settled = true;
    finish(err, text ? out.join('') : Buffer.concat(out), text ? errOut.join('') : Buffer.concat(errOut));
  };
  const collect = (chunk, chunks, decoder, len, stream) => {
    if (len + chunk.length > maxBuffer) {
      if (!overflow) {
        overflow = stream;
        killTree(child.pid);
      }
      return;
    }
    chunks.push(decoder ? decoder.write(chunk) : chunk);
    return len + chunk.length;
  };
  child.stdout?.on('data', (chunk) => {
    outLen = collect(chunk, out, outText, outLen, 'stdout') ?? outLen;
  });
  child.stderr?.on('data', (chunk) => {
    errLen = collect(chunk, errOut, errText, errLen, 'stderr') ?? errLen;
  });
  child.on('error', (err) => {
    err.cmd = `${command} ${args.join(' ')}`;
    done(err);
  });
  child.on('close', (code, signal) => {
    close(); // the tail of a split character still sitting in the decoder
    let err = null;
    if (overflow) {
      err = new Error(`${overflow} maxBuffer length exceeded`);
      err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      err.cmd = `${command} ${args.join(' ')}`;
    } else if (code !== 0 || signal) {
      const tail = text ? errOut.join('').trim() : '';
      err = new Error(`Command failed: ${command} ${args.join(' ')}${tail ? `\n${tail}` : ''}`);
      err.code = code ?? null;
      err.signal = signal ?? undefined;
      err.cmd = `${command} ${args.join(' ')}`;
    }
    done(err);
  });
  return child;
}

/**
 * execFile with `timeout` enforced by killTree instead of Node's single-process kill. Same callback shape as
 * execFile; on a timeout `err.killed` is true (as with execFile's own timeout), so callers need no change. A run
 * that finished normally just as the timer fired keeps its normal result. The child's stdin is closed at once (see
 * below), so this helper is for commands whose input is in argv — not for feeding a CLI through stdin.
 *
 * The child always gets a cleaned environment (src/child-env.js) unless the caller passes its own `env`: the
 * inherited PATH may carry nvm-windows' `.nodejs` junction, which makes libuv fail to `lstat` a path inside it
 * (`EUNKNOWN: unknown error, lstat '...\nvm\.nodejs\pwsh.exe'`) — the "Internal error" on the first prompt after
 * an in-app update. A central default here covers every wrapper that spawns a CLI, present and future.
 */
export function execFileTree(command, args, { timeout = 0, input = null, ...options } = {}, callback = () => {}) {
  const state = { timedOut: false, timer: null, grace: null, escalate: null };
  const finish = (err, out, errOut) => {
    clearTimeout(state.timer);
    clearTimeout(state.grace);
    clearTimeout(state.escalate);
    if (err && state.timedOut) err.killed = true;
    callback(err, out, errOut);
  };
  // Windows keeps execFile (taskkill /T already follows the tree). POSIX builds on spawn, because execFile silently
  // DROPS `detached` (it hands spawn a fixed list of options), so its child stayed in the caller's process group and
  // killTree(-pid) answered ESRCH: every grandchild outlived the timeout (Ubuntu nightlies caught it).
  const child = WIN ? execFile(command, args, { ...options, env: options.env ?? childEnv() }, finish) : spawnExecFile(command, args, options, finish);
  // Close stdin at once: it is a pipe (not a TTY), and `opencode run` / `claude -p` read a piped stdin as prompt
  // input, so an open pipe makes them wait for EOF that never comes (the Effort Auto classifier silently fell back
  // after 25 s). A caller that DOES have something to say (`input`, e.g. `claude mcp add-json -` reading the server
  // JSON so a token never lands in argv) writes it and then closes the pipe itself.
  child.stdin?.on('error', () => {}); // EPIPE when the process is gone already: reported through the callback
  if (input == null) child.stdin?.end();
  else child.stdin?.end(String(input));
  if (timeout > 0) {
    // Neither timer may be unref'd: the caller waits for the callback, and once the child is killed these timers are
    // the only thing that keeps the event loop alive long enough to deliver it.
    state.timer = setTimeout(() => {
      state.timedOut = true;
      killTree(child.pid);
      // A stubborn grandchild (or one born just after the group walk) would keep the pipe open and outlive the
      // deadline: SIGKILL the group once the polite signal has had its chance (POSIX; Windows already forces).
      if (!WIN) state.escalate = setTimeout(() => killTree(child.pid, 'SIGKILL'), KILL_ESCALATE_MS);
      state.grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, PIPE_GRACE_MS);
    }, timeout);
  }
  return child;
}
