// Locates the installed Claude Code binary so it can be spawned without a shell.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';

export function findClaude() {
  const override = process.env.CLAUDE_BIN;
  if (override) return override.endsWith('.js') ? { command: process.execPath, args: [override] } : { command: override, args: [] };

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'));

  for (const dir of dirs) {
    // npm global install on Windows: PATH has a .cmd shim; use the real binary behind it.
    const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    const native = path.join(pkg, 'bin', WIN ? 'claude.exe' : 'claude');
    if (existsSync(native)) return { command: native, args: [] };
    const cli = path.join(pkg, 'cli.js');
    if (existsSync(cli)) return { command: process.execPath, args: [cli] };
    const direct = path.join(dir, WIN ? 'claude.exe' : 'claude');
    if (existsSync(direct)) return { command: direct, args: [] };
  }
  return null;
}
