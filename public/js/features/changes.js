// Changes tab (git): changed files, diff, review, commit.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';

// project: whose files the list shows; diffFor: `${project}\n${file}` of the diff on screen (both drive the loading state)
export const changes = { selected: null, timer: null, data: null, project: null, diffFor: null };
const LOADING = '<span class="spinner" aria-hidden="true"></span> Memuat…';

function renderDiff(diff) {
  return diff
    .split('\n')
    .map((line) => {
      const cls = line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
      return `<span class="${cls}">${escapeHtml(line) || ' '}</span>`;
    })
    .join('\n');
}

export async function loadChanges() {
  clearTimeout(changes.timer);
  const project = state.active;
  const list = $('#ch-files');
  if (project === DEMO_ID) {
    changes.data = null;
    changes.project = project;
    $('#ch-branch').textContent = '';
    list.innerHTML = '<li class="empty-line">Demo tidak punya repository. Pilih project sungguhan.</li>';
    $('#ch-diff').innerHTML = '';
    $('#changes-count').hidden = true;
    $('#nav-badge-changes').hidden = true;
    return;
  }
  // Loading only when the list shows another project (or nothing yet): the auto-refresh after
  // every tool call keeps the current list in place instead of flickering.
  if (changes.project !== project) {
    list.innerHTML = `<li class="empty-line">${LOADING}</li>`;
    $('#ch-diff').innerHTML = '';
    changes.diffFor = null;
  }
  let data;
  try {
    data = await api(`/api/projects/${project}/changes`);
  } catch (err) {
    if (project !== state.active) return;
    // Nothing stale stays on screen: files, diff, branch and the commit box belong to the failed read.
    changes.data = null;
    changes.project = null;
    changes.diffFor = null;
    $('#ch-branch').textContent = '';
    $('#ch-diff').innerHTML = '';
    $('#ch-commit').hidden = true;
    $('#changes-count').hidden = true;
    $('#nav-badge-changes').hidden = true;
    list.innerHTML = `<li class="empty-line"><div class="state-error">Gagal membaca git: ${escapeHtml(err.message)}</div></li>`;
    return;
  }
  if (project !== state.active) return;
  changes.data = data;
  changes.project = project;
  const count = data.files?.length ?? 0;
  for (const badge of [$('#changes-count'), $('#nav-badge-changes')]) {
    badge.hidden = !count;
    badge.textContent = count;
  }
  if (!data.repo) {
    $('#ch-branch').textContent = '';
    list.innerHTML = `<li class="empty-line">${data.error ? `<div class="state-error">${escapeHtml(data.error)}</div>` : 'Folder ini bukan repository git. Jalankan <code>git init</code> untuk memakai panel ini.'}</li>`;
    $('#ch-diff').innerHTML = '';
    $('#ch-commit').hidden = true;
    return;
  }
  $('#ch-commit').hidden = !count;
  $('#ch-branch').innerHTML = `⎇ <b>${escapeHtml(data.branch || '(detached)')}</b> · ${count ? `${count} file berubah` : 'bersih'}${data.ahead ? ` · ${data.ahead} commit belum di-push` : ''}`;
  if (!count) {
    list.innerHTML = '<li class="empty-line">Tidak ada perubahan yang belum di-commit. ✓</li>';
    $('#ch-diff').innerHTML = '';
    changes.selected = null;
    return;
  }
  if (!data.files.some((f) => f.path === changes.selected)) changes.selected = data.files[0].path;
  const focused = document.activeElement?.closest?.('#ch-files li[data-path]')?.dataset.path; // survives the refresh
  // <bdi>: the row is rtl (ellipsis on the left), the path inside stays ltr so ".env" is not shown as "env."
  list.innerHTML = data.files
    .map((f) => `<li class="${f.path === changes.selected ? 'active' : ''}" data-path="${escapeHtml(f.path)}" role="button" tabindex="0" aria-current="${f.path === changes.selected}"><span class="st st-${f.code.trim()[0] === '?' ? 'A' : escapeHtml(f.code.trim()[0])}">${escapeHtml(f.status)}</span><span class="p"><bdi>${escapeHtml(f.path)}</bdi></span></li>`)
    .join('');
  if (focused) [...list.querySelectorAll('li[data-path]')].find((li) => li.dataset.path === focused)?.focus({ preventScroll: true });
  loadDiff(changes.selected);
}

async function loadDiff(file) {
  changes.selected = file;
  const project = state.active;
  const key = `${project}\n${file}`;
  const box = $('#ch-diff');
  // A newly picked file shows "Memuat…"; a background refresh of the same file keeps the old diff (and scroll).
  if (changes.diffFor !== key || !box.firstChild) box.innerHTML = `<div class="muted ch-loading">${LOADING}</div>`;
  try {
    const { diff, error, truncated } = await api(`/api/projects/${project}/diff`, { file });
    if (changes.selected !== file || state.active !== project) return; // a later pick won the race
    box.innerHTML = error && !diff ? `<div class="state-error">${escapeHtml(error)}</div>` : `<pre>${renderDiff(diff)}</pre>${truncated ? '<div class="muted">Diff dipotong (terlalu besar).</div>' : ''}`;
    changes.diffFor = key;
  } catch (err) {
    if (changes.selected !== file || state.active !== project) return;
    box.innerHTML = `<div class="state-error">${escapeHtml(err.message)}</div>`; // replaces the old diff
    changes.diffFor = null;
  }
}

/** Re-check git after edits/commands, a moment after the dust settles. */
export function scheduleChanges() {
  clearTimeout(changes.timer);
  changes.timer = setTimeout(loadChanges, 1500);
}

export function initChanges() {
  $('#ch-files').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-path]');
    if (!li) return;
    const prev = $('#ch-files .active');
    prev?.classList.remove('active');
    prev?.setAttribute('aria-current', 'false');
    li.classList.add('active');
    li.setAttribute('aria-current', 'true');
    loadDiff(li.dataset.path);
  });
  $('#ch-refresh').addEventListener('click', loadChanges);
  $('#ch-open').addEventListener('click', () =>
    api(`/api/projects/${state.active}/open`, { app: 'code', file: changes.selected || undefined })
      .then(() => toast('Membuka VS Code…', 'ok'))
      .catch((err) => toast(err.message)),
  );
  $('#ch-review').addEventListener('click', async () => {
    try {
      await api(`/api/projects/${state.active}/prompt`, {
        text: 'Minta subagent architect me-review semua perubahan yang belum di-commit (git status & git diff). Laporkan temuan berprioritas (blocker / sebaiknya diperbaiki / saran) dengan file:baris, lalu verdict: siap commit atau perlu perbaikan.',
      });
      document.querySelector('.tabs button[data-tab="chat"]').click();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#ch-commit').addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = $('#ch-message').value.trim();
    if (!message) return toast('Tulis pesan commit dulu.');
    const n = changes.data?.files?.length ?? 0;
    if (!window.confirm(`Commit ${n} file dengan pesan:\n\n"${message}"\n\n(semua perubahan akan di-stage dengan git add -A)`)) return;
    try {
      const res = await api(`/api/projects/${state.active}/commit`, { message });
      $('#ch-message').value = '';
      toast(res.output.split('\n')[0] || 'Commit berhasil.', 'ok');
      loadChanges();
    } catch (err) {
      toast(`Commit gagal: ${err.message}`);
    }
  });
}
