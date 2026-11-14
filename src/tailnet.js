// Who is connecting over the https (Tailscale) listener? Feature "pasang otomatis dari perangkat
// tailnet": a device of the LAPTOP OWNER'S OWN tailnet user may pair without the 6-digit code, because
// the tailnet itself already proves who it is (the WireGuard identity, not an IP anyone can claim).
// Everything else — another tailnet user's device, a shared-in device, plain WiFi, a missing CLI,
// garbage CLI output — keeps the code flow. Any doubt → null → fail closed to the code.
import { cliRunner, findTailscale } from './tls.js';

// `tailscale status --json` used to run on every pairing request, so a page on another site could flood
// the CLI. One short-lived cache (default 5 s, OFFICE_TAILNET_CACHE_MS, 0 = off) answers the repeats, and
// concurrent callers share a single CLI process. Failures are never cached: the next request asks again
// (fail closed stays fail closed, no stale "eligible" answer).
export const DEFAULT_TAILNET_CACHE_MS = 5000;
// This path only answers "is this peer the owner's", so it needs far less patience than certificate renewal.
const STATUS_TIMEOUT_MS = 10_000;
let cachedStatus = null; // { bin, at, status }
let inFlight = null; // { bin, promise }

/**
 * The status cache lifetime: OFFICE_TAILNET_CACHE_MS when it is an integer >= 0 (0 = off), else 5 s.
 * @param {object} [env]
 * @returns {number}
 */
export function tailnetCacheMs(env = process.env) {
  const raw = env?.OFFICE_TAILNET_CACHE_MS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TAILNET_CACHE_MS;
  const ms = Number(raw);
  return Number.isInteger(ms) && ms >= 0 ? ms : DEFAULT_TAILNET_CACHE_MS;
}

/** Forgets the cached status and any run in flight (tests change the fake tailnet between cases). */
export function clearTailnetCache() {
  cachedStatus = null;
  inFlight = null;
}

/** One `status --json` per bin at a time; the answer is cached for `tailnetCacheMs(env)`. */
async function statusFor(bin, env) {
  const ttl = tailnetCacheMs(env);
  if (ttl > 0 && cachedStatus && cachedStatus.bin === bin && Date.now() - cachedStatus.at < ttl) return cachedStatus.status;
  if (inFlight && inFlight.bin === bin) return inFlight.promise;
  const promise = cliRunner(bin, { timeoutMs: STATUS_TIMEOUT_MS })(['status', '--json'])
    .then((out) => {
      const status = JSON.parse(out); // garbage throws here: never cached, the caller fails closed
      if (ttl > 0) cachedStatus = { bin, at: Date.now(), status };
      return status;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { bin, promise };
  return promise;
}

/** The connection address without the IPv4-mapped prefix; lowercase (IPv6 hex case). */
const plainIp = (ip) => String(ip ?? '').trim().replace(/^::ffff:/, '').toLowerCase();

/**
 * Maps the connecting IP to a tailnet peer from `tailscale status --json` and says whether that peer
 * belongs to the laptop's own user (`Self.UserID`). Only an exact address match counts — IPv4 and IPv6
 * both work, each compared string-exact against every `TailscaleIPs` entry, so a peer with several
 * addresses is matched by the one the connection actually used. A peer of another user, a status
 * without `Self.UserID`, or anything malformed → null (the code flow stays).
 * @param {object|null} status parsed `tailscale status --json`
 * @param {string} ip the connection's remote address (::ffff: prefix tolerated)
 * @returns {object|null} the matching peer record, or null = not eligible
 */
export function tailnetPeer(status, ip) {
  if (typeof ip !== 'string') return null;
  const address = plainIp(ip);
  if (!address) return null;
  const selfId = status?.Self?.UserID;
  if (selfId === undefined || selfId === null || selfId === '') return null;
  for (const peer of Object.values(status?.Peer ?? {})) {
    const ips = Array.isArray(peer?.TailscaleIPs) ? peer.TailscaleIPs : [];
    if (!ips.some((a) => plainIp(a) === address)) continue;
    // Shared-in devices of other tailnet users have their own UserID: not the owner's, not eligible.
    return String(peer.UserID) === String(selfId) ? peer : null;
  }
  return null; // no peer owns this address: not a tailnet device at all
}

/**
 * The device record's display name for a peer: its hostname (HostName, else DNSName without the
 * trailing dot), else "Tailnet <login>" (the login lives in status.User[UserID]).
 * @param {object} peer a peer record of tailnetPeer()
 * @param {object} [status] the full status it came from (for the login fallback)
 */
export function peerDeviceName(peer, status = null) {
  const host = String(peer?.HostName ?? peer?.DNSName ?? '').replace(/\.$/, '').trim();
  if (host) return host;
  const login = String(status?.User?.[String(peer?.UserID)]?.LoginName ?? '').trim();
  return login ? `Tailnet ${login}` : 'Perangkat Tailnet';
}

/**
 * Maps `ip` to an eligible owner peer from `tailscale status --json` (cached for a few seconds and shared
 * by concurrent callers, see statusFor). No binary, a failing CLI, unparseable output, or a slow CLI
 * (10 s) → null: the code flow continues, never a crash.
 * @param {string} ip the connection's remote address
 * @param {object} [env] environment (tests inject one; default process.env — OFFICE_TAILSCALE_BIN etc.)
 * @returns {Promise<{ peer: object, name: string }|null>}
 */
export async function eligibleTailnetPeer(ip, env = process.env) {
  const bin = findTailscale(env); // the same resolver the https certificate uses — never a second copy
  if (!bin) return null;
  let status;
  try {
    status = await statusFor(bin, env);
  } catch {
    return null; // missing binary, CLI error, or garbage: not eligible
  }
  const peer = tailnetPeer(status, ip);
  return peer ? { peer, name: peerDeviceName(peer, status) } : null;
}
