// 🧭 Pemetaan peran (👥 Kelola tim → 🧭): who does work whose name no built-in rule knows (an MCP server, a skill,
// a subagent type, a script, a program). Map a name for this laptop or for the open project (its .office-roles.json,
// shared with the project's team through its git), and optionally let the AI map new names (costs a few tokens per
// name, once). Server: src/role-memory.js.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { CAST, ROLE_ORDER } from '../office/cast.js';
import { closeModal, openModal } from '../ui/modals.js';

const rm = { data: null, busy: false };
const KIND = { mcp: 'MCP', skill: 'Skill', agent: 'Subagent', script: 'Skrip', cmd: 'Program' };
const BY = { manual: '✋ Kamu', ai: '🤖 AI', project: '📁 Project', shared: '🌐 Bersama' };

const project = () => (state.active && state.active !== DEMO_ID ? state.active : null);
const isOpen = () => !$('#rolemap-modal').hidden;
const roleName = (id) => (id === 'claude' ? 'Lead (koordinasi)' : (CAST[id]?.title ?? id));

function roleOptions(selected, roles) {
  const ids = ROLE_ORDER.filter((id) => roles.includes(id));
  return `${selected ? '' : '<option value="">— pilih role —</option>'}${ids.map((id) => `<option value="${id}"${id === selected ? ' selected' : ''}>${escapeHtml(roleName(id))}</option>`).join('')}`;
}

function nameCell(key, extra = '') {
  const [kind, ...rest] = key.split(':');
  return `<span class="rm-name"><small class="pill">${escapeHtml(KIND[kind] ?? kind)}</small> <code>${escapeHtml(rest.join(':'))}</code>${extra}</span>`;
}

function render() {
  const body = $('#rolemap-body');
  const d = rm.data;
  if (!d) return void (body.innerHTML = '<p class="muted">Memuat…</p>');
  const ro = state.readOnly;
  const pid = project();
  const dis = ro || rm.busy ? ' disabled' : '';
  const ai = `<label class="rm-ai switch"><input type="checkbox" id="rm-ai"${d.ai ? ' checked' : ''}${ro || !d.aiAvailable ? ' disabled' : ''}>
      <span><b>🤖 Petakan nama baru otomatis dengan AI</b> <small class="pill warn">pakai token</small><br>
      <small class="muted">Hanya <b>nama</b> tool yang dikirim (tanpa kode, path, perintah, atau chat) ke model termurah mesin aktif (Claude: Haiku; OpenCode: model bawaanmu). Sekitar beberapa ratus token per nama, <b>sekali saja</b>: jawabannya disimpan di laptop ini. Pilihanmu sendiri selalu menang.${d.busy ? ' <i>Sedang menanyakan AI…</i>' : d.queued ? ` <i>${d.queued} nama menunggu.</i>` : ''}${d.lastError ? ` <span class="state-error">${escapeHtml(d.lastError)}</span>` : ''}</small></span></label>`;
  const unknown = d.unknown.length
    ? `<ul class="rm-list">${d.unknown
        .map(
          (u) => `<li data-key="${escapeHtml(u.key)}">${nameCell(u.key, u.hint && !u.key.endsWith(`:${u.hint}`) ? ` <small class="muted">${escapeHtml(u.hint)}</small>` : '')}
          <small class="muted">${u.count}× dipakai${u.aiTried ? ' · AI belum yakin' : ''}</small>
          <span class="rm-acts"><select data-rm="pick" aria-label="Role untuk ${escapeHtml(u.key)}"${dis}>${roleOptions(null, d.roles)}</select>
          <button type="button" class="ghost" data-rm="local"${dis} title="Berlaku di laptop ini (tidak di-push)">💻 Laptop ini</button>
          ${pid ? `<button type="button" class="ghost" data-rm="project"${dis} title="Disimpan di ${escapeHtml(d.projectFile)} project ini (ikut git project kalau kamu commit)">📁 Project ini</button>` : ''}
          <button type="button" class="icon-btn" data-rm="dismiss"${dis} title="Sembunyikan dari daftar" aria-label="Sembunyikan">✕</button></span></li>`,
        )
        .join('')}</ul>`
    : '<p class="muted small">Semua nama yang dipakai sudah dikenali. 🎉</p>';
  const entries = d.entries.length
    ? `<ul class="rm-list">${d.entries
        .map(
          (e) => `<li data-key="${escapeHtml(e.key)}" data-source="${e.source}">${nameCell(e.key)} <small class="pill">${BY[e.by] ?? e.by}</small>
          <span class="rm-acts"><select data-rm="change" aria-label="Role untuk ${escapeHtml(e.key)}"${dis}>${roleOptions(e.role, d.roles)}</select>
          ${e.source === 'local' && pid ? `<button type="button" class="ghost" data-rm="to-project"${dis} title="Pindahkan ke ${escapeHtml(d.projectFile)} project ini">→ 📁 Project</button>` : ''}
          ${e.source !== 'shared' ? `<button type="button" class="ghost" data-rm="share"${dis} title="Berlaku untuk semua pengguna aplikasi lewat update (pemilik repo: langsung ke file bersama; lainnya: usulan lewat GitHub)">🌐 Semua pengguna</button>
          <button type="button" class="icon-btn" data-rm="remove"${dis} title="Hapus pemetaan (kembali ke aturan bawaan)" aria-label="Hapus">🗑</button>` : ''}</span></li>`,
        )
        .join('')}</ul>`
    : '<p class="muted small">Belum ada.</p>';
  body.innerHTML = `${ro ? '<p class="ro-note">Lewat WiFi hanya bisa melihat.</p>' : ''}
    <p class="muted small">Aturan bawaan sudah mengenali sebagian besar pekerjaan (<a href="https://github.com/adhityarachmanh/claude-coworking/blob/main/docs/role-mapping.md" target="_blank" rel="noopener">peta lengkap</a>). Nama di bawah belum dikenali, jadi sementara dikerjakan Lead / Backend / Freelancer. Urutan yang berlaku: 📁 project ini → 💻 laptop ini → 🌐 bersama (ikut update aplikasi, untuk semua pengguna) → aturan bawaan.</p>
    ${ai}
    <h4>Belum dikenali (${d.unknown.length})</h4>${unknown}
    <h4>Sudah dipetakan (${d.entries.length})${pid ? ` <small class="muted">· project ${escapeHtml(projectName(pid))}</small>` : ''}</h4>${entries}`;
}

async function call(path, body = {}) {
  rm.busy = true;
  render();
  try {
    rm.data = await api(path, { project: project(), ...body });
    return true;
  } catch (err) {
    toast(err.data?.error ?? err.message, 'warn');
    return false;
  } finally {
    rm.busy = false;
    if (isOpen()) render();
  }
}

export async function openRoleMap() {
  closeModal('roster-modal');
  rm.data = null;
  openModal('rolemap-modal');
  render();
  await call('/api/team/role-map');
}

/** Live: the AI mapped names, or another device changed the map (stream `role-map`). */
export function onRoleMapChanged() {
  if (isOpen() && !rm.busy) call('/api/team/role-map');
}

export function initRoleMap() {
  $('#roster-map')?.addEventListener('click', openRoleMap);
  const body = $('#rolemap-body');
  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-rm]');
    const li = btn?.closest('li[data-key]');
    if (!btn || btn.tagName === 'SELECT' || state.readOnly) return;
    const key = li?.dataset.key;
    const act = btn.dataset.rm;
    if (act === 'local' || act === 'project') {
      const role = li.querySelector('select').value;
      if (!role) return toast('Pilih role dulu.', 'warn');
      if (await call('/api/team/role-map/set', { key, role, scope: act })) toast(`${key} → ${roleName(role)} (${act === 'project' ? 'project ini' : 'laptop ini'})`, 'ok');
    } else if (act === 'dismiss') await call('/api/team/role-map/dismiss', { key });
    else if (act === 'remove') await call('/api/team/role-map/set', { key, role: null, scope: li.dataset.source === 'project' ? 'project' : 'local' });
    else if (act === 'share') {
      rm.busy = true;
      render();
      try {
        const r = await api('/api/team/role-map/share', { project: project(), key, role: li.querySelector('select').value });
        rm.data = r;
        if (r.mode === 'issue') {
          window.open(r.url, '_blank', 'noopener');
          toast('Usulan dibuka di GitHub: kirim issue-nya. Setelah digabung pemilik repo, semua pengguna mendapatkannya lewat update.', 'ok');
        } else toast(`Ditulis ke ${r.file} di repo aplikasi. Commit & push agar semua pengguna mendapatkannya lewat update.`, 'ok');
      } catch (err) {
        toast(err.data?.error ?? err.message, 'warn');
      } finally {
        rm.busy = false;
        if (isOpen()) render();
      }
    } else if (act === 'to-project') {
      const role = li.querySelector('select').value;
      if (await call('/api/team/role-map/set', { key, role, scope: 'project' })) toast(`${key} dipindah ke file project. Commit file itu agar timmu ikut memakainya.`, 'ok');
    }
  });
  body.addEventListener('change', async (e) => {
    if (state.readOnly) return;
    if (e.target.id === 'rm-ai') {
      const on = e.target.checked;
      if (on && !window.confirm('AI akan memakai sedikit token akun mesin aktif untuk setiap nama baru (sekali per nama). Nyalakan?')) {
        e.target.checked = false;
        return;
      }
      await call('/api/team/role-map/ai', { enabled: on });
      return;
    }
    const sel = e.target.closest('select[data-rm="change"]');
    if (!sel) return;
    const li = sel.closest('li[data-key]');
    // a shared mapping changed here becomes this laptop's own (the shared file is only changed with 🌐)
    await call('/api/team/role-map/set', { key: li.dataset.key, role: sel.value, scope: li.dataset.source === 'project' ? 'project' : 'local' });
  });
}
