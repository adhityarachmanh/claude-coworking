// The model picker's visible panel: groups (⭐ Favorit / Claude Code / one per provider), logos, stars and lock
// hints — the part a native <optgroup> can never carry. The hidden #model select stays the state holder; a row
// click sets its value and fires the same change → saveModel path, so there is exactly one way a model is picked.
import { escapeHtml } from '../core/dom.js';
import { engineLabel, favoriteModelList, groupModels, openCodeProviderGroups } from '../core/engine-caps.js';
import { priceSuffix } from './model-prices.js';
import { logoFileFor, logoIndex } from '../core/model-logo.js';
import { AUTO_MODEL, AUTO_MODEL_LABEL, AUTO_MODEL_TITLE } from './engine.js';

/** A tiny model logo for a row/header: the exact ai_logos file, else the family; '' when unknown. */
const mpLogo = (model, engine = '') => {
  const file = logoFileFor(String(model ?? ''), logoIndex(), engine || (String(model ?? '').includes('/') ? 'opencode' : 'claude'));
  return file ? `<img class="mp-logo" src="/ai-logos/${file}" alt="" aria-hidden="true">` : '';
};

/** One option row: logo, name + price suffix, the current marker, a star toggle for favorites, a lock for the disabled. */
function mpRow(m, rowEngine, { current, engine, locked, favSet }, id) {
  const disabled = locked && rowEngine !== engine;
  const starred = favSet.has(m.value);
  return `<div class="mp-row${m.value === current ? ' active' : ''}${disabled ? ' disabled' : ''}" id="${id}" role="option" aria-selected="${m.value === current}" aria-disabled="${disabled}" data-value="${escapeHtml(m.value)}" data-engine="${escapeHtml(rowEngine)}" title="${escapeHtml(m.value)}">${mpLogo(m.value, rowEngine)}<span class="mp-name">${escapeHtml(`${m.name}${priceSuffix(m.value)}`)}</span><span class="mp-trail"><button type="button" class="mp-star-btn${starred ? ' on' : ''}" data-value="${escapeHtml(m.value)}" title="${starred ? 'Lepas dari ⭐ Favorit' : 'Pin ke ⭐ Favorit'}" aria-label="${starred ? `Lepas ${m.value} dari favorit` : `Pin ${m.value} ke favorit`}">${starred ? '★' : '☆'}</button>${disabled ? '<span class="mp-lock" title="Menunggu giliran ini selesai">🔒</span>' : ''}</span></div>`;
}

/** A disabled info line (loading / failed / empty), the same texts the old select's info options carried. */
const mpInfo = (text) => `<div class="mp-info">${escapeHtml(text)}</div>`;

/**
 * The two entries that are not models but a SETTING: "Auto — sesuaikan task" (the classifier picks the tier) and
 * "Default (dari config <engine>)". The hidden #model select has always carried them first; the visible panel used to
 * omit both, so Auto could not be turned on (or off) from the picker or a project could not go back to Default at all.
 * They sit in one group above ⭐ Favorit, are never starred, and apply through the same mpApplyRow path (values 'auto'
 * and '').
 */
function mpSettingRows({ engine, current, modelAuto, defaultLabel }, nextId) {
  const autoOn = modelAuto === true;
  const row = (value, selected, name, title, modifier = '') =>
    `<div class="mp-row mp-setting${modifier}${selected ? ' active' : ''}" id="${nextId()}" role="option" aria-selected="${selected}" aria-disabled="false" data-value="${escapeHtml(value)}" data-engine="${escapeHtml(engine)}" title="${escapeHtml(title)}"><span class="mp-name">${escapeHtml(name)}</span></div>`;
  return `<div class="mp-group" data-mp-setting><div class="mp-head"><span class="mp-title">Pengaturan</span></div>${row(
    AUTO_MODEL,
    autoOn,
    AUTO_MODEL_LABEL,
    AUTO_MODEL_TITLE,
    ' mp-auto',
  )}${row('', !autoOn && !current, defaultLabel, `Model bawaan dari config ${engineLabel(engine)}`)}</div>`;
}

/**
 * The panel's body: ⭐ Favorit (its stars shown here; wiring is the same /api/model-favorites as the ☆ button),
 * Claude Code (one group), then one group per OpenCode provider (display name + count, "(belum login)" hint,
 * rows disabled when that provider has no credentials). The search filter applies to everything, like before.
 */
export function modelPanelHtml({ catalog, current, query, engine, modelAuto = false, defaultLabel = '', locked, providerNames, providerAuth, favorites, recent = [] }) {
  const claude = catalog?.claude?.models ?? [];
  const opencode = catalog?.opencode?.models ?? [];
  const favSet = new Set(Array.isArray(favorites) ? favorites : []);
  const favs = favoriteModelList(favorites, claude, opencode);
  // "Terakhir di project ini": the three newest picks that still exist in this engine's catalog.
  const known = new Map([...claude.map((m) => [m.value, { ...m, engine: 'claude' }]), ...opencode.map((m) => [m.value, { ...m, engine: 'opencode' }])]);
  const recentModels = (Array.isArray(recent) ? recent : [])
    .map((v) => known.get(v))
    .filter(Boolean)
    .filter((m) => !query || `${m.name} ${m.value}`.toLowerCase().includes(String(query).toLowerCase()));
  let seq = 0;
  const nextId = () => `mp-opt-${seq++}`;
  const groups = [];
  // Always first, whatever the search box says: Auto/Default are settings the user must be able to pick or undo, and
  // they are what the field shows before any model was chosen.
  groups.push(mpSettingRows({ engine, current, modelAuto, defaultLabel: defaultLabel || `Default (dari config ${engineLabel(engine)})` }, nextId));
  if (recentModels.length) {
    groups.push(`<div class="mp-group"><div class="mp-head"><span class="mp-title">Terakhir di project ini</span></div>${recentModels.map((m) => mpRow(m, m.engine, { current, engine, locked, favSet }, nextId())).join('')}</div>`);
  }
  if (favs.length) {
    groups.push(`<div class="mp-group"><div class="mp-head"><span class="mp-title">⭐ Favorit</span></div>${favs.map((m) => mpRow(m, m.engine, { current, engine, locked, favSet }, nextId())).join('')}</div>`);
  }
  const claudeMatches = groupModels(claude, query);
  if (claude.length) {
    const body = claudeMatches.length
      ? claudeMatches.flatMap((g) => g.models.map((m) => mpRow(m, 'claude', { current, engine, locked, favSet }, nextId()))).join('')
      : mpInfo(query ? 'Tidak ada model yang cocok' : 'Katalog Claude belum tersedia');
    groups.push(`<div class="mp-group"><div class="mp-head"><span class="mp-title">Claude</span></div>${body}</div>`);
  }
  const ocGroups = openCodeProviderGroups(opencode, query, providerNames, providerAuth);
  if (opencode.length) {
    let body;
    if (!ocGroups.length) body = mpInfo(query ? 'Tidak ada model yang cocok' : 'Daftar model muncul setelah pesan pertama');
    else {
      body = ocGroups.map((g) => {
        const label = g.connected ? `${g.label} (${g.models.length})` : `${g.label} (belum login)`;
        return `<div class="mp-head"><span class="mp-title">${mpLogo(g.provider, 'opencode')}${escapeHtml(label)}</span></div>${g.models.map((m) => mpRow(m, 'opencode', { current, engine, locked, favSet }, nextId())).join('')}`;
      }).join('');
    }
    groups.push(`<div class="mp-group">${body}</div>`);
  }
  if (!claude.length && !opencode.length) {
    groups.push(`<div class="mp-group">${mpInfo('Daftar model muncul setelah pesan pertama')}</div>`);
  }
  return groups.join('');
}

// ---------- keyboard: the search box is the combobox; rows are highlighted (aria-activedescendant) ----------

/** The panel's enabled rows, in visible order — one row per MODEL (a favorite's duplicate in its provider group is
 *  skipped), so keyboard navigation never stops twice on the same model. */
export const mpRows = (groupsEl) => {
  const out = [];
  const seen = new Set();
  for (const row of groupsEl.querySelectorAll('.mp-row:not(.disabled)')) {
    if (seen.has(row.dataset.value)) continue;
    seen.add(row.dataset.value);
    out.push(row);
  }
  return out;
};

/** Highlights row `i` (clamped): the mp-hl class + aria-activedescendant + scroll it into view. */
export function mpHighlight(groupsEl, i) {
  const rows = mpRows(groupsEl);
  if (!rows.length) return;
  const at = Math.max(0, Math.min(i, rows.length - 1));
  rows.forEach((r, j) => r.classList.toggle('mp-hl', j === at));
  groupsEl.dataset.mpIndex = String(at);
  groupsEl.setAttribute('aria-activedescendant', rows[at].id);
  rows[at].scrollIntoView({ block: 'nearest' });
}

/** Applies one row: the hidden select takes the value and fires the same change → saveModel path as a click. */
export function mpApplyRow(row) {
  const select = document.querySelector('#model');
  if (!select || !row) return false;
  if (![...select.options].some((o) => o.value === row.dataset.value)) return false; // stale panel: the next render re-syncs it
  select.value = row.dataset.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
