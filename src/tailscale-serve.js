// 🌐 Tailscale Serve: put the office on the tailnet's HTTPS origin WITHOUT a port (`https://host.ts.net`), which is
// what office networks tend to allow while blocking odd ports like 4318. Tailscale's own guidance is to use `serve`
// (tailnet-only, governed by the tailnet ACLs) and NOT `funnel` for anything holding sensitive data — this app is
// exactly that, so Funnel is deliberately not implemented here.
//
// The daemon is the source of truth: every read asks `tailscale serve status --json`, and every change runs one
// command and reports what Tailscale said. Nothing is written to the user's tailnet config behind their back.

/** Where Serve should proxy: the server's own loopback HTTP listener (never a remote host). */
export const SERVE_TARGET = 'http://127.0.0.1:4317';
export const SERVE_PORT = 443;

const SERVE_HOST = /^[a-z0-9][a-z0-9.-]{2,251}$/; // the MagicDNS name we hand back to the UI

/**
 * Parse `tailscale serve status --json` (or plain `status`) into the one view the UI needs.
 * The JSON shape has changed across Tailscale releases (`TCP`/`Web` maps vs. `Services` list), so every field is
 * treated as optional and an unreadable answer means "not serving" — never a crash, never a false "active".
 * @param {string} text raw stdout of `tailscale serve status --json`
 * @returns {{ active: boolean, url: string|null, port: number|null, raw: object|null }}
 */
export function parseServeStatus(text) {
  let data = null;
  try {
    data = JSON.parse(String(text ?? '').trim() || 'null');
  } catch {
    return { active: false, url: null, port: null, raw: null };
  }
  if (!data || typeof data !== 'object') return { active: false, url: null, port: null, raw: null };
  // 1.9x+ answers `{ TCP: { "443": { HTTPS: true } }, Web: { "host.ts.net:443": { Handlers: { "/": {...} } } } }`.
  const web = data.Web && typeof data.Web === 'object' ? data.Web : {};
  for (const [key, entry] of Object.entries(web)) {
    const m = /^(?<host>[^:]+):(?<port>\d+)$/.exec(key);
    if (!m) continue;
    const host = String(m.groups.host).toLowerCase();
    if (!SERVE_HOST.test(host)) continue;
    const tcp = data.TCP?.[m.groups.port];
    // A handler at "/" is what makes it reachable at the root URL; HTTPS must be on for the main port.
    const handlers = entry?.Handlers && typeof entry.Handlers === 'object' ? Object.keys(entry.Handlers) : [];
    const serves = handlers.includes('/') || handlers.length > 0;
    if (!serves) continue;
    if (Number(m.groups.port) === SERVE_PORT && tcp && tcp.HTTPS === false) continue;
    return { active: true, url: `https://${host}${Number(m.groups.port) === 443 ? '' : `:${m.groups.port}`}`, port: Number(m.groups.port), raw: data };
  }
  // 1.8x answers `{ Services: { "svc:…": … } }` (a Service, not a Serve): reported as not serving our port.
  return { active: false, url: null, port: null, raw: data };
}

/** The command that publishes the office at the tailnet HTTPS root. */
export const serveArgs = () => ['serve', '--bg', `--https=${SERVE_PORT}`, SERVE_TARGET];
/** The command that takes it down again (same flags, `off` at the end — Tailscale needs the flags to match). */
export const serveOffArgs = () => ['serve', `--https=${SERVE_PORT}`, SERVE_TARGET, 'off'];

/**
 * 🌐 Serve/stop a Serve, with the daemon as the only judge: after a change we re-read the status and report that,
 * so "active" in the UI always means the daemon really has it. Errors keep Tailscale's own first line.
 * @param {{ run: (args: string[]) => Promise<string> }} deps `run` executes the tailscale CLI
 * @param {{ on: boolean }} change
 * @returns {Promise<{ ok: boolean, active: boolean, url: string|null, error?: string }>}
 */
export async function setServe(deps, { on }) {
  if (!deps?.run) return { ok: false, active: false, url: null, error: 'Tailscale tidak terpasang di laptop ini.' };
  try {
    await deps.run(on ? serveArgs() : serveOffArgs());
  } catch (err) {
    const first = String(err?.stderr || err?.message || err).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? 'gagal';
    return { ok: false, active: false, url: null, error: first.slice(0, 200) };
  }
  const status = await readServe(deps);
  return { ok: status.active === on, active: status.active, url: status.url, ...(status.active === on ? {} : { error: status.error ?? 'Tailscale belum melaporkan perubahan itu.' }) };
}

/**
 * Read the current Serve state. A machine without Tailscale (or with the CLI off PATH) is not an error worth a red
 * banner: it simply does not serve, and `error` says why in one short line.
 * @param {{ run: (args: string[]) => Promise<string> }} deps
 */
export async function readServe(deps) {
  if (!deps?.run) return { active: false, url: null, port: null, raw: null, error: 'Tailscale tidak terpasang di laptop ini.' };
  try {
    const text = await deps.run(['serve', 'status', '--json']);
    return { ...parseServeStatus(text), error: null };
  } catch (err) {
    const first = String(err?.stderr || err?.message || err).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? 'Tailscale tidak menjawab';
    return { active: false, url: null, port: null, raw: null, error: first.slice(0, 200) };
  }
}
