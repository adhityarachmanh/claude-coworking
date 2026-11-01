// Office theme switch (⚙ Pengaturan → Tema kantor): remembered per browser in localStorage, applied
// without a reload — sprite cache and background are rebuilt, avatars in the team strip/chat redrawn.
import { toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { stage } from '../core/scenes.js';
import { CAST } from '../office/cast.js';
import { avatarURL, clearSpriteCache } from '../office/sprites.js';
import { THEME_IDS, THEMES, isTheme, theme } from '../office/themes.js';
import { renderChat } from './chat.js';
import { renderTeam } from './team.js';

export const THEME_KEY = 'office.theme';
const HINT_KEY = 'office.themeHint';

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked (private mode): fall back to the default theme
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not persisted; the switch still works for this page
  }
}

/** Reflects the active theme in the segmented control (toggle buttons, like the report's .seg). */
function syncControl() {
  for (const btn of document.querySelectorAll('#theme-seg button')) {
    const on = btn.dataset.theme === theme.current;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

/** Switches the office theme. `persist: false` applies without remembering (startup, tests). */
export function applyTheme(id, { persist = true } = {}) {
  const next = isTheme(id) ? id : 'kantor';
  if (persist) writeStorage(THEME_KEY, next);
  const changed = theme.current !== next;
  theme.current = next;
  document.documentElement.dataset.officeTheme = next;
  syncControl();
  if (!changed) return;
  clearSpriteCache();
  stage.refreshTheme();
  renderTeam();
  renderChat();
  // Team rename dialog (if open): swap the portraits only, so typed names stay.
  for (const img of document.querySelectorAll('#team-list .team-row img')) {
    const role = img.closest('.team-row').querySelector('input')?.name;
    if (CAST[role]) img.src = avatarURL(CAST[role].look);
  }
}

export function initTheme() {
  const seg = $('#theme-seg');
  seg.innerHTML = THEME_IDS.map((id) => `<button type="button" data-theme="${id}" aria-pressed="false"><span aria-hidden="true">${THEMES[id].icon}</span> ${THEMES[id].label}</button>`).join('');
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-theme]');
    if (btn) applyTheme(btn.dataset.theme);
  });

  const saved = readStorage(THEME_KEY);
  applyTheme(isTheme(saved) ? saved : 'kantor', { persist: false });

  // Seasonal month and no choice made yet: suggest (never switch) the matching theme, once per season per year.
  const now = new Date();
  const season = SEASONS[now.getMonth()];
  if (!saved && season) {
    // Halloween keeps its original marker (just the year), so a hint already shown is not repeated.
    const mark = season.id === 'halloween' ? String(now.getFullYear()) : `${now.getFullYear()}:${season.id}`;
    if (readStorage(HINT_KEY) !== mark) {
      writeStorage(HINT_KEY, mark);
      setTimeout(() => toast(season.text, 'ok'), 1500);
    }
  }
}

// Month (0-based) → suggested theme. Lebaran is left out on purpose: Idulfitri follows the Hijri calendar and moves
// about 11 days every year, so there is no reliable fixed month to suggest it in.
const SEASONS = {
  7: { id: 'agustus', text: '🇮🇩 Sudah Agustus! Dirgahayu RI — coba tema 17 Agustus di ⚙ Pengaturan → Tema kantor.' },
  9: { id: 'halloween', text: '🎃 Sudah Oktober! Coba tema Halloween di ⚙ Pengaturan → Tema kantor.' },
  11: { id: 'natal', text: '🎄 Sudah Desember! Coba tema Natal di ⚙ Pengaturan → Tema kantor.' },
};
