// 🧱 Firewall banner for the 📱 dialog (pure, no DOM — like claude-check-rules.js): shown only when HTTPS
// really serves a certificate (httpsActive) AND the /api/remote/firewall-check answer says the Tailscale
// ports are NOT covered. `covered === null` (unknown — PowerShell failed) and non-Windows never nag: a
// "maybe" must not block anyone.
//
// The 🔧 button only asks the server to run the SAME fixed elevated command the installer task runs
// (src/firewall-check.js, single source of truth): nothing is constructed in the browser, nothing is
// elevated without the click (fail-closed). `manual` (the command to type by hand) comes from the server's
// fix answer and is shown only after a failed attempt — server text, so it must be rendered escaped.

/**
 * @param {{ platforms?: string, covered?: boolean|null }|null} check  the /api/remote/firewall-check answer
 * @param {{ httpsActive?: boolean, busy?: boolean, fixError?: string|null, manual?: string|null }} [opts]
 *   httpsActive: a certificate is actually being served (state 'ok' | 'expiring'); busy: the fix is running;
 *   fixError: why the last fix attempt did not succeed ('declined' | 'timeout'), null before the first try.
 * @returns {null | { key: string, tone: 'warn', text: string, button: string, hint: string, manual: string|null }}
 */
export function firewallBanner(check, { httpsActive = false, busy = false, fixError = null, manual = null } = {}) {
  if (!httpsActive || !check || check.platforms !== 'windows' || check.covered !== false) return null;
  return {
    key: 'firewall-tailscale',
    tone: 'warn',
    text: fixError
      ? 'Perbaikan otomatis belum berhasil — HTTPS dari HP mungkin masih terblokir firewall Windows.'
      : 'HTTPS dari HP mungkin terblokir firewall Windows.',
    button: busy ? 'Memperbaiki…' : '🔧 Perbaiki (butuh Administrator)',
    hint: 'Butuh jendela izin Administrator (UAC) sekali. Akses HP tetap harus dinyalakan di app ini (📱).',
    manual: fixError ? manual : null,
  };
}
