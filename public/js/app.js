// Adhit Office web app: project picker, chat with Claude Code, approvals, live office.
// Entry point (native ES modules, no build step): wires up every feature, then starts the office.
//
// Module rules (the features import each other in cycles, which is only safe because of these):
// - A feature module's top level only DEFINES things (functions, consts of plain values, state objects).
//   It never calls an imported function or registers listeners at load time — that goes in its init*().
// - The init*() calls below run in a fixed order; some listeners depend on it (e.g. the modal Tab trap
//   must be registered before the composer's Shift+Tab handler, which checks defaultPrevented).
// - State shared across modules lives in mutable objects (state, changes, phone, …), never `export let`.
import { scenes, stage } from './core/scenes.js';
import { connect } from './core/stream.js';
import { initAccount } from './features/account.js';
import { initAttachments } from './features/attachments.js';
import { initBackup } from './features/backup.js';
import { initBackupAuto } from './features/backup-auto.js';
import { initChanges } from './features/changes.js';
import { initChat } from './features/chat.js';
import { initComposerControls, initComposerInput } from './features/composer.js';
import { initConversations } from './features/conversations.js';
import { initDraft } from './features/draft.js';
import { initFileViewer } from './features/file-viewer.js';
import { initGitBar } from './features/git-branches.js';
import { initPromptHistory } from './features/history.js';
import { initLiveOutput } from './features/live-output.js';
import { initMcp } from './features/mcp.js';
import { initMoreMenu } from './features/more-menu.js';
import { initNotify } from './features/notify.js';
import { initPalette } from './features/palette.js';
import { initPermissions } from './features/permissions.js';
import { initPhone } from './features/phone.js';
import { initPicker } from './features/picker.js';
import { initQuota } from './features/quota.js';
import { initQueue } from './features/queue.js';
import { initReport } from './features/report.js';
import { initRoster } from './features/roster.js';
import { initResumeTurn } from './features/resume-turn.js';
import { initRewind } from './features/rewind.js';
import { initSessions } from './features/sessions.js';
import { initSettings } from './features/settings.js';
import { initStatusline } from './features/statusline.js';
import { initSuggest } from './features/suggest.js';
import { initTasks } from './features/tasks.js';
import { initTeam, renderTeam } from './features/team.js';
import { initTemplates } from './features/templates.js';
import { initTheme } from './features/theme.js';
import { initVoice } from './features/voice.js';
import { initMobileNav, initPanelResizer, initTabs } from './ui/layout.js';
import { initModals } from './ui/modals.js';
import { initShortcuts } from './ui/shortcuts.js';

// Wiring runs in the order it always had: listeners on the same target fire in registration order
// (dialog Tab trap before the composer's Shift+Tab, #prompt input handlers, capture-phase Esc first).
initModals();
initPicker();
initShortcuts();
initMobileNav();
initComposerInput();
initLiveOutput(); // before initChat / the first render: rows register with its observer as they are drawn
initChat();
initFileViewer();
initTeam();
initRoster(); // 👥 Kelola tim (⚙, ⋯, Ctrl+P, /team)
initStatusline();
initAttachments();
initSuggest();
initSessions();
initMoreMenu();
initSettings();
initTheme(); // before the first frame: the saved theme is drawn right away
initBackup(); // after initSettings: its #btn-settings listener runs after the dialog's own
initBackupAuto(); // ⏰ Backup otomatis in the same ⚙ section
initNotify();
initQuota(); // after initSettings: refreshes its ⚙ fields when the dialog opens
initChanges();
initGitBar(); // ⎇ branch / fetch / pull / push in the Changes tab
initPhone();
initAccount();
initReport();
initPromptHistory();
initDraft();
initQueue(); // 📋 Antrian; before initComposerControls: its Alt+Enter on #prompt must win over Enter = send
initComposerControls();
initVoice(); // 🎤 Input suara; its capture-phase Esc (while recording) runs after ui/shortcuts.js closes dialogs
initTemplates(); // ⚡ Template picker (also opened by /t from the composer)
initTabs();
initRewind();
initMcp();
initPermissions(); // 🛡️ Aturan izin (⚙, ⋯, /permissions)
initTasks();
initResumeTurn(); // the "turn cut short by a server restart" banner, drawn by renderComposer
initConversations(); // 🔎 Cari percakapan + ⬇ Export sesi (.md)
initPalette(); // Ctrl+P command palette (the shortcut itself is in ui/shortcuts.js)
initPanelResizer();

// ---------- main loop ----------

let last = performance.now();
let lastTeam = 0;
function loop(t) {
  const dt = Math.min((t - last) / 1000, 0.05);
  last = t;
  for (const scene of scenes.values()) scene.update(dt, t);
  stage.frame(t);
  if (t - lastTeam > 500) {
    renderTeam();
    lastTeam = t;
  }
  requestAnimationFrame(loop);
}

connect();
requestAnimationFrame(loop);
