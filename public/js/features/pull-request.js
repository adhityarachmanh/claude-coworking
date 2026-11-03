// ⇡ Pull request (tab Perubahan → PR): GitHub CLI status, its browser login (device code shown here) and a form that
// pushes the branch and runs `gh pr create` (server: src/routes/extensions.js, src/github-pr.js).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

const pr = { status: null, branch: '', fillWithClaude: null };

// The "let Claude do it" route needs no gh login on this page (Claude runs gh itself), so while the form is hidden
// (gh missing / not logged in) it is offered next to the gh status instead of #pr-claude inside the form.
const claudeButton = () =>
  pr.fillWithClaude ? '<button type="button" class="ghost" data-pr="claude" title="Sisipkan prompt ke kotak pesan (tidak langsung terkirim): Claude membuat pull request">✳ Biar Claude yang buat</button>' : '';

function renderStatus() {
  const s = pr.status;
  const box = $('#pr-gh');
  const form = $('#pr-form');
  if (!s) return void (box.innerHTML = '<p class="muted">Memeriksa GitHub CLI…</p>');
  const login = s.login;
  if (!s.installed) {
    box.innerHTML = `<p>GitHub CLI (<code>gh</code>) belum terpasang. Pasang dari <a href="https://cli.github.com" target="_blank" rel="noopener noreferrer">cli.github.com</a>, lalu buka dialog ini lagi.</p>${claudeButton()}`;
    form.hidden = true;
    return;
  }
  if (s.loggedIn) {
    box.innerHTML = `<p class="muted small">✓ GitHub: ${escapeHtml(s.account ?? 'login')}</p>`;
    form.hidden = false;
    return;
  }
  form.hidden = true;
  if (login?.state === 'waiting') {
    box.innerHTML = `<div class="login-flow"><p>Buka halaman GitHub, lalu masukkan kode ini:</p><p class="pr-code"><b>${escapeHtml(login.code)}</b></p>
      <a class="primary link-btn" href="${escapeHtml(login.url)}" target="_blank" rel="noopener noreferrer">🔑 Buka github.com/login/device</a>
      <p class="muted small"><span class="spinner"></span> Menunggu login selesai…</p><button type="button" class="ghost" data-pr="cancel">Batal</button></div>`;
    return;
  }
  box.innerHTML = `${login?.state === 'error' ? `<p class="warn">Login gagal: ${escapeHtml(login.error ?? '')}</p>` : ''}
    <p>Belum login GitHub. Login sekali di laptop ini (sama seperti <code>gh auth login</code>).</p>
    ${state.local ? '<button type="button" class="primary" data-pr="login">🔑 Login GitHub</button>' : '<p class="muted small">Login GitHub hanya dari laptop.</p>'}
    ${claudeButton()}`;
}

async function refresh() {
  try {
    pr.status = await api('/api/github/status');
  } catch (err) {
    pr.status = { installed: false };
    toast(err.message);
  }
  renderStatus();
}

/** Opens the PR dialog for the branch in the Perubahan tab. `fillWithClaude` = the old "let Claude do it" route. */
export function openPullRequest(branch, { fillWithClaude } = {}) {
  pr.branch = branch;
  pr.fillWithClaude = fillWithClaude;
  $('#pr-branch').textContent = branch ? `· ${branch}` : '';
  $('#pr-title').value ||= '';
  pr.status = null;
  openModal('pr-modal');
  renderStatus();
  refresh();
}

/** Live: the gh login finished or failed (event `github-login`). */
export function onGithubLogin(login) {
  if ($('#pr-modal').hidden) return;
  if (login?.state === 'done') {
    toast('Login GitHub berhasil.', 'ok');
    return refresh();
  }
  if (pr.status) pr.status.login = login;
  renderStatus();
}

export function initPullRequest() {
  $('#pr-gh').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-pr]')?.dataset.pr;
    try {
      if (act === 'login') {
        const login = await api('/api/github/login');
        pr.status = { ...pr.status, login };
        renderStatus();
        if (login?.url) window.open(login.url, '_blank', 'noopener');
      } else if (act === 'claude') {
        pr.fillWithClaude?.();
      } else if (act === 'cancel') {
        await api('/api/github/login/cancel');
        refresh();
      }
    } catch (err) {
      toast(err.message);
    }
  });
  $('#pr-claude').addEventListener('click', () => pr.fillWithClaude?.());
  $('#pr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button.primary');
    btn.disabled = true;
    try {
      const r = await api(`/api/projects/${state.active}/pr`, { title: $('#pr-title').value, body: $('#pr-body').value, base: $('#pr-base').value.trim(), draft: $('#pr-draft').checked });
      toast('Pull request dibuat.', 'ok');
      $('#pr-result').innerHTML = r.url ? `✓ <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.url)}</a>` : escapeHtml(r.output || 'Selesai.');
      $('#pr-title').value = '';
      $('#pr-body').value = '';
    } catch (err) {
      toast(err.message, 'warn');
    } finally {
      btn.disabled = false;
    }
  });
}
