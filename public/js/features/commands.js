// Slash commands the app runs itself (/clear, /model, /resume, /rewind, /mcp, /tasks…).
import { api, toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { saveSettings } from './composer.js';
import { exportActiveSession, openSearch } from './conversations.js';
import { openDashboard } from './dashboard.js';
import { openMcp } from './mcp.js';
import { openMemory } from './memory.js';
import { openHandoff } from './handoff.js';
import { openExtensions } from './extensions.js';
import { openQueue } from './queue.js';
import { openPermissions } from './permissions.js';
import { openRewind } from './rewind.js';
import { openRoster } from './roster.js';
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
  { name: 'permissions', aliases: ['allowed-tools'], description: '🛡️ Aturan izin tersimpan (allow / ask / deny): lihat, tambah, hapus, pindah' },
  { name: 'team', aliases: ['tim'], description: '👥 Kelola tim: pilih role bawaan yang punya meja di kantor (Lead selalu ada)' },
  { name: 'antrian', aliases: ['queue'], description: '📋 Antrian prompt: susun beberapa prompt, dijalankan satu per satu saat tim tidak sibuk' },
  { name: 'tasks', description: 'Tugas latar: perintah & agent yang berjalan, output-nya, hentikan' },
  { name: 'plugin', aliases: ['plugins'], description: '🧩 Plugin Claude Code: pasang dari marketplace, aktif/nonaktif, hapus' },
  { name: 'agents', description: '🤖 Subagent buatan sendiri (.claude/agents): buat, edit, hapus' },
  { name: 'hooks', description: '🪝 Hooks yang aktif (settings.json user/project/pribadi)' },
  { name: 'lanjut', aliases: ['handoff'], description: '🔁 Bawa konteks percakapan dari mesin lain (Claude Code ↔ OpenCode) project ini' },
  { name: 'memory', description: '🧠 Edit instruksi memory: CLAUDE.md (Claude Code) / AGENTS.md (OpenCode)' },
  { name: 'dashboard', aliases: ['semua'], description: '🗂 Semua project: status setiap project sekaligus (izin, bekerja, antrian, idle)' },
  { name: 'help', description: 'Panduan & shortcut keyboard' },
  { name: 'export', argumentHint: '[tools]', description: 'Unduh sesi ini sebagai Markdown (.md) — /export tools: sertakan ringkasan tool' },
  { name: 'search', aliases: ['find'], argumentHint: '<kata kunci>', description: '🔎 Cari di semua percakapan project ini' },
  { name: 'template', aliases: ['t'], description: '⚡ Sisipkan template prompt (review, test, perbaiki error, commit…) — /t' },
];

/**
 * Claude Code commands that only open an interactive terminal screen: headless they do nothing useful. Hidden from
 * the autocomplete; typed anyway, the app says where the same thing lives here (or that it needs the terminal).
 */
export const CLI_ONLY = {
  config: 'Pengaturan ada di ⚙ (kanan atas) dan ⚙ chip di atas kotak chat.',
  doctor: 'Pakai ⚙ → Kompatibilitas Claude Code → 🩺 Doctor.',
  upgrade: 'Pakai ⚙ → Kompatibilitas Claude Code → ⬆ Update Claude Code.',
  login: 'Login/ganti akun ada di 👤 Akun.',
  logout: 'Logout ada di 👤 Akun.',
  status: 'Akun, kuota dan model ada di 👤 Akun dan status bar di bawah kotak chat.',
  'output-style': 'Output style masih diatur dari terminal.',
  statusline: 'Status bar aplikasi ini ada di bawah kotak chat.',
  'terminal-setup': 'Khusus terminal.',
  vim: 'Khusus terminal.',
  theme: 'Tema aplikasi ada di ⚙.',
  ide: 'Buka file di VS Code lewat tombol di tab Perubahan.',
  'install-github-app': 'Khusus terminal.',
  'privacy-settings': 'Khusus terminal.',
  'release-notes': 'Khusus terminal.',
  exit: 'Tidak perlu: tutup tab ini saja.',
  quit: 'Tidak perlu: tutup tab ini saja.',
};

/** Returns true when `text` was one of LOCAL_COMMANDS (handled here, not sent to Claude). */
export function localCommand(text) {
  const [, name, arg = ''] = text.match(/^\/([\w-]+)\s*(.*)$/s) ?? [];
  const value = arg.trim();
  if (CLI_ONLY[name] && (state.config?.engine ?? 'claude') === 'claude' && !(state.config?.commands ?? []).some((c) => c.name === name && c.source && c.source !== 'builtin')) {
    toast(`/${name} hanya ada di terminal Claude Code. ${CLI_ONLY[name]}`, 'warn');
    return true;
  }
  const pick = (select, label, allowCustom) => {
    if (!value) {
      // No argument: the Pengaturan giliran dialog with that picker focused, like the CLI's /model dialog.
      openModal('turn-settings-modal');
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
    case 'permissions':
    case 'allowed-tools':
      openPermissions();
      return true;
    case 'team':
    case 'tim':
      openRoster();
      return true;
    case 'antrian':
    case 'queue':
      openQueue();
      return true;
    case 'tasks':
    case 'bashes':
      openTasks();
      return true;
    case 'memory':
      openMemory();
      return true;
    case 'lanjut':
    case 'handoff':
      openHandoff();
      return true;
    case 'plugin':
    case 'plugins':
      openExtensions('plugins');
      return true;
    case 'agents':
      openExtensions('agents');
      return true;
    case 'hooks':
      openExtensions('hooks');
      return true;
    case 'dashboard':
    case 'semua':
      openDashboard();
      return true;
    case 'help':
      openModal('help-modal');
      return true;
    case 'export':
      exportActiveSession(value);
      return true;
    case 'search':
    case 'find':
      openSearch(value);
      return true;
    case 'template':
    case 't':
      openTemplates({ start: 0, end: 0 }); // the box is emptied of "/t" right after this
      return true;
    default:
      return false;
  }
}
