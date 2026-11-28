// 📜 Catatan rilis Adhitron: the bundled CHANGELOG.md, newest section first. Read-only; the server parses the file.
import { api } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { renderMarkdown } from '../markdown.js';
import { openModal } from '../ui/modals.js';

export async function openReleaseNotes() {
  openModal('release-notes-modal');
  const body = $('#release-notes-body');
  body.innerHTML = '<p class="muted"><span class="spinner" aria-hidden="true"></span> Memuat catatan rilis…</p>';
  try {
    const data = await api('/api/release-notes');
    const sections = Array.isArray(data?.sections) ? data.sections : [];
    if (!sections.length) {
      body.innerHTML = '<p class="muted">Belum ada catatan rilis di instalasi ini.</p>';
      return;
    }
    body.innerHTML = sections
      .map((s) => `<section class="release-notes-section"><h3>${escapeHtml(s.version)}</h3><div class="md">${renderMarkdown(s.body)}</div></section>`)
      .join('');
  } catch (err) {
    body.innerHTML = `<div class="state-error">${escapeHtml(err.message)}</div>`;
  }
}
