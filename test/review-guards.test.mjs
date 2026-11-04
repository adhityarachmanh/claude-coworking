// Guards from the review of the "tanpa terminal" features: user-level files only from the laptop, gh's device code
// never over plain WiFi, PRs never from the default branch, argv that can't be read as an option, symlinks refused
// in 🧠 Memory, timeouts that stop the whole process tree, and the phone-login alert for OpenCode providers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pluginAction } from '../src/claude-admin.js';
import { checkPrBranch, createPr, wifiGithubLogin } from '../src/github-pr.js';
import { Hub } from '../src/hub.js';
import { addMcpServer } from '../src/mcp-admin.js';
import { readMemory, writeMemory } from '../src/memory-files.js';
import { execFileTree } from '../src/proc.js';
import { buildRouter } from '../src/routes/index.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_GH = path.join(APP, 'test-support', 'fake-gh.mjs');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-guards-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const router = buildRouter();
const LAPTOP = { local: true };
const TAILSCALE = { local: false };

/** Calls a registered route like server.js does (after its own gates); resolves { status, body }. */
async function call(pattern, ctx, req, body = {}, params = {}) {
  const route = router.routes.find((r) => r.pattern === pattern);
  assert.ok(route, pattern);
  let status = 0;
  let text = '';
  const res = { writeHead: (s) => (status = s), end: (t) => (text = t ?? '') };
  await route.handler(ctx, req, res, params, body);
  return { status, body: text ? JSON.parse(text) : null };
}

/** A temp "home" for os.homedir() (USERPROFILE on Windows, HOME elsewhere), restored after the test. */
function fakeHome(t) {
  const home = mkdtempSync(path.join(TMP, 'home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  return home;
}

function projectCtx(extra = {}) {
  const projectPath = mkdtempSync(path.join(TMP, 'proj-'));
  const project = { id: 'p1', name: 'p1', path: projectPath };
  return {
    project,
    ctx: {
      hub: { engine: 'claude', projects: new Map([['p1', project]]), broadcast() {} },
      sessions: { get: () => ({ reloadSettings() {} }) },
      isLocal: (req) => req.local === true,
      isReadOnly: () => false, // laptop or Tailscale (plain WiFi is refused before these routes)
      allowForce: (req, body) => Boolean(body.force),
      ...extra,
    },
  };
}

test('🧠 Memory: the user-level file is written from the laptop only; project files also over Tailscale', async (t) => {
  const home = fakeHome(t);
  const { ctx, project } = projectCtx();
  const save = (req, key) => call('/api/projects/:id/memory/save', ctx, req, { key, content: `# ${key}\n`, mtime: 0 }, { id: 'p1' });

  const phone = await save(TAILSCALE, 'user');
  assert.equal(phone.status, 403);
  assert.match(phone.body.error, /laptop/);
  assert.equal(existsSync(path.join(home, '.claude', 'CLAUDE.md')), false, 'nothing written');

  assert.equal((await save(TAILSCALE, 'project')).status, 200, 'the project file: Tailscale is fine');
  assert.equal(readFileSync(path.join(project.path, 'CLAUDE.md'), 'utf8'), '# project\n');
  assert.equal((await save(LAPTOP, 'user')).status, 200);
  assert.equal(readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), '# user\n');

  const read = await call('/api/projects/:id/memory', ctx, TAILSCALE, { key: 'user' }, { id: 'p1' });
  assert.equal(read.status, 200, 'reading stays allowed over Tailscale');
  assert.equal(read.body.file.content, '# user\n');
});

test('🧠 Memory: a symlink at a memory path is refused (read and write), the other files still list', async (t) => {
  fakeHome(t);
  const { ctx, project } = projectCtx();
  const target = path.join(TMP, 'secret.txt');
  writeFileSync(target, 'rahasia');
  try {
    symlinkSync(target, path.join(project.path, 'CLAUDE.md'), 'file');
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
    // Windows without Developer Mode: a junction (no privilege needed) is a link for lstat too.
    const dir = mkdtempSync(path.join(TMP, 'junction-target-'));
    writeFileSync(path.join(dir, 'x.txt'), 'rahasia');
    symlinkSync(dir, path.join(project.path, 'CLAUDE.md'), 'junction');
  }
  assert.throws(() => readMemory('claude', project.path, 'project'), (err) => err.status === 409 && /symlink/.test(err.message));
  assert.throws(() => writeMemory('claude', project.path, 'project', 'x', 0), (err) => err.status === 409 && /symlink/.test(err.message));
  assert.equal(readFileSync(target, 'utf8'), 'rahasia', 'the target is untouched');
  const list = await call('/api/projects/:id/memory', ctx, LAPTOP, { key: 'local' }, { id: 'p1' });
  assert.equal(list.status, 200);
  assert.equal(list.body.file.key, 'local');
  assert.ok(!JSON.stringify(list.body).includes('rahasia'));
});

test('🧩 Agents: scope "user" (~/.claude/agents) saved/deleted from the laptop only; project agents over Tailscale', async (t) => {
  const home = fakeHome(t);
  const { ctx, project } = projectCtx();
  const agent = { name: 'reviewer', description: 'Review', prompt: 'Review kode.' };
  const userFile = path.join(home, '.claude', 'agents', 'reviewer.md');

  const denied = await call('/api/projects/:id/agents/save', ctx, TAILSCALE, { ...agent, scope: 'user' }, { id: 'p1' });
  assert.equal(denied.status, 403);
  assert.equal(existsSync(userFile), false);
  assert.equal((await call('/api/projects/:id/agents/save', ctx, TAILSCALE, { ...agent, scope: 'project' }, { id: 'p1' })).status, 200);
  assert.ok(existsSync(path.join(project.path, '.claude', 'agents', 'reviewer.md')));

  assert.equal((await call('/api/projects/:id/agents/save', ctx, LAPTOP, { ...agent, scope: 'user' }, { id: 'p1' })).status, 200);
  assert.ok(existsSync(userFile));
  assert.equal((await call('/api/projects/:id/agents/delete', ctx, TAILSCALE, { name: 'reviewer', scope: 'user' }, { id: 'p1' })).status, 403);
  assert.ok(existsSync(userFile), 'still there');
  assert.equal((await call('/api/projects/:id/agents/delete', ctx, LAPTOP, { name: 'reviewer', scope: 'user' }, { id: 'p1' })).status, 200);
  assert.equal(existsSync(userFile), false);
});

test('🧩 Plugins: force (a fresh `claude plugin list`) is honoured from the laptop only', async () => {
  const log = path.join(TMP, 'plugin-calls.log');
  const script = path.join(TMP, 'fake-plugin-list.mjs');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'x');\nconsole.log(JSON.stringify({ installed: [], available: [] }));\n`);
  const { ctx } = projectCtx({ claude: { command: process.execPath, args: [script] } });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').length : 0);
  assert.equal((await call('/api/claude/plugins', ctx, LAPTOP, { force: true })).status, 200);
  const first = calls();
  assert.equal(first, 1);
  await call('/api/claude/plugins', ctx, TAILSCALE, { force: true });
  assert.equal(calls(), first, 'Tailscale: force ignored, the cached list');
  await call('/api/claude/plugins', ctx, LAPTOP, { force: true });
  assert.equal(calls(), first + 1, 'laptop: refreshed');
});

test('⇡ GitHub login: plain-WiFi clients get the state without the device code or link', (t) => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(TMP, 'hub-')) });
  hub.redactors.set('github-login', wifiGithubLogin);
  const laptop = [];
  const wifi = [];
  const wifiRes = { write: (f) => wifi.push(f) };
  hub.clients.add({ write: (f) => laptop.push(f) });
  hub.clients.add(wifiRes);
  hub.redacted.add(wifiRes);
  hub.broadcast('github-login', { state: 'waiting', code: 'ABCD-1234', url: 'https://github.com/login/device', error: null });
  assert.match(laptop[0], /ABCD-1234/);
  assert.doesNotMatch(wifi[0], /ABCD-1234|login\/device/);
  assert.deepEqual(JSON.parse(wifi[0].match(/^data: (.*)$/m)[1]), { state: 'waiting', code: null, url: null, error: null });
  assert.equal(wifiGithubLogin(null), null);
  // server.js registers it
  assert.match(readFileSync(path.join(APP, 'server.js'), 'utf8'), /hub\.redactors\.set\('github-login', wifiGithubLogin\)/);
  t.diagnostic('redactor checked');
});

/** A repo on `branch` whose origin/HEAD points at `main` (no network: refs written directly). */
function repo({ branch = 'main', originHead = true } = {}) {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (originHead) git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  if (branch !== 'main') git('switch', '-q', '-c', branch);
  return dir;
}

test('⇡ PR: refused on the default branch or into itself (before any push); base must look like a branch', async (t) => {
  const onMain = repo();
  await assert.rejects(checkPrBranch(FAKE_GH, onMain, {}), (err) => err.status === 409 && /branch utama \(main\)/.test(err.message));
  const feature = repo({ branch: 'fitur/x' });
  await assert.rejects(checkPrBranch(FAKE_GH, feature, { base: 'fitur/x' }), (err) => err.status === 409 && /sama dengan branch tujuan/.test(err.message));
  await assert.rejects(checkPrBranch(FAKE_GH, feature, { base: '--head=evil' }), (err) => err.status === 400);
  await assert.rejects(checkPrBranch(FAKE_GH, feature, { base: '.hidden' }), (err) => err.status === 400);
  assert.deepEqual(await checkPrBranch(FAKE_GH, feature, { base: 'main' }), { branch: 'fitur/x', defaultBranch: 'main' });

  // no origin/HEAD locally: GitHub's default branch (gh repo view) decides
  const unknown = repo({ originHead: false, branch: 'trunk' });
  process.env.FAKE_GH_DEFAULT_BRANCH = 'trunk';
  t.after(() => delete process.env.FAKE_GH_DEFAULT_BRANCH);
  await assert.rejects(checkPrBranch(FAKE_GH, unknown, {}), (err) => err.status === 409 && /trunk/.test(err.message));
  delete process.env.FAKE_GH_DEFAULT_BRANCH;
  assert.deepEqual(await checkPrBranch(FAKE_GH, unknown, {}), { branch: 'trunk', defaultBranch: null }, 'unknown default: allowed');
});

test('⇡ PR: gh gets --title=/--body=/--base= (a value starting with "-" is never an option)', async (t) => {
  const log = path.join(TMP, 'gh.log');
  process.env.FAKE_GH_LOG = log;
  t.after(() => delete process.env.FAKE_GH_LOG);
  const pr = await createPr(FAKE_GH, repo({ branch: 'fitur/y' }), { title: '--draft', body: '-b x', base: 'main' });
  assert.equal(pr.url, 'https://github.com/acme/toko/pull/7');
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()), ['--title=--draft', '--body=-b x', '--base=main']);
  await assert.rejects(createPr(FAKE_GH, TMP, { title: 'x', base: '-x' }), (err) => err.status === 400);
});

test('CLI arguments: plugin ids and MCP names must start with a letter or digit', async () => {
  for (const id of ['--help', '-x', '@scope/p', '.p']) await assert.rejects(pluginAction(null, { action: 'install', id }), (err) => err.status === 400, id);
  await assert.rejects(pluginAction(null, { action: 'install', id: 'reviewer@official' }), (err) => err.status === 404, 'valid id: reaches the (missing) CLI');
  for (const name of ['-x', '--scope', '.a', '_a']) await assert.rejects(async () => addMcpServer({ engine: 'claude', bin: { command: 'never-run', args: [] }, projectPath: TMP, request: { name, kind: 'remote', url: 'https://x.test' } }), (err) => err.status === 400, name);
});

test('execFileTree: a timeout stops the child and its grandchildren (the callback comes, err.killed)', async () => {
  const pidFile = path.join(TMP, 'grandchild.pid');
  const parent = path.join(TMP, 'parent.mjs');
  // The parent starts a grandchild that inherits stdout (keeps the pipe open) and both sleep for a minute.
  writeFileSync(parent, `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });\nwriteFileSync(${JSON.stringify(pidFile)}, String(c.pid));\nsetTimeout(() => {}, 60000);\n`);
  const started = Date.now();
  const err = await new Promise((resolve) => execFileTree(process.execPath, [parent], { timeout: 1500, windowsHide: true }, (e) => resolve(e)));
  assert.ok(err?.killed, 'reported as a timeout');
  assert.ok(Date.now() - started < 15_000, `callback after ${Date.now() - started} ms`);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100)); // taskkill is asynchronous
  const left = alive();
  if (left) process.kill(pid); // never leave it behind, even when the assertion fails
  assert.equal(left, false, 'the grandchild is gone too (Windows: taskkill /T; POSIX: the process group)');
});

test('execFileTree: a normal run keeps its normal result (no timeout error), and errors are passed as they are', async () => {
  const run = (args, timeout) => new Promise((resolve) => execFileTree(process.execPath, args, { timeout, encoding: 'utf8', windowsHide: true }, (err, out) => resolve({ err, out })));
  const ok = await run(['-e', 'console.log("halo")'], 10_000);
  assert.equal(ok.err, null);
  assert.equal(ok.out.trim(), 'halo');
  const failed = await run(['-e', 'process.exit(3)'], 10_000);
  assert.equal(failed.err.code, 3);
  assert.ok(!failed.err.killed, 'an ordinary failure is not a timeout');
});

test('👤 OpenCode provider login/logout from a phone raises the same account alert as Claude Code', async () => {
  const fake = path.join(TMP, 'fake-opencode-api.mjs');
  writeFileSync(fake, "console.log(JSON.stringify({ data: { attemptID: 'a1', url: 'https://example.com/login', mode: 'auto' } }));\n");
  const alerts = [];
  const ctx = {
    hub: { engine: 'claude', broadcast: (type, data) => type === 'account-alert' && alerts.push(data) },
    sessions: { accountChanged() {} },
    opencode: { command: process.execPath, args: [fake] },
    device: { id: 'd1', name: 'iPhone Adhit' },
  };
  assert.equal((await call('/api/opencode/login/key', ctx, TAILSCALE, { provider: 'anthropic', key: 'sk-test' })).status, 200);
  assert.equal((await call('/api/opencode/login/oauth', ctx, TAILSCALE, { provider: 'openai', methodID: 'oauth' })).status, 200);
  assert.equal((await call('/api/opencode/logout', ctx, TAILSCALE, { credentialID: 'cred_1' })).status, 200);
  assert.deepEqual(alerts.map((a) => [a.action, a.engine, a.provider, a.device]), [
    ['login', 'opencode', 'anthropic', 'iPhone Adhit'],
    ['login', 'opencode', 'openai', 'iPhone Adhit'],
    ['logout', 'opencode', null, 'iPhone Adhit'],
  ]);
  assert.ok(!JSON.stringify(alerts).includes('sk-test'), 'never the key');
  await call('/api/opencode/logout', { ...ctx, device: null }, LAPTOP, { credentialID: 'cred_1' });
  assert.equal(alerts.length, 3, 'from the laptop itself: no alert');
});

test('Claude-only surfaces are closed while OpenCode is the app engine', async () => {
  const { ctx } = projectCtx();
  ctx.hub.engine = 'opencode';
  const requests = [
    ['/api/projects/:id/permissions', {}],
    ['/api/projects/:id/permissions-edit', {}],
    ['/api/projects/:id/agents', {}],
    ['/api/projects/:id/agents/save', {}],
    ['/api/projects/:id/agents/delete', {}],
    ['/api/projects/:id/hooks', {}],
    ['/api/projects/:id/search', { q: 'abc' }],
    ['/api/projects/:id/export-session', { sessionId: '00000000-0000-0000-0000-000000000000' }],
    ['/api/claude/plugins', {}],
    ['/api/claude/plugins/action', {}],
  ];
  for (const [pattern, body] of requests) {
    const res = await call(pattern, ctx, LAPTOP, body, { id: 'p1' });
    assert.equal(res.status, 409, `${pattern} is Claude-only`);
    assert.match(res.body.error, /Claude Code/, `${pattern} says why`);
  }
});
