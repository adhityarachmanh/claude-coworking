// Perubahan tab → ⎇ git bar: current branch + ahead/behind, switch / create branch, fetch, pull (--ff-only),
// push (sets the upstream the first time, never --force), and "🔀 Buat PR" (opens the PR dialog: gh pr create or let Claude do it).
// Reading works everywhere (also a WiFi phone); the actions need the laptop or Tailscale (the server's WiFi gate).
import { openPullRequest } from './pull-request.js';
import { closeModal } from '../ui/modals.js';
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, READ_ONLY_HINT, state } from '../core/state.js';
import { loadChanges } from './changes.js';
import { fillComposer } from './composer.js';
import { renderCi } from './ci-status.js';

export const gitBar = { project: null, info: null, busy: false, seq: 0 };
const BUSY_TEXT = { switch: (n) => `Pindah ke ${n}…`, create: (n) => `Membuat branch ${n}…`, fetch: () => 'Fetch dari remote…', pull: () => 'Pull (fast-forward saja)…', push: () => 'Push ke remote…' };
const ACTIONS = ['#ch-git-select', '#ch-git-new', '#ch-git-fetch', '#ch-git-pull', '#ch-git-push', '#ch-git-pr'];

/** Hides the bar (demo, not a repo, failed read). */
export function hideGitBar() {
  $('#ch-git').hidden = true;
  $('#ch-git-create').hidden = true;
  gitBar.info = null;
  // A hidden bar never leaves live controls behind (keyboard, read-only checks): render() enables them again.
  for (const sel of ACTIONS) $(sel).disabled = true;
}

/**
 * Draws the bar from the changes list's own status right away (branch, ahead/behind), then asks for the
 * branch list. Called by loadChanges after every refresh.
 */
export async function loadGitBar(status) {
  const project = state.active;
  if (!status?.repo || project === DEMO_ID) return hideGitBar();
  if (gitBar.project !== project) {
    gitBar.project = project;
    gitBar.info = null;
    showOutput('');
    $('#ch-git-create').hidden = true;
  }
  $('#ch-git').hidden = false;
  if (!gitBar.info) render({ branch: status.branch, upstream: status.upstream, ahead: status.ahead, behind: status.behind, branches: [], remotes: [], dirty: status.files?.length ?? 0, partial: true });
  const seq = ++gitBar.seq;
  try {
    const info = await api(`/api/projects/${project}/git-branches`);
    if (seq !== gitBar.seq || project !== state.active) return; // a later refresh / another project won
    if (!info.repo) return hideGitBar();
    gitBar.info = info;
    render(info);
  } catch (err) {
    if (seq !== gitBar.seq || project !== state.active) return;
    $('#ch-git-sync').textContent = `daftar branch gagal dimuat: ${err.message}`;
  }
}

function render(info) {
  const select = $('#ch-git-select');
  const names = info.branches.map((b) => b.name);
  if (info.branch && !names.includes(info.branch)) names.unshift(info.branch); // no commits yet / still loading
  const current = info.detached ? '' : info.branch;
  select.innerHTML = `${info.detached ? '<option value="">(detached HEAD)</option>' : ''}${names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}`;
  select.value = current ?? '';
  select.title = info.detached ? 'HEAD detached — pilih branch untuk pindah' : `Branch saat ini: ${current}. Pilih branch lain untuk pindah.`;
  const sync = [];
  if (info.upstream) {
    if (info.gone) sync.push(`upstream ${escapeHtml(info.upstream)} sudah dihapus`);
    else {
      const parts = [info.ahead ? `<b class="ahead" title="${info.ahead} commit belum di-push">↑${info.ahead}</b>` : '', info.behind ? `<b class="behind" title="${info.behind} commit di remote belum di-pull">↓${info.behind}</b>` : ''].filter(Boolean);
      sync.push(`${parts.length ? parts.join(' ') : '<span title="Sama dengan upstream (sejak fetch terakhir)">✓ sinkron</span>'} <span class="muted">${escapeHtml(info.upstream)}</span>`);
    }
  } else if (!info.partial) sync.push(info.remotes.length ? '<span title="Push pertama memasang upstream">belum ada upstream</span>' : '<span title="git remote add origin <url>">tanpa remote</span>');
  $('#ch-git-sync').innerHTML = sync.join(' · ');
  renderCi();
  const ro = Boolean(state.readOnly);
  for (const sel of ACTIONS) {
    const el = $(sel);
    el.disabled = ro || gitBar.busy;
    if (ro) el.title = READ_ONLY_HINT;
  }
  if (ro) return;
  const noRemote = !info.partial && !info.remotes.length;
  $('#ch-git-fetch').disabled ||= noRemote;
  $('#ch-git-pull').disabled ||= !info.upstream || info.gone || info.detached;
  $('#ch-git-push').disabled ||= noRemote || info.detached;
  $('#ch-git-pr').disabled ||= info.detached;
  $('#ch-git-pull').title = info.upstream ? `git pull --ff-only dari ${info.upstream} (tidak pernah membuat merge commit)` : 'Belum ada upstream: push dulu';
  $('#ch-git-push').title = info.upstream && !info.gone ? `git push ke ${info.upstream} (tidak pernah --force)` : 'git push --set-upstream (pertama kali), tidak pernah --force';
}

/** The result area under the bar: git's own message, kept until closed or the next action. */
function showOutput(text, tone = '') {
  const box = $('#ch-git-out');
  box.hidden = !text;
  box.className = `ch-git-out ${tone}`;
  $('#ch-git-text').textContent = text;
}

function setBusy(on) {
  gitBar.busy = on;
  if (gitBar.info) render(gitBar.info);
  else for (const sel of ACTIONS) $(sel).disabled = on || Boolean(state.readOnly);
}

async function runGit(action, extra = {}) {
  if (gitBar.busy || state.readOnly) return;
  const project = state.active;
  setBusy(true);
  showOutput(`⏳ ${BUSY_TEXT[action](extra.name ?? '')}`, 'busy');
  try {
    const res = await api(`/api/projects/${project}/git-action`, { action, ...extra });
    if (project !== state.active) return;
    const head = { switch: `✓ Sekarang di branch ${res.branch}.`, create: `✓ Branch ${res.branch} dibuat dan aktif.`, fetch: '✓ Fetch selesai.', pull: '✓ Pull selesai.', push: res.upstream ? `✓ Push selesai, upstream: ${res.upstream}.` : '✓ Push selesai.' }[action];
    showOutput(res.output ? `${head}\n\n${res.output}` : head, 'ok');
    return res;
  } catch (err) {
    if (project === state.active) showOutput(`✗ ${err.message}`, 'err');
    return null;
  } finally {
    setBusy(false);
    // The changes list (branch, files, ahead/behind) reloads after every action, failed ones too.
    if (project === state.active) loadChanges();
  }
}

const PR_PROMPT = (branch) =>
  `Buat pull request untuk branch \`${branch}\`: pastikan semua perubahan sudah di-commit dan branch sudah di-push (set upstream bila belum; jangan pernah --force), lalu buat PR ke branch default repo dengan \`gh pr create\`. Judul ringkas; deskripsi berisi ringkasan perubahan, cara menguji, dan risiko. Jangan merge. Tampilkan link PR-nya.`;

export function initGitBar() {
  $('#ch-git-select').addEventListener('change', async (e) => {
    const name = e.target.value;
    const info = gitBar.info;
    const back = () => (e.target.value = info?.detached ? '' : (info?.branch ?? ''));
    if (!name || !info || name === info.branch) return back();
    let carry = false;
    if (info.dirty) {
      carry = window.confirm(`Ada ${info.dirty} file belum di-commit.\n\nBawa perubahan itu ke branch "${name}"? (git menolak bila bertabrakan dengan isi branch tujuan)\n\nBatal = tetap di ${info.branch} (commit dulu).`);
      if (!carry) return back();
    }
    if (!(await runGit('switch', { name, carry }))) back();
  });
  $('#ch-git-new').addEventListener('click', () => {
    const form = $('#ch-git-create');
    form.hidden = !form.hidden;
    $('#ch-git-name-error').textContent = '';
    if (!form.hidden) $('#ch-git-name').focus();
  });
  $('#ch-git-create-cancel').addEventListener('click', () => {
    $('#ch-git-create').hidden = true;
    $('#ch-git-new').focus();
  });
  $('#ch-git-name').addEventListener('input', () => ($('#ch-git-name-error').textContent = ''));
  $('#ch-git-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#ch-git-name').value.trim();
    // A quick hint before asking the server (which checks with git check-ref-format).
    const error = !name ? 'Tulis nama branch.' : /\s/.test(name) ? 'Nama branch tidak boleh berisi spasi.' : name.startsWith('-') ? 'Nama branch tidak boleh diawali "-".' : name.includes('..') ? 'Nama branch tidak boleh berisi "..".' : '';
    $('#ch-git-name-error').textContent = error;
    if (error) return $('#ch-git-name').focus();
    if (await runGit('create', { name })) {
      $('#ch-git-name').value = '';
      $('#ch-git-create').hidden = true;
    }
  });
  $('#ch-git-fetch').addEventListener('click', () => runGit('fetch'));
  $('#ch-git-pull').addEventListener('click', () => runGit('pull'));
  $('#ch-git-push').addEventListener('click', () => {
    const info = gitBar.info;
    if (!info?.branch) return;
    const where = info.upstream && !info.gone ? info.upstream : `${info.remotes.includes('origin') ? 'origin' : (info.remotes[0] ?? 'remote')} (upstream baru)`;
    if (!window.confirm(`Push branch "${info.branch}" ke ${where}?${info.ahead ? `\n\n${info.ahead} commit akan dikirim.` : ''}`)) return;
    runGit('push');
  });
  $('#ch-git-out-close').addEventListener('click', () => showOutput(''));
  // Puts the prompt in the composer (not sent): the user reads/edits it first.
  // ⇡ PR: a form (gh pr create after a push), or let Claude write and open it (the prompt, as before).
  $('#ch-git-pr').addEventListener('click', () => {
    const branch = gitBar.info?.branch;
    if (!branch || state.readOnly) return;
    openPullRequest(branch, {
      fillWithClaude: () => {
        closeModal('pr-modal');
        const current = $('#prompt').value.trim();
        fillComposer(current ? `${current}\n\n${PR_PROMPT(branch)}` : PR_PROMPT(branch));
        document.querySelector('.tabs button[data-tab="chat"]')?.click();
        toast('Prompt PR ada di kotak pesan. Periksa, lalu kirim.', 'ok');
      },
    });
  });
}
