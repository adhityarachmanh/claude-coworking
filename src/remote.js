// Access from other devices on the same network (e.g. a phone), off by default.
// A device must be paired once — QR link or 6-digit code shown only on the laptop —
// and then carries a long random device token in an HttpOnly cookie. Only token hashes are stored.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import os from 'node:os';

const PAIRING_TTL_MS = 2 * 60 * 1000;
const MAX_TRIES = 5;
export const DEVICE_COOKIE = 'office_device';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-v|docker|virtualbox|vmware|vbox|br-|veth|virbr/i;
// Tailscale hands out addresses from the CGNAT range 100.64.0.0/10.
const TAILSCALE_IP = /^(::ffff:)?100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const isTailscale = (ip, name) => /tailscale/i.test(name) || TAILSCALE_IP.test(ip);
/** True when a client connects from a Tailscale address (encrypted WireGuard tunnel, not plain WiFi). */
export const isTailscaleIp = (ip) => TAILSCALE_IP.test(String(ip ?? ''));

/**
 * Addresses other devices can reach, best first:
 * WiFi/LAN (same network), Tailscale (from anywhere via your tailnet), then virtual adapters (WSL, Docker).
 * @returns {{ ip: string, kind: 'lan'|'tailscale'|'virtual', name: string }[]}
 */
export function networkAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const kind = isTailscale(a.address, name) ? 'tailscale' : VIRTUAL_ADAPTER.test(name) ? 'virtual' : 'lan';
      found.push({ ip: a.address, kind, name });
    }
  }
  const rank = { lan: 0, tailscale: 1, virtual: 2 };
  return found.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** Every IP the phone listener binds to and answers for. */
export const lanAddresses = () => networkAddresses().map((a) => a.ip);

function deviceName(userAgent = '') {
  const os = /iPhone/.test(userAgent) ? 'iPhone' : /iPad/.test(userAgent) ? 'iPad' : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows' : /Mac OS/.test(userAgent) ? 'Mac' : 'Perangkat';
  const browser = /EdgA?\//.test(userAgent) ? 'Edge' : /CriOS|Chrome\//.test(userAgent) ? 'Chrome' : /FxiOS|Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'browser';
  return `${os} · ${browser}`;
}

export class RemoteAccess {
  constructor(hub) {
    this.hub = hub;
    hub.persisted.remote ??= { enabled: false, devices: [] };
    this.pairing = null;
  }

  get state() {
    return this.hub.persisted.remote;
  }

  get enabled() {
    return this.state.enabled;
  }

  setEnabled(enabled) {
    this.state.enabled = Boolean(enabled);
    this.pairing = null;
    this.hub.save();
  }

  /** Current one-time pairing secrets (rotated after use, expiry or too many wrong codes). */
  currentPairing() {
    if (!this.pairing || Date.now() > this.pairing.expires) {
      this.pairing = {
        code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        key: randomBytes(18).toString('base64url'),
        expires: Date.now() + PAIRING_TTL_MS,
        tries: 0,
      };
    }
    return this.pairing;
  }

  /** @returns {{ token?: string, error?: string, triesLeft?: number }} */
  pair({ code, key }, userAgent) {
    if (!this.enabled) return { error: 'Akses dari perangkat lain sedang dimatikan.' };
    const p = this.pairing;
    if (!p || Date.now() > p.expires) return { error: 'Kode sudah kedaluwarsa. Minta kode baru di laptop (⚙ → Akses dari HP).' };
    const ok = key ? sameSecret(key, p.key) : sameSecret(String(code ?? '').replace(/\D/g, ''), p.code);
    if (!ok) {
      p.tries++;
      if (p.tries >= MAX_TRIES) {
        this.pairing = null;
        return { error: 'Terlalu banyak percobaan salah. Kode diganti — lihat kode baru di laptop.' };
      }
      return { error: 'Kode salah.', triesLeft: MAX_TRIES - p.tries };
    }
    this.pairing = null; // single use
    const token = randomBytes(32).toString('base64url');
    this.state.devices.push({ id: randomUUID(), hash: sha256(token), name: deviceName(userAgent), created: Date.now(), lastSeen: Date.now() });
    this.hub.save();
    return { token };
  }

  /** The paired device for a cookie token, or null. */
  verify(token) {
    if (!token || !this.enabled) return null;
    const hash = sha256(token);
    const device = this.state.devices.find((d) => sameSecret(d.hash, hash));
    if (device && Date.now() - device.lastSeen > 60_000) {
      device.lastSeen = Date.now();
      this.hub.scheduleSave();
    }
    return device ?? null;
  }

  revoke(id) {
    this.state.devices = this.state.devices.filter((d) => d.id !== id);
    this.hub.save();
  }

  /** Safe to send to browsers: no token hashes. */
  publicInfo(port) {
    return {
      enabled: this.enabled,
      urls: this.enabled ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [],
      tailscale: networkAddresses().some((a) => a.kind === 'tailscale'),
      devices: this.state.devices.map(({ id, name, created, lastSeen }) => ({ id, name, created, lastSeen })),
    };
  }
}
