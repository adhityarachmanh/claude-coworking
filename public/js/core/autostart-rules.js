// What a phone is told about "will this PC bring the server back after a reboot?" (⚙ → Sistem). Pure: the status
// comes from the server's config (`autostartStatus()`), and the answer is a single sentence the phone can act on.
// The two switches themselves stay laptop-only: they ask Windows for Administrator and change how the PC logs in.

/** One sentence for a paired phone; '' when this platform has no auto-start at all. */
export function laptopBootNote(status = {}) {
  if (!status || status.supported !== true) return '';
  // Autologon without the lock is the one state that must be said out loud, whatever else is configured.
  if (status.unsafeDesktop) {
    return '⚠️ Autologon Windows menyala tanpa pengunci layar — PC bisa menyala dengan desktop terbuka. Matikan dari laptop di ⚙ → Sistem → Akses saat PC terkunci.';
  }
  const boot = status.mode === 'boot';
  const auto = status.autologon === 'on';
  // Boot mode (the lock task) plus autologon is the only combination that truly survives a reboot untouched.
  if (status.enabled && boot && auto) {
    return '✅ PC ini akan menyalakan server lagi setelah reboot — tidak perlu disentuh. Ubah dari laptop bila perlu.';
  }
  const steps = 'Sekali di PC: ⚙ → Sistem → centang "Nyalakan otomatis saat Windows login", lalu Aktifkan "Akses saat PC terkunci" (sandi akun Microsoft, bukan PIN).';
  if (status.enabled && boot) {
    return `⚠️ Nyalakan otomatis sudah terpasang, tetapi login otomatis Windows belum aktif: setelah reboot server baru hidup ketika ada yang login. ${steps}`;
  }
  if (status.enabled) {
    return `⚠️ Nyalakan otomatis hanya berjalan setelah login Windows: setelah PC restart, server baru hidup ketika ada yang login. ${steps}`;
  }
  return `⚠️ Server belum menyalakan diri setelah reboot: setelah PC mati/restart, Adhitron baru hidup ketika ada yang login ke Windows. ${steps}`;
}
