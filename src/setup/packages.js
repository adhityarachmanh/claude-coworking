// What setup.cmd/scripts/setup.mjs may install, without pinning npm packages: a version tag would go stale and
// make setup lie about what it fetches. npm itself enforces registry integrity; Node tarballs are checked against
// the official SHASUMS256.txt in runtime.js.

/** Node.js major offered by the portable runtime (the version itself comes from nodejs.org/dist/index.json). */
export const NODE_MAJOR = 24;

/** Official Node.js distribution root. */
export const NODE_DIST = 'https://nodejs.org/dist';

/**
 * Setup targets. `npm` is the package name (no version/tag); `winget` carries the fixed argument list used by
 * setup.cmd for optional extras. `optional: true` steps may be skipped without failing setup.
 */
export const SETUP_TARGETS = Object.freeze({
  node: Object.freeze({
    id: 'node',
    label: 'Node.js',
    kind: 'node',
    major: NODE_MAJOR,
    optional: false,
  }),
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    kind: 'npm',
    npm: '@anthropic-ai/claude-code',
    optional: false,
  }),
  opencode: Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    kind: 'npm',
    npm: '@opencode/cli',
    optional: true,
  }),
  tailscale: Object.freeze({
    id: 'tailscale',
    label: 'Tailscale',
    kind: 'winget',
    winget: Object.freeze({
      id: 'Tailscale.Tailscale',
      args: Object.freeze(['install', '--id', 'Tailscale.Tailscale', '-e', '--accept-source-agreements', '--accept-package-agreements']),
    }),
    optional: true,
  }),
});

/** True for a target id ("claude") or a target object from SETUP_TARGETS. */
export function isSetupTarget(value) {
  if (typeof value === 'string') return Object.hasOwn(SETUP_TARGETS, value);
  return Boolean(value && typeof value === 'object' && typeof value.id === 'string' && Object.hasOwn(SETUP_TARGETS, value.id));
}

/**
 * Base name of the Windows Node.js archive and its folder: `node-v24.11.0-win-x64`.
 * Accepts the version with or without the leading `v` from index.json.
 */
export function nodeZipName(version, arch = 'x64') {
  const clean = String(version ?? '')
    .trim()
    .replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(clean)) throw new TypeError(`Versi Node.js tidak valid: ${version}`);
  if (!/^[a-z0-9]+$/i.test(String(arch))) throw new TypeError(`Arsitektur tidak valid: ${arch}`);
  return `node-v${clean}-win-${arch}`;
}
