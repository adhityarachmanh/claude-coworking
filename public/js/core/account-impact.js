// What changing an account affects, in one place: the login/logout dialogs confirm with exactly this text before
// anything is sent. Pure (no DOM, no state), so tests read the same words the user sees.

const SHARED = ['Giliran yang sedang berjalan dibiarkan selesai dulu.', 'Antrian semua project dijeda sampai kamu lanjutkan.'];

const IMPACT = {
  'claude-login': {
    title: 'Login dengan akun Claude Code?',
    bullets: [
      'Berlaku untuk seluruh Claude Code di laptop ini (web, terminal & CLI).',
      ...SHARED,
      'Sesi terminal perlu dibuka ulang setelah login.',
    ],
    question: 'Halaman login claude.ai akan dibuka di browser. Lanjutkan?',
  },
  'claude-logout': {
    title: (target) => `Logout dari ${target || 'akun Claude ini'}?`,
    bullets: [
      'Berlaku untuk seluruh Claude Code di laptop ini: web, terminal & CLI ikut keluar.',
      ...SHARED,
      'Sesi terminal perlu dibuka ulang setelah logout.',
    ],
    question: 'Lanjutkan logout?',
  },
  'opencode-logout': {
    title: (target) => `Logout dari ${target || 'provider ini'}?`,
    bullets: [
      'OpenCode di laptop ini (termasuk terminal) tidak bisa memakai provider ini sampai login lagi.',
      'Model dari provider ini tidak bisa dipakai sampai kamu memilih model lain atau Default.',
      ...SHARED,
    ],
    question: 'Lanjutkan logout?',
  },
};

/**
 * The full confirmation text for `kind` ('claude-login' | 'claude-logout' | 'opencode-logout') and, for the logout
 * kinds, who is being signed out. An unknown kind gives '' so a caller can never confirm with an empty dialog.
 */
export function accountImpactText(kind, target = '') {
  const spec = IMPACT[kind];
  if (!spec) return '';
  const title = typeof spec.title === 'function' ? spec.title(String(target ?? '')) : spec.title;
  return [title, '', ...spec.bullets.map((b) => `• ${b}`), '', spec.question].join('\n');
}
