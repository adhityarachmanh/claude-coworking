// 🧩 Skills (/skills): manage the SKILL.md files both engines read, right here (server: src/routes/skills.js,
// src/skills.js). Claude Code reads .claude/skills; OpenCode reads .opencode/skills plus the .claude/skills and
// .agents/skills compatibility roots, project and global. A skill only adds instructions — it never grants a
// permission. A user-scope skill steers every project, so the server refuses to write it from anything but the
// laptop (like plugins and MCP servers); the UI hides those buttons the same way.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

const sk = { project: null, engine: 'claude', roots: [], skills: [], editing: null, saving: false };

const isLocal = () => state.local !== false;

/** The source label of the root to write for a scope (the highest-precedence root of that scope wins). */
function sourceFor(scope, engine = sk.engine) {
  const ofScope = sk.roots.filter((r) => r.scope === scope);
  if (ofScope.length) return ofScope[ofScope.length - 1].source;
  return scope === 'user'
    ? (engine === 'opencode' ? '~/.config/opencode/skills (semua project)' : '~/.claude/skills (semua project)')
    : (engine === 'opencode' ? '.opencode/skills (project)' : '.claude/skills (project)');
}

function render() {
  $('#skills-project').textContent = sk.project ? `· ${projectName(sk.project)}` : '';
  $('#skills-body').innerHTML = sk.editing ? formHtml(sk.editing) : listHtml();
}

function listHtml() {
  const rows = sk.skills.length
    ? `<ul class="ext-list" id="skills-list">${sk.skills
        .map((s) => {
          const meta = [s.id !== s.name ? s.id : '', s.source, s.hasSupport ? '+berkas' : ''].filter(Boolean).join(' · ');
          const note = isLocal() || s.scope !== 'user' ? '' : ' · ubah dari laptop';
          const canEdit = isLocal() || s.scope !== 'user';
          return `<li data-id="${escapeHtml(s.id)}" data-scope="${escapeHtml(s.scope)}"><div><b>${escapeHtml(s.name)}</b> <small class="muted">${escapeHtml(meta)}${note}</small><p class="muted small">${escapeHtml(s.description || '(tanpa deskripsi — model sulit menemukannya)')}</p></div>${
            canEdit ? `<div class="ext-actions"><button class="ghost" data-sk="edit">✎ Edit</button><button class="ghost danger-text" data-sk="del">Hapus</button></div>` : ''
          }</li>`;
        })
        .join('')}</ul>`
    : '<p class="muted small">Belum ada skill di project ini.</p>';
  return `<p class="muted small">Skill = folder berisi <code>SKILL.md</code> yang dimuat saat relevan. Menambah skill hanya menambah instruksi, tidak memberi izin baru.</p>
    <details><summary class="muted small">Folder yang dibaca Claude Code &amp; OpenCode</summary><p class="muted small">Claude Code: <code>.claude/skills</code>. OpenCode juga membaca <code>.opencode/skills</code>, <code>.claude/skills</code>, dan <code>.agents/skills</code> (project maupun semua project).</p></details>
    ${isLocal() ? '' : '<p class="muted small">🔒 Skill untuk <b>semua project</b> hanya bisa diubah dari laptop; skill project ini tetap bisa dari sini.</p>'}
    ${rows}<div class="acct-actions"><button class="primary" id="skills-new">＋ Skill baru</button></div>`;
}

function formHtml(s) {
  return `<form id="skills-form" class="oc-form">
    <label class="oc-field"><span>Nama skill * (huruf kecil, angka, minus)</span><input name="skillId" value="${escapeHtml(s.id ?? '')}" required pattern="[a-z0-9][a-z0-9\\-]{0,63}" placeholder="git-release" autocomplete="off" /></label>
    <label class="oc-field"><span>Berlaku untuk</span><select name="scope">${
      isLocal()
        ? `<option value="project"${s.scope !== 'user' ? ' selected' : ''}>Project ini</option><option value="user"${s.scope === 'user' ? ' selected' : ''}>Semua project</option>`
        : '<option value="project" selected>Project ini</option>'
    }</select>${isLocal() ? '' : '<small class="muted">Skill semua project diubah dari laptop.</small>'}</label>
    <label class="oc-field"><span>Deskripsi * (kapan model memakai skill ini)</span><input name="description" value="${escapeHtml(s.description ?? '')}" required placeholder="Membuat rilis dari changelog" /></label>
    <label class="oc-field"><span>Isi SKILL.md *</span><textarea name="content" rows="12" class="memory-text" spellcheck="false" required>${escapeHtml(s.content ?? '')}</textarea></label>
    <p class="muted small">File pendukung di folder yang sama tetap dipertahankan.</p>
    <div class="acct-actions"><button type="button" class="ghost" data-sk-cancel>Batal</button><button class="primary">💾 Simpan</button></div>
  </form>`;
}

async function load() {
  try {
    const data = await api(`/api/projects/${sk.project}/skills`);
    sk.engine = data.engine;
    sk.roots = data.roots ?? [];
    sk.skills = data.skills;
    render();
  } catch (err) {
    $('#skills-body').innerHTML = `<p class="state-error">${escapeHtml(err.message)}</p>`;
  }
}

export async function openSkills() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (state.readOnly) return toast('Skills hanya bisa dibuka dari laptop atau lewat Tailscale.', 'warn');
  sk.project = state.active;
  sk.editing = null;
  sk.skills = [];
  openModal('skills-modal');
  render();
  await load();
}

export function initSkills() {
  $('#skills-refresh').addEventListener('click', load);
  $('#skills-body').addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('#skills-new')) {
      sk.editing = { id: '', scope: 'project', description: '', content: '', source: sourceFor('project'), previous: null, previousScope: null, previousSource: null };
      return render();
    }
    if (t.closest('[data-sk-cancel]')) {
      sk.editing = null;
      return render();
    }
    const edit = t.closest('[data-sk="edit"]');
    if (edit) {
      const row = edit.closest('li');
      const s = sk.skills.find((x) => x.id === row.dataset.id && x.scope === row.dataset.scope);
      try {
        const { skill } = await api(`/api/projects/${sk.project}/skills/read`, { scope: s.scope, source: s.source, id: s.id });
        sk.editing = { ...skill, previous: skill.id, previousScope: s.scope, previousSource: s.source, source: s.source, scope: s.scope };
        render();
      } catch (err) {
        toast(err.message, 'warn');
      }
      return;
    }
    const del = t.closest('[data-sk="del"]');
    if (del) {
      const row = del.closest('li');
      const s = sk.skills.find((x) => x.id === row.dataset.id && x.scope === row.dataset.scope);
      if (!window.confirm(`Hapus skill ${s.id}?`)) return;
      try {
        await api(`/api/projects/${sk.project}/skills/delete`, { scope: s.scope, source: s.source, id: s.id });
        toast(`Skill ${s.id} dihapus.`, 'ok');
        load();
      } catch (err) {
        toast(err.message, 'warn');
      }
    }
  });
  $('#skills-body').addEventListener('submit', async (e) => {
    if (e.target.id !== 'skills-form' || sk.saving) return;
    e.preventDefault();
    const f = e.target.elements;
    const scope = f.scope.value === 'user' ? 'user' : 'project';
    // Editing keeps the skill's own root; changing scope moves it to the highest-precedence root of that scope.
    const source = sk.editing.previous && scope === sk.editing.previousScope ? sk.editing.previousSource : sourceFor(scope);
    const body = { id: f.skillId.value.trim(), scope, source, previous: sk.editing.previous ?? null, previousScope: sk.editing.previousScope ?? null, previousSource: sk.editing.previousSource ?? null, name: f.skillId.value.trim(), description: f.description.value, content: f.content.value, mtime: sk.editing.mtime ?? 0 };
    sk.saving = true;
    try {
      await api(`/api/projects/${sk.project}/skills/save`, body);
      toast(`Skill ${body.id} tersimpan. Berlaku mulai pesan berikutnya.`, 'ok');
      sk.editing = null;
      await load();
    } catch (err) {
      toast(err.message, 'warn');
    } finally {
      sk.saving = false;
    }
  });
}
