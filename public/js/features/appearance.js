// 🎛️ Tampilan aplikasi: terang/gelap/sistem, ukuran teks, kepadatan, dan animasi. Disimpan per perangkat.
// The office theme (🎨 Tema kantor) is a separate choice: this module only touches the app chrome.
import { $ } from '../core/dom.js';

const KEYS = {
  theme: 'office.appTheme',
  size: 'office.appSize',
  density: 'office.appDensity',
  motion: 'office.appMotion',
};
const THEMES = ['light', 'dark', 'contrast', 'system'];
const SIZES = ['small', 'normal', 'large'];
const DENSITIES = ['comfortable', 'compact'];
const MOTIONS = ['system', 'reduce', 'full'];
const media = window.matchMedia?.('(prefers-color-scheme: light)');
const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');

const read = (key, fallback, allowed) => {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the choice still applies for this page
  }
};

const appearance = {
  theme: read(KEYS.theme, 'system', THEMES),
  size: read(KEYS.size, 'normal', SIZES),
  density: read(KEYS.density, 'comfortable', DENSITIES),
  motion: read(KEYS.motion, 'system', MOTIONS),
};

function resolvedTheme() {
  if (appearance.theme === 'system') return media?.matches ? 'light' : 'dark';
  return appearance.theme;
}

function resolvedMotion() {
  if (appearance.motion === 'system') return reduced?.matches ? 'reduce' : 'full';
  return appearance.motion;
}

function syncControl(id) {
  const current = id === 'theme' ? appearance.theme : id === 'size' ? appearance.size : id === 'density' ? appearance.density : appearance.motion;
  for (const btn of document.querySelectorAll(`[data-appearance="${id}"] button`)) {
    const on = btn.dataset.value === current;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

export function applyAppearance() {
  const root = document.documentElement;
  root.dataset.appTheme = resolvedTheme();
  root.dataset.appSize = appearance.size;
  root.dataset.appDensity = appearance.density;
  root.dataset.appMotion = resolvedMotion();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolvedTheme() === 'light' ? '#f7f5f1' : resolvedTheme() === 'contrast' ? '#000000' : '#16171c');
  syncControl('theme');
  syncControl('size');
  syncControl('density');
  syncControl('motion');
}

function choose(kind, value) {
  const allowed = kind === 'theme' ? THEMES : kind === 'size' ? SIZES : kind === 'density' ? DENSITIES : MOTIONS;
  if (!allowed.includes(value)) return;
  appearance[kind] = value;
  write(KEYS[kind], value);
  applyAppearance();
}

export function initAppearance() {
  for (const kind of ['theme', 'size', 'density', 'motion']) {
    const box = $(`[data-appearance="${kind}"]`);
    if (!box) continue;
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (btn) choose(kind, btn.dataset.value);
    });
  }
  // The OS changed while the page is open: only the "system" choices follow it.
  const follow = () => {
    if (appearance.theme === 'system' || appearance.motion === 'system') applyAppearance();
  };
  media?.addEventListener?.('change', follow);
  reduced?.addEventListener?.('change', follow);
  applyAppearance();
}
