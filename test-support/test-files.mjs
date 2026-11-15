// Classification of the test files, shared by the two runners (test-support/ci-tests.mjs and related-tests.mjs) so
// "which file is slow / which needs a browser" is defined once and cannot drift between them.
//
// Hermetic runs: the office app sets OFFICE_APP_DIR (and may set the other isolation vars) for its own children, and a
// test run inside one inherits that. A test must always exercise the repo checkout, never an installed copy, so every
// wrapper drops these vars before spawning test processes. (A bare `node --test test/x.mjs` outside a runner still
// inherits — unset them first when running files directly.)

/** Every env var that must never reach a test process: they point at real data, ports, or an installed copy. */
export const ISOLATION_ENV_KEYS = [
  'OFFICE_APP_DIR',
  'OFFICE_PORT',
  'OFFICE_HTTPS_PORT',
  'OFFICE_DATA_DIR',
  'PROJECTS_ROOT',
  'CLAUDE_BIN',
  'CLAUDE_PROJECTS_DIR',
  'CLAUDE_CONFIG_FILE',
  'CLAUDE_CONFIG_DIR',
  'OFFICE_TAILSCALE_BIN',
  'OFFICE_BROWSER',
  'OPENCODE_BIN',
  'SPOTIFY_CLIENT_ID',
  'OFFICE_OPENCODE_SHELL_DIR',
  'OFFICE_SHELL_WATCH_MS',
  'OFFICE_OPENCODE_CONFIG_HOME',
];

/** Removes those vars from `env` (default: this process) and returns it, so it can be passed straight to spawn. */
export function dropIsolationEnv(env = process.env) {
  for (const key of ISOLATION_ENV_KEYS) delete env[key];
  return env;
}

/** A browser test: it imports the CDP helper and drives a real page. */
export const isUiFile = (source) => /test-support\/cdp\.mjs/.test(source);

/** A slow test without a browser: it starts a server, spawns a process, or imports the fakes. */
export const isSlowFile = (source) =>
  !isUiFile(source) && /node:child_process|test-support\/(fake-|cdp|run-each)|from '\.\.\/src\/server\.js'/.test(source);
