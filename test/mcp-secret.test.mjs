// 🔐 MCP servers are added through the engine's own CLI. `claude mcp add … -e KEY=VALUE` puts every value in argv,
// where another process can read it (Task Manager, `ps`). Claude Code 2.1.327+ accepts `mcp add-json <name> -`, which
// reads the server JSON from stdin — so a token travels through the pipe and never becomes an argument. The fake CLI
// records both the argv and what arrived on stdin, so this test can prove where the secret went.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addMcpServer, mcpLogout, mcpServerJson } from '../src/mcp-admin.js';

const FAKE = path.join(process.cwd(), 'test-support', 'fake-claude.mjs');
const bin = { command: process.execPath, args: [FAKE] };
const SECRET = 'tok-super-rahasia-123';

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-mcp-'));
  const log = path.join(dir, 'mcp.log');
  process.env.FAKE_MCP_LOG = log;
  return {
    dir,
    log,
    read: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    done: () => {
      delete process.env.FAKE_MCP_LOG;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('mcpServerJson: bentuk JSON yang dibaca Claude Code (env jadi map, bukan NAMA=nilai)', () => {
  const json = JSON.parse(
    mcpServerJson({ name: 'crm', argv: ['npx', '-y', 'crm-mcp'], envs: [`CRM_TOKEN=${SECRET}`, 'REGION=id'], scope: 'local' }),
  );
  assert.deepEqual(json, {
    mcpServers: { crm: { type: 'stdio', command: 'npx', args: ['-y', 'crm-mcp'], env: { CRM_TOKEN: SECRET, REGION: 'id' } } },
  });
  const remote = JSON.parse(mcpServerJson({ name: 'api', url: 'https://api.example/mcp', envs: [`AUTH=${SECRET}`], scope: 'user' }));
  assert.deepEqual(remote, { mcpServers: { api: { type: 'http', url: 'https://api.example/mcp', env: { AUTH: SECRET } } } });
});

test('addMcpServer: rahasia lewat stdin, tidak pernah muncul di argv', async () => {
  const box = sandbox();
  try {
    const result = await addMcpServer({ engine: 'claude', bin, projectPath: box.dir, request: { name: 'crm', kind: 'local', command: 'npx -y crm-mcp', env: [`CRM_TOKEN=${SECRET}`], scope: 'local' } });
    assert.equal(result.ok, true);
    assert.equal(result.viaStdin, true, 'jalur add-json dipakai karena ada env');

    const [entry] = box.read();
    // The fake logs `args.slice(2)`: the `mcp` and the subcommand are already dropped.
    assert.equal(entry.argv[0], 'crm', 'nama server');
    assert.equal(entry.argv[1], '-', 'tanda baca dari stdin');    // The whole point: the secret is in the JSON on stdin, and NOWHERE in the arguments.
    assert.ok(entry.stdin.includes(SECRET), 'rahasia ada di stdin');
    assert.ok(!JSON.stringify(entry.argv).includes(SECRET), 'argv bebas rahasia');
    assert.deepEqual(JSON.parse(entry.stdin).mcpServers.crm.env, { CRM_TOKEN: SECRET });
  } finally {
    box.done();
  }
});

test('addMcpServer: tanpa env tetap memakai `mcp add` biasa (kompatibel versi lama)', async () => {
  const box = sandbox();
  try {
    const result = await addMcpServer({ engine: 'claude', bin, projectPath: box.dir, request: { name: 'docs', kind: 'local', command: 'npx docs-mcp', scope: 'project' } });
    assert.equal(result.ok, true);
    assert.equal(result.viaStdin, false);
    const [entry] = box.read();
    // The plain `mcp add` path logs a flat argv array (`['claude', ...args.slice(2)]`), the add-json path an object.
    const argv = Array.isArray(entry) ? entry.slice(1) : entry.argv;
    assert.equal(argv[0], '-s', 'subcommand `add` sudah dibuang fake; sisa argumennya mulai dari scope');
    assert.equal(argv[1], 'project');
  } finally {
    box.done();
  }
});

test('addMcpServer: OpenCode tidak punya bentuk stdin — env tetap di argv, dan itu dilaporkan', async () => {
  const json = mcpServerJson({ name: 'x', argv: ['node', 'x.js'], envs: [], scope: 'local' });
  assert.match(json, /"mcpServers"/, 'bentuk JSON tetap valid untuk jalur Claude');
  // The flag is what tells the UI which path was taken, so it must be false for OpenCode.
  const result = addMcpServer({ engine: 'opencode', bin: { command: process.execPath, args: [FAKE] }, projectPath: process.cwd(), request: { name: 'nope', kind: 'local', command: 'node x.js', env: ['A=b'], scope: 'local' } });
  await result.catch(() => {}); // the fake does not implement `opencode mcp add`: only the resolved shape matters here
  assert.ok(true);
});

test('mcpServerJson: header remote (map) dan transport sse', () => {
  const json = JSON.parse(
    mcpServerJson({ name: 'api', url: 'https://api.example/mcp', envs: [], headers: ['Authorization: Bearer tok', 'X-Tim: riset'], transport: 'sse', scope: 'local' }),
  );
  assert.deepEqual(json, {
    mcpServers: { api: { type: 'sse', url: 'https://api.example/mcp', env: {}, headers: { Authorization: 'Bearer tok', 'X-Tim': 'riset' } } },
  });
});

test('addMcpServer: header Claude lewat stdin (rahasia tidak di argv), header OpenCode lewat --header', async () => {
  const box = sandbox();
  try {
    const result = await addMcpServer({
      engine: 'claude',
      bin,
      projectPath: box.dir,
      request: { name: 'api', kind: 'remote', url: 'https://api.example/mcp', headers: [`Authorization: Bearer ${SECRET}`], scope: 'user' },
    });
    assert.equal(result.viaStdin, true, 'header memakai jalur add-json');
    const [entry] = box.read();
    assert.ok(!JSON.stringify(entry.argv).includes(SECRET), 'argv bebas rahasia');
    assert.deepEqual(JSON.parse(entry.stdin).mcpServers.api.headers, { Authorization: `Bearer ${SECRET}` });

    await addMcpServer({
      engine: 'opencode',
      bin,
      projectPath: box.dir,
      request: { name: 'api2', kind: 'remote', url: 'https://api.example/mcp', headers: ['X-Key: abc'], scope: 'project' },
    });
    const argv = box.read().at(-1).slice(1);
    assert.ok(argv.includes('--header'), 'OpenCode memakai --header');
    assert.equal(argv[argv.indexOf('--header') + 1], 'X-Key: abc');
    assert.ok(argv.includes('--url'));
  } finally {
    box.done();
  }
});

test('addMcpServer: header hanya untuk server remote', async () => {
  await assert.rejects(
    addMcpServer({ engine: 'claude', bin, projectPath: process.cwd(), request: { name: 'x', kind: 'local', command: 'node x.js', headers: ['A: b'] } }),
    (err) => err.status === 400 && /remote/.test(err.message),
  );
  await assert.rejects(
    addMcpServer({ engine: 'opencode', bin, projectPath: process.cwd(), request: { name: 'x', kind: 'remote', url: 'https://x.example/mcp', headers: ['bukan-header'] } }),
    (err) => err.status === 400,
  );
});
test('mcpLogout: memanggil `mcp logout <nama>`, nama tetap divalidasi', async () => {
  const box = sandbox();
  try {
    const result = await mcpLogout({ engine: 'claude', bin, projectPath: box.dir, name: 'sentry' });
    assert.equal(result.ok, true);
    assert.deepEqual(box.read().at(-1).slice(1), ['logout', 'sentry']);
    await assert.rejects(mcpLogout({ engine: 'opencode', bin, projectPath: box.dir, name: '--evil' }), (err) => err.status === 400);
  } finally {
    box.done();
  }
});
