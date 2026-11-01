// Slash commands the app runs itself (/clear, /model, /resume, /rewind, /mcp, /tasks…).
import { api, toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { saveSettings } from './composer.js';
import { openMcp } from './mcp.js';
import { openRewind } from './rewind.js';
import { confirmNew, openSessions } from './sessions.js';
import { openTasks } from './tasks.js';
import { openTemplates } from './templates.js';

// Commands this app runs itself: in headless mode Claude Code can't open its terminal dialogs
// (/resume, /rewind, /mcp, /tasks…), and /clear /model /effort must also move the app's own controls.
// Everything else (/usage, /context, /compact, /rename, skills…) goes to Claude Code and prints its output.
export const LOCAL_COMMANDS = [
  { name: 'clear', description: 'Mulai percakapan baru (sesi baru)' },
  { name: 'model', argumentHint: '<model>', description: 'Ganti model, misalnya /model fable, /model opus[1m], /model default' },
  { name: 'effort', argumentHint: '<low|medium|high|xhigh|max|default>', description: 'Ganti effort (seberapa dalam Claude berpikir)' },
  { name: 'resume', description: 'Lanjutkan sesi Claude Code sebelumnya' },
  { name: 'rewind', description: 'Kembalikan kode dan/atau percakapan ke sebelum salah satu pesanmu (Esc Esc)' },
  { name: 'mcp', description: 'Server MCP: status, sambungkan ulang, aktif/nonaktif, login' },
  { name: 'tasks', description: 'Tugas latar: perintah & agent yang berjalan, output-nya, hentikan' },
  { name: 'memory', description: 'Buka CLAUDE.md project di VS Code' },
  { name: 'help', description: 'Panduan & shortcut keyboard' },
  { name: 'template', aliases: ['t'], description: '⚡ Sisipkan template prompt (review, test, perbaiki error, commit…) — /t' },
];

/** Returns true when `text` was one of LOCAL_COMMANDS (handled here, not sent to Claude). */
export function localCommand(text) {
  const [, name, arg = ''] = text.match(/^\/([\w-]+)\s*(.*)$/s) ?? [];
  const value = arg.trim();
  const pick = (select, label, allowCustom) => {
    if (!value) {
      // No argument: show the picker, like the CLI's /model dialog.
      $(select).focus();
      $(select).showPicker?.();
      return;
    }
    const options = [...$(select).options].map((o) => o.value);
    const wanted = value.toLowerCase() === 'default' ? '' : value;
    if (!options.includes(wanted) && !allowCustom) return toast(`${label} "${value}" tidak dikenal. Pilihan: ${options.map((o) => o || 'default').join(', ')}`);
    if (!options.includes(wanted)) $(select).append(new Option(wanted, wanted)); // an alias or full id; the server checks it
    $(select).value = wanted;
    saveSettings();
  };
  switch (name) {
    case 'clear':
    case 'new':
    case 'reset':
      if (confirmNew()) api(`/api/projects/${state.active}/reset`).catch((err) => toast(err.message));
      return true;
    case 'model':
      pick('#model', 'Model', true);
      return true;
    case 'effort':
      pick('#effort', 'Effort', false);
      return true;
    case 'resume':
      openSessions();
      return true;
    case 'rewind':
    case 'checkpoint':
      openRewind();
      return true;
    case 'mcp':
      openMcp();
      return true;
    case 'tasks':
    case 'bashes':
      openTasks();
      return true;
    case 'memory':
      if (!state.local) toast('CLAUDE.md hanya bisa dibuka dari laptop.');
      else api(`/api/projects/${state.active}/open`, { app: 'code', file: 'CLAUDE.md' }).catch((err) => toast(err.message));
      return true;
    case 'help':
      openModal('help-modal');
      return true;
    case 'template':
    case 't':
      openTemplates({ start: 0, end: 0 }); // the box is emptied of "/t" right after this
      return true;
    default:
      return false;
  }
}
