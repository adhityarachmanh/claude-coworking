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
import { initChanges } from './features/changes.js';
import { initChat } from './features/chat.js';
import { initComposerControls, initComposerInput } from './features/composer.js';
import { initDraft } from './features/draft.js';
import { initPromptHistory } from './features/history.js';
import { initMcp } from './features/mcp.js';
import { initMoreMenu } from './features/more-menu.js';
import { initNotify } from './features/notify.js';
import { initPhone } from './features/phone.js';
import { initPicker } from './features/picker.js';
import { initReport } from './features/report.js';
import { initRewind } from './features/rewind.js';
import { initSessions } from './features/sessions.js';
import { initSettings } from './features/settings.js';
import { initStatusline } from './features/statusline.js';
import { initSuggest } from './features/suggest.js';
import { initTasks } from './features/tasks.js';
import { initTeam, renderTeam } from './features/team.js';
import { initTheme } from './features/theme.js';
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
initChat();
initTeam();
initStatusline();
initAttachments();
initSuggest();
initSessions();
initMoreMenu();
initSettings();
initTheme(); // before the first frame: the saved theme is drawn right away
initBackup(); // after initSettings: its #btn-settings listener runs after the dialog's own
initNotify();
initChanges();
initPhone();
initAccount();
initReport();
initPromptHistory();
initDraft();
initComposerControls();
initTabs();
initRewind();
initMcp();
initTasks();
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
