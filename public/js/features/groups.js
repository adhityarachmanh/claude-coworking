// 🗂 Parent groups (👤 = features/picker.js's 🏡 button): related repos (web + api + mobile = one product)
// referenced under one named group. Sessions are never moved — the group only points at its members; the merged
// session list (🕘 Riwayat) reads them in place.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID } from '../core/state.js';
import { openModal, closeModal } from '../ui/modals.js';

const groups = { list: [], projects: [] };

export function openGroups() {
  openModal('groups-modal');
  $('#groups-body').innerHTML = '<p class="muted"><span class="spinner"></span> Memuat grup…</p>';
  refresh();
}

async function refresh() {
  try {
    const view = await api('/api/groups/list');
    groups.list = view.groups ?? [];
    groups.projects = view.projects ?? [];
    render();
  } catch (err) {
    $('#groups-body').innerHTML = `<p class="warn">${escapeHtml(err.message)}</p>`;
  }
}

function render() {
  const free = groups.projects.filter((p) => !p.inGroup && p.id !== DEMO_ID);
  const body = [];
  body.push(`<form id="groups-create" class="oc-form">
    <label class="oc-field" for="groups-new-name"><span>Nama grup baru</span><input id="groups-new-name" placeholder="mis. Proyek X (web + api + mobile)" autocomplete="off" spellcheck="false" maxlength="60" /></label>
    <fieldset class="groups-members"><legend>Anggota</legend>
      ${groups.projects.filter((p) => p.id !== DEMO_ID).map((p) => `<label class="groups-member"><input type="checkbox" name="groups-new-member" value="${escapeHtml(p.id)}"> <span>${escapeHtml(p.name)}</span></label>`).join('')}
    </fieldset>
    <button class="primary" type="submit" ${free.length === 0 && !groups.projects.length ? ' disabled' : ''}>Buat grup</button>
  </form>`);
  if (!groups.list.length) body.push('<p class="muted small">Belum ada grup. Buat satu untuk merujuk beberapa repo (web + api + mobile) di bawah satu nama.</p>');
  for (const g of groups.list) {
    const addable = groups.projects.filter((p) => p.id !== DEMO_ID && !g.members.includes(p.id));
    body.push(`<div class="grp-card" data-gid="${escapeHtml(g.id)}">
      <div class="grp-head"><input class="grp-name" data-gid="${escapeHtml(g.id)}" value="${escapeHtml(g.name)}" maxlength="60" aria-label="Nama grup" /><button class="ghost" data-gact="rename" data-gid="${escapeHtml(g.id)}">Simpan nama</button></div>
      <div class="grp-members">${g.members.map((m) => {
        const p = groups.projects.find((x) => x.id === m);
        return `<span class="grp-member"><span>${escapeHtml(p?.name ?? m)}</span><button class="ghost danger-text" data-gact="remove" data-gid="${escapeHtml(g.id)}" data-member="${escapeHtml(m)}" title="Keluarkan dari grup">×</button></span>`;
      }).join('') || '<small class="muted">belum ada anggota</small>'}</div>
      ${addable.length ? `<div class="grp-add"><select data-gid="${escapeHtml(g.id)}" aria-label="Tambah anggota">${addable.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select><button class="ghost" data-gact="add" data-gid="${escapeHtml(g.id)}">＋ Tambah anggota</button></div>` : ''}
      <div class="grp-note"><small class="muted">Sesi tiap repo tetap di tempatnya — grup hanya merujuk. 🕘 Riwayat grup menampilkan semuanya gabungan.</small></div>
      <div class="grp-actions"><button class="ghost" data-gact="sessions" data-gid="${escapeHtml(g.id)}">🕘 Riwayat gabungan</button><button class="ghost danger-text" data-gact="dissolve" data-gid="${escapeHtml(g.id)}">Bongkar grup</button></div>
    </div>`);
  }
  $('#groups-body').innerHTML = body.join('');
  $('#groups-create')?.addEventListener('submit', create);
  for (const b of document.querySelectorAll('#groups-body [data-gact]')) {
    b.addEventListener('click', () => action(b.dataset.gact, b.dataset.gid, b));
  }
}

async function create(e) {
  e.preventDefault();
  const name = $('#groups-new-name')?.value.trim();
  const members = [...document.querySelectorAll('input[name="groups-new-member"]:checked')].map((b) => b.value);
  if (!name) return toast('Nama grup dulu.', 'warn');
  try {
    await api('/api/groups', { name, members });
    toast(`Grup "${name}" dibuat.`, 'ok');
    refresh();
  } catch (err) {
    toast(err.data?.error ?? err.message, 'warn');
  }
}

async function action(act, gid, el) {
  try {
    if (act === 'rename') {
      const name = document.querySelector(`.grp-name[data-gid="${gid}"]`)?.value.trim();
      await api(`/api/groups/${gid}`, { name });
      toast('Nama grup disimpan.', 'ok');
    } else if (act === 'add') {
      const member = document.querySelector(`#groups-body select[data-gid="${gid}"]`)?.value;
      await api(`/api/groups/${gid}`, { add: member ? [member] : [] });
    } else if (act === 'remove') {
      await api(`/api/groups/${gid}`, { remove: [el.dataset.member] });
    } else if (act === 'sessions') {
      // The merged history lives in 🕘 Riwayat sesi: open it on the group's first member; the group view there
      // merges every member's list. Implemented in features/sessions.js (groupSessionsOpen).
      const group = groups.list.find((g) => g.id === gid);
      const first = group?.members.find((m) => groups.projects.some((p) => p.id === m));
      if (!first) return toast('Grup belum punya anggota.', 'warn');
      closeModal('groups-modal');
      const { openSessionsFor } = await import('./sessions.js');
      openSessionsFor(first, gid);
      return;
    } else if (act === 'dissolve') {
      if (!window.confirm('Bongkar grup ini? Project dan sesinya tidak tersentuh.')) return;
      await api(`/api/groups/${gid}/dissolve`, {});
      toast('Grup dibongkar. Project tetap ada.', 'ok');
    }
    refresh();
  } catch (err) {
    toast(err.data?.error ?? err.message, 'warn');
  }
}

export function initGroups() {
  $('#project-groups').addEventListener('click', openGroups);
}
