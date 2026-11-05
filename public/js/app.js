// Adhit Office web app: project picker, chat with Claude Code, approvals, live office.
// Entry point (native ES modules, no build step): wires up every feature, then starts the office.
//
// Module rules (the features import each other in cycles, which is only safe because of these):
// - A feature module's top level only DEFINES things (functions, consts of plain values, state objects).
//   It never calls an imported function or registers listeners at load time — that goes in its init*().
// - The init*() calls below run in a fixed order; some listeners depend on it (e.g. the modal Tab trap
//   must be registered before the composer's Shift+Tab handler, which checks defaultPrevented).
// - State shared across modules lives in mutable objects (state, changes, phone, …), never `export let`.
import { brain, scenes, stage } from './core/scenes.js';
import { initViewMode } from './features/view-mode.js';
import { initAppUpdate } from './features/app-update.js';
import { initHandoff } from './features/handoff.js';
import { initHealth } from './features/health.js';
import { initRoleMap } from './features/role-map.js';
import { connect } from './core/stream.js';
import { initAccount } from './features/account.js';
import { initAttachments } from './features/attachments.js';
import { initBackup } from './features/backup.js';
import { initBackupAuto } from './features/backup-auto.js';
import { initBudget } from './features/budget.js';
import { initChanges } from './features/changes.js';
import { initChat } from './features/chat.js';
import { initClaudeCheck } from './features/claude-check.js';
import { initCompact } from './features/compact.js';
import { initOpenCodeCheck } from './features/opencode-check.js';
import { initOpenCodeConfig } from './features/opencode-config.js';
import { initComposerControls, initComposerInput } from './features/composer.js';
import { initConversations } from './features/conversations.js';
import { initDashboard } from './features/dashboard.js';
import { initDraft } from './features/draft.js';
import { initFileViewer } from './features/file-viewer.js';
import { focusMode, initFocus } from './features/focus.js';
import { initGitBar } from './features/git-branches.js';
import { initPromptHistory } from './features/history.js';
import { initLiveOutput } from './features/live-output.js';
import { initMcp } from './features/mcp.js';
import { initHeaderMore, initMoreMenu } from './features/more-menu.js';
import { initNotify } from './features/notify.js';
import { initPalette } from './features/palette.js';
import { initPermissions } from './features/permissions.js';
import { initPhone } from './features/phone.js';
import { initPhoneSheets } from './features/phone-sheets.js';
import { initPicker } from './features/picker.js';
import { initPush } from './features/push.js';
import { initQuota } from './features/quota.js';
import { initQueue } from './features/queue.js';
import { initReport } from './features/report.js';
import { initRoster } from './features/roster.js';
import { initResumeTurn } from './features/resume-turn.js';
import { initRewind } from './features/rewind.js';
import { initSessions } from './features/sessions.js';
import { initMemory } from './features/memory.js';
import { initExtensions } from './features/extensions.js';
import { initPullRequest } from './features/pull-request.js';
import { initSettings } from './features/settings.js';
import { initSpotify } from './features/spotify.js';
import { initStatusline } from './features/statusline.js';
import { initStuck } from './features/stuck.js';
import { initSuggest } from './features/suggest.js';
import { initTasks } from './features/tasks.js';
import { initTeam, renderTeam } from './features/team.js';
import { initTemplates } from './features/templates.js';
import { initTheme } from './features/theme.js';
import { initVoice } from './features/voice.js';
import { initKeyboardInset, initMobileNav, initPanelResizer, initTabs } from './ui/layout.js';
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
initStuck(); // ⚠ stuck detector: chips on running rows (after initChat: #chat exists, its clicks are wired)
initFileViewer();
initTeam();
initViewMode(); // 🧠 Mode Otak ↔ 🏢 Kantor
initFocus(); // 🎯 Mode fokus: the office is hidden and its animation paused (/fokus)
initAppUpdate(); // ⬆ newer Adhit Office: banner + ⚙
initHandoff(); // 🔁 /lanjut: context from the other engine
initHealth(); // 🩺 Kesehatan sistem (⚙ → Sistem; laptop/Tailscale only)
initRoleMap(); // 🧭 learned role mappings (👥 Kelola tim → 🧭)
initRoster(); // 👥 Kelola tim (⚙, ⋯, Ctrl+P, /team)
initStatusline();
initCompact(); // 🧹 /ringkas: the dialog behind the status-line action and the slash command
initAttachments();
initSuggest();
initSessions();
initMemory(); // 🧠 /memory: CLAUDE.md / AGENTS.md editor
initExtensions(); // 🧩 /plugin /agents /hooks
initPullRequest(); // ⇡ PR (gh)
initMoreMenu();
initHeaderMore();
initSettings();
initBudget(); // 💰 budget pemakaian global (⚙ → Umum + 🩺 Kesehatan; laptop/Tailscale only)
initTheme(); // before the first frame: the saved theme is drawn right away
initBackup(); // after initSettings: its #btn-settings listener runs after the dialog's own
initBackupAuto(); // ⏰ Backup otomatis in the same ⚙ section
initClaudeCheck(); // 🧩 Claude Code update detector: banner + ⚙ section
initOpenCodeCheck(); // 🧩 the same for OpenCode (only shown when it is installed)
initOpenCodeConfig(); // 🧩 OpenCode config/agent editor (laptop only)
initNotify();
initPush(); // 📱 Notifikasi HP (push): https only; the ?p=&ap= deep link runs after the first snapshot
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
initDashboard(); // 🗂 Semua project (header, phone Kantor bar, picker, Ctrl+P, /dashboard)
initSpotify(); // ♪ Spotify: pill, ♪ dialog, 🗂 row, ⚙ section, office radio (after initSettings: ⚙ opens first)
initPalette(); // Ctrl+P command palette (the shortcut itself is in ui/shortcuts.js)
initPanelResizer();
initPhoneSheets(); // phone Chat: ＋ / settings / ⋯ sheets (moves .controls into its sheet on a phone)
initKeyboardInset(); // phone: composer above the on-screen keyboard, bottom nav hidden while typing

// ---------- main loop ----------

let last = performance.now();
let lastTeam = 0;
function loop(t) {
  const dt = Math.min((t - last) / 1000, 0.05);
  last = t;
  // 🎯 Mode fokus: the office is hidden and paused — no scene/stage/brain frame at all (still scheduling, so turning
  // it off just resumes on the next frame; `last` stays current, so dt never jumps).
  if (!focusMode.on) {
    for (const scene of scenes.values()) scene.update(dt, t);
    if (brain.on) brain.frame(t, stage.scene); // 🧠 Mode Otak replaces the pixel office while it is on
    else stage.frame(t);
    if (t - lastTeam > 500) {
      renderTeam();
      lastTeam = t;
    }
  }
  requestAnimationFrame(loop);
}

connect();
requestAnimationFrame(loop);
