// ⋯ menu: export the chat, continue in a terminal, open in VS Code / Explorer.
import { api, toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { APP_NAME, state } from '../core/state.js';
import { copyText, saveBlob } from '../core/util.js';
import { roleName } from '../office/cast.js';
import { openNotifySettings } from './notify.js';
import { openPermissions } from './permissions.js';
import { exportActiveSession } from './conversations.js';
import { openRoster } from './roster.js';

export function toggleMoreMenu(open = $('#more-menu').hidden) {
  $('#more-menu').hidden = !open;
  $('#btn-more').setAttribute('aria-expanded', String(open));
}

/** The whole chat of the active project as Markdown: prompts, answers, tools, approvals, results. */
function exportChat() {
  const messages = state.chats[state.active] ?? [];
  if (!messages.length) return toast('Belum ada percakapan untuk diekspor.');
  const project = state.projects.find((p) => p.id === state.active);
  const st = state.statuses[state.active] ?? {};
  const stamp = (ts) => new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  const approvalLabel = { allowed: 'diizinkan', denied: 'ditolak', cancelled: 'dibatalkan', pending: 'menunggu' };
  const lines = [`# ${project?.name ?? 'Percakapan'}`, '', `Diekspor dari ${APP_NAME} · ${stamp(Date.now())}${st.sessionId ? ` · sesi \`${st.sessionId}\`` : ''}`];
  for (const m of messages) {
    if (m.kind === 'user') lines.push('', `## 🧑 Kamu${m.source === 'cli' ? ' (terminal)' : ''} · ${stamp(m.ts)}`, '', m.text);
    else if (m.kind === 'assistant' && m.text) lines.push('', `## ${roleName('claude')} · ${stamp(m.ts)}`, '', m.text);
    else if (m.kind === 'tool') lines.push(`- ${m.status === 'fail' ? '✗' : '✓'} **${roleName(m.role)}**: ${m.text}`);
    else if (m.kind === 'delegate') lines.push(`- ➜ **${roleName(m.role)}** ditugaskan: ${m.text}`);
    else if (m.kind === 'approval') lines.push(`- ✋ Izin: ${m.text} (${approvalLabel[state.approvals.get(m.approvalId)?.status ?? m.status] ?? 'menunggu'})`);
    else if (m.kind === 'result') lines.push('', `> ${m.ok ? '✓ Selesai' : `■ Berhenti${m.text ? `: ${m.text}` : ''}`}`);
    else if (m.kind === 'error') lines.push('', `> ⚠ ${m.text}`);
    else if (m.kind === 'divider') lines.push('', '---', '', `*${m.text}*`);
    else if (m.kind === 'shell') lines.push('', `\`\`\`\n$ ${m.text}\n${m.output ?? ''}\n\`\`\``);
  }
  const slug = (project?.name ?? 'chat').replace(/[^\w.-]+/g, '-');
  // sv-SE formats as YYYY-MM-DD in local time (toISOString would give yesterday's date before 07:00 in Jakarta).
  saveBlob(`${slug}-${new Date().toLocaleDateString('sv-SE')}.md`, new Blob([`${lines.join('\n')}\n`], { type: 'text/markdown' }));
  toast('Percakapan diekspor ke Markdown.', 'ok');
}

/** Desktop ⋯: the rarer header actions, so the top bar stays short. The phone keeps its own ⋯ sheet. */
export function initHeaderMore() {
  const btn = $('#btn-header-more');
  const menu = $('#header-more-menu');
  if (!btn || !menu) return;
  const close = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('#header-more')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) close();
  });
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-header-act]');
    if (!item) return;
    close();
    const act = item.dataset.headerAct;
    if (act === 'notify') openNotifySettings();
    else if (act === 'help') $('#btn-help').click();
    else if (act === 'phone') $('#btn-phone').click();
  });
}

export function initMoreMenu() {
  $('#btn-more').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMoreMenu();
  });
  document.addEventListener('click', (e) => {
    if (!$('#more-menu').hidden && !e.target.closest('#more-menu')) toggleMoreMenu(false);
  });
  $('#more-menu').addEventListener('click', async (e) => {
    const item = e.target.closest('[data-more]');
    if (!item) return;
    toggleMoreMenu(false);
    const project = state.projects.find((p) => p.id === state.active);
    const st = state.statuses[state.active] ?? {};
    try {
      if (item.dataset.more === 'export') exportChat();
      else if (item.dataset.more === 'permissions') openPermissions();
      else if (item.dataset.more === 'roster') openRoster();
      else if (item.dataset.more === 'export-session') await exportActiveSession();
      else if (item.dataset.more === 'terminal') {
        if (!st.sessionId) return toast('Belum ada sesi web. Kirim pesan dulu, lalu sesinya bisa dilanjutkan di terminal.');
        // Two lines work the same in PowerShell, cmd and Git Bash (no && vs ; differences).
        const dir = /^[A-Za-z]:\//.test(project.path) ? project.path.replace(/\//g, '\\') : project.path;
        const ok = await copyText(`cd "${dir}"\nclaude --resume ${st.sessionId}`);
        toast(ok ? 'Perintah disalin. Tempel di terminal untuk melanjutkan sesi ini di CLI.' : 'Gagal menyalin.', ok ? 'ok' : 'error');
      } else {
        await api(`/api/projects/${state.active}/open`, { app: item.dataset.more });
        toast(item.dataset.more === 'code' ? 'Membuka VS Code…' : 'Membuka folder project…', 'ok');
      }
    } catch (err) {
      toast(err.message);
    }
  });
}
