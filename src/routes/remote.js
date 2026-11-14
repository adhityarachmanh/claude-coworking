// ---------- phone access (📱 Akses dari HP) ----------
// Every /api/remote* route is laptop only: server.js refuses the whole prefix to paired phones.
import { checkFirewallRules, manualFirewallCommand, runFirewallFix } from '../firewall-check.js';
import { networkAddresses } from '../remote.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/remote', ({ remote, tls, push, syncListeners, publishConfig, remoteInfo }, req, res, params, body) => {
    remote.setEnabled(Boolean(body.enabled));
    if (!remote.enabled) push?.forgetAll(); // no notification button stays usable while phone access is off
    syncListeners();
    if (remote.enabled) tls.refresh(); // in the background; a certificate brings the https listener up (onChange)
    publishConfig();
    return json(res, 200, remoteInfo());
  });
  // "Periksa lagi" in the phone dialog: ask Tailscale for the certificate now (laptop only, like all of /api/remote).
  router.post('/api/remote/https-check', async ({ remote, tls, httpsPort, httpsInfo }, req, res) => {
    if (!remote.enabled) return json(res, 400, { error: 'Nyalakan akses dari HP dulu.' });
    if (httpsPort !== null) await tls.refresh();
    return json(res, 200, httpsInfo());
  });
  router.post('/api/remote/pairing', pairing);
  // 🔓 "Pasang otomatis dari perangkat tailnet" (📱 dialog): devices of the laptop owner's own tailnet
  // user pair without the code over the https listener (server.js checks the identity per attempt,
  // src/tailnet.js). Laptop only, like all of /api/remote; the boolean persists in the remote state.
  router.post('/api/remote/auto-pair', ({ remote, publishConfig, remoteInfo }, req, res, params, body) => {
    remote.setAutoPairTailnet(Boolean(body.autoPairTailnet));
    publishConfig();
    return json(res, 200, remoteInfo());
  });
  // `office pair` (Tailscale SSH): the local CLI reads the pairing snapshot with the narrow CLI token. Laptop
  // only in practice (the CLI runs on this machine, minting its token over loopback) — a paired phone has no
  // CLI token, so this route never extends phone reach. The response is the same data the laptop screen shows.
  router.post('/api/pairing/cli', pairingCli, { token: 'cli', maxBody: 64 });
  // 🔔 "Kirim kode ke HP-mu" (⚙ → Akses dari HP): rotate the one-time code now and push the fresh one to the
  // paired phones. Laptop only (LOCAL_ONLY in server.js): a paired phone must not reset the code. The route
  // pushes itself (announce: false) so the response can say whether the push went out (the toast tells the truth).
  // A named handler, like pairing(): tests can call it directly — server.js boots a full app at import, too heavy.
  router.post('/api/pairing/code/push', pairingCodePush, { maxBody: 1024 });
  router.post('/api/remote/revoke', ({ remote, push, dropDeviceStreams, publishConfig }, req, res, params, body) => {
    const id = String(body.id ?? '');
    remote.revoke(id); // its push subscription lives on the record: gone with it
    push?.forgetDevice(id); // and its notification buttons (action tokens)
    dropDeviceStreams(id); // its open event streams end now, not at the next reconnect
    publishConfig();
    return json(res, 200, { ok: true });
  });
  // 🧱 Firewall check (laptop only, like all of /api/remote): does a Windows rule let TCP 4317+4318 in from the
  // Tailscale range? Read-only (`Get-Net*Firewall*`, no admin needed). covered: true/false, null = unknown
  // (PowerShell failed) — the 📱 banner only nags on a definite false, never on unknown; non-Windows: no check.
  // Tests inject `firewallCheck`; production uses the real one (src/firewall-check.js, which never throws).
  router.post('/api/remote/firewall-check', async ({ firewallCheck }, req, res) => {
    return json(res, 200, await (firewallCheck ?? checkFirewallRules)());
  }, { maxBody: 64 });
  // 🔧 One-click fix (laptop only): runs the SAME fixed elevated command the installer task runs (single source
  // of truth: src/firewall-check.js; the .iss is kept in sync by test/firewall-check.test.mjs). Elevation happens
  // only after this explicit click — fail-closed, nothing is auto-run. Then the check runs again: the answer
  // (`check`) is the truth, `ok` only says the elevated window finished without a timeout/cancel.
  router.post('/api/remote/firewall-fix', async ({ firewallCheck, firewallFix }, req, res) => {
    const fix = await (firewallFix ?? runFirewallFix)();
    if (fix.platforms === 'other') return json(res, 400, { error: 'Perbaikan firewall hanya untuk Windows.' });
    const check = await (firewallCheck ?? checkFirewallRules)();
    return json(res, 200, { ...fix, check, manual: manualFirewallCommand() });
  }, { maxBody: 64 });
}

/** 🔔 Rotate the one-time pairing code and push it to the paired phones; the laptop shows the same code it just pushed. */
async function pairingCodePush({ remote, push }, req, res) {
  if (!remote.enabled) return json(res, 400, { error: 'Nyalakan akses dari HP dulu.' });
  const { code, expires } = remote.rotatePairing({ announce: false });
  const result = await push.sendPairingCode({ code, expiresAt: expires });
  return json(res, 200, { ok: true, code, expires, pushed: result.pushed, skipped: result.skipped });
}

/** `office pair`: the pairing snapshot for the local CLI, including whether pairing is paused right now. */
function pairingCli(ctx, req, res) {
  if (!ctx.remote.enabled) return json(res, 400, { error: 'Nyalakan akses dari HP dulu.' });
  if (ctx.remote.pausedUntil > Date.now()) {
    return json(res, 423, { error: 'Pasangan dijeda karena terlalu banyak kode salah. Coba lagi nanti.', until: ctx.remote.pausedUntil });
  }
  // The real pairing handler: same data the laptop screen shows (code, every transport URL, HTTPS info).
  return pairing(ctx, req, res, {}, {});
}

function pairing({ remote, port, httpsInfo }, req, res, params, body) {
  if (!remote.enabled) return json(res, 400, { error: 'Nyalakan akses dari HP dulu.' });
  // Virtual adapters (WSL, Docker) are unreachable from a phone, so they never go in the QR.
  const usable = networkAddresses().filter((a) => a.kind !== 'virtual');
  if (!usable.length) return json(res, 400, { error: 'Laptop tidak terhubung ke jaringan (WiFi/LAN atau Tailscale).' });
  const chosen = usable.find((a) => a.ip === body.ip) ?? usable[0];
  // { https: true }: the QR opens the https (Tailscale) origin, which pairs separately (its own cookie).
  const secureUrl = httpsInfo().url;
  if (body.https === true && !secureUrl) return json(res, 400, { error: 'HTTPS lewat Tailscale belum tersedia.' });
  const { code, key, expires } = remote.currentPairing();
  const base = body.https === true ? secureUrl : `http://${chosen.ip}:${port}`;
  return json(res, 200, {
    code,
    expires,
    ip: chosen.ip,
    url: base,
    qrUrl: `${base}/pair?k=${key}`,
    addresses: usable.map(({ ip, kind, name }) => ({ ip, kind, name })),
    https: secureUrl ? { url: secureUrl, qrUrl: `${secureUrl}/pair?k=${key}` } : null,
  });
}
