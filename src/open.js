// Opens a project (or one of its files) in VS Code or the system file manager, on the laptop.
// Commands are spawned without a shell: paths are passed as plain arguments, never interpreted.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** VS Code's own executable (not the code.cmd wrapper, which would need a shell on Windows). */
export function findVsCode(env = process.env, platform = process.platform) {
  if (env.OFFICE_EDITOR) return env.OFFICE_EDITOR;
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
    return roots.map((root) => path.join(root, 'Microsoft VS Code', 'Code.exe')).find((exe) => existsSync(exe)) ?? null;
  }
  if (platform === 'darwin') return '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  return 'code';
}

/**
 * @param app  'code' (VS Code) or 'folder' (Explorer / Finder / file manager)
 * @param dir  project folder; `file` (absolute, inside dir) is opened in VS Code next to it
 * @returns {{ command: string, args: string[] } | null} null when VS Code is not installed
 */
export function openCommand(app, dir, { file = null, platform = process.platform, env = process.env } = {}) {
  if (app === 'folder') {
    if (platform === 'win32') return { command: 'explorer.exe', args: [dir] };
    if (platform === 'darwin') return { command: 'open', args: [dir] };
    return { command: 'xdg-open', args: [dir] };
  }
  const code = findVsCode(env, platform);
  if (!code) return null;
  return { command: code, args: file ? [dir, file] : [dir] };
}

/** Starts the program detached so it outlives the server; OFFICE_OPEN_DRY_RUN=1 only reports it (tests). */
export function openInApp(app, dir, options = {}) {
  const cmd = openCommand(app, dir, options);
  if (!cmd) throw new Error('VS Code tidak ditemukan. Pasang VS Code, atau set env OFFICE_EDITOR ke path editormu.');
  if (process.env.OFFICE_OPEN_DRY_RUN) return cmd;
  const child = spawn(cmd.command, cmd.args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {}); // e.g. xdg-open missing: nothing to clean up
  child.unref();
  return cmd;
}
