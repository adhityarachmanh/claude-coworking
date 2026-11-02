// ---------- phone access (📱 Akses dari HP) ----------
// Every /api/remote* route is laptop only: server.js refuses the whole prefix to paired phones.
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
  router.post('/api/remote/revoke', ({ remote, push, dropDeviceStreams, publishConfig }, req, res, params, body) => {
    const id = String(body.id ?? '');
    remote.revoke(id); // its push subscription lives on the record: gone with it
    push?.forgetDevice(id); // and its notification buttons (action tokens)
    dropDeviceStreams(id); // its open event streams end now, not at the next reconnect
    publishConfig();
    return json(res, 200, { ok: true });
  });
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
