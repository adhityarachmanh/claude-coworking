// 🖥 Fallback terminal launcher for the capabilities that only exist in a TUI (agent-view attach, MCP elicitation,
// /batch, /ultrareview). It opens Windows Terminal with a pinned command — never a free-form shell.
import { spawn } from 'node:child_process';

const AGENT_ID = /^[\w-]{1,100}$/;

/** The argv for a mode, or null when the mode/binary is not available. Pure, so the allowlist is testable. */
export function terminalArgv({ mode, agentId } = {}, { claude, opencode } = {}) {
  if (mode === 'claude' && claude) return [claude.command, ...(claude.args ?? [])];
  if (mode === 'opencode' && opencode) return [opencode.command, ...(opencode.args ?? [])];
  if (mode === 'attach' && claude && typeof agentId === 'string' && AGENT_ID.test(agentId)) {
    return [claude.command, ...(claude.args ?? []), 'attach', agentId];
  }
  return null;
}

/** Opens Windows Terminal (`wt.exe -d <cwd> <argv>`) detached; true once it spawned. */
export function openTerminal({ cwd, argv, platform = process.platform, spawnImpl = spawn } = {}) {
  if (platform !== 'win32' || !Array.isArray(argv) || !argv.length) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawnImpl('wt.exe', ['-d', cwd, ...argv], { cwd, detached: true, stdio: 'ignore' });
    child.once('error', () => finish(false));
    child.once('spawn', () => {
      child.unref();
      finish(true);
    });
  });
}
