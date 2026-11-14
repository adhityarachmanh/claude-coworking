// Parent group proyek terkait (web + API + mobile = satu produk): persisted.projectGroups menyimpan grup,
// folder semantics (satu project maksimal satu grup — masuk grup baru = pindah), dan route CRUD + daftar
// sesi GABUNGAN yang hanya MERUJUK (sesi tetap milik repo masing-masing, tidak pernah dipindah).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
// CLAUDE_PROJECTS_DIR must be set BEFORE transcripts.js is imported (it reads the env at module load), so
// Hub and the router are imported dynamically inside before() — after the env is in place.
const TRANSCRIPTS = path.join(mkdtempSync(path.join(tmpdir(), 'office-groups-')), 'claude-projects');
const TMP = path.dirname(TRANSCRIPTS);

let Hub = null;
let buildRouter = null;
let router = null;
const DIRS = [];

before(async () => {
  process.env.CLAUDE_PROJECTS_DIR = TRANSCRIPTS;
  ({ Hub } = await import('../src/hub.js'));
  ({ buildRouter } = await import('../src/routes/index.js'));
  router = buildRouter();
});
after(() => {
  delete process.env.CLAUDE_PROJECTS_DIR;
  rmSync(path.dirname(TRANSCRIPTS), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  DIRS.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
});

const makeHub = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-groups-hub-'));
  DIRS.push(dir);
  const hub = new Hub({ dataDir: dir });
  // Three real projects (web/api/mobile) so member validation has something to check against.
  for (const [id, name] of [['pweb', 'web'], ['papi', 'api'], ['pmob', 'mobile']]) {
    hub.projects.set(id, { id, name, path: path.join(TMP, name), sources: ['custom'] });
  }
  return hub;
};

function fakeRes() {
  const res = { status: 0, headers: {}, body: '' };
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.writeHead = (status, headers = {}) => {
    res.status = status;
    Object.assign(res.headers, headers);
  };
  res.end = (b) => (res.body = String(b ?? ''));
  res.json = () => JSON.parse(res.body);
  return res;
}

async function call(p, body = {}, ctx) {
  const m = router.match('POST', p);
  assert.ok(m, `${p} harus terdaftar`);
  const res = fakeRes();
  await m.route.handler(ctx, { headers: {} }, res, m.params, body);
  return res;
}

// ---------- hub: data + folder semantics ----------

test('hub: create/rename/dissolve grup, tersimpan di state.json', () => {
  const hub = makeHub();
  const group = hub.createProjectGroup('Proyek X', ['pweb', 'papi']);
  assert.equal(group.name, 'Proyek X');
  assert.deepEqual(group.members, ['pweb', 'papi']);
  assert.equal(hub.groupOf('pweb').id, group.id, 'folder semantics: project ada di grupnya');

  hub.updateProjectGroup(group.id, { name: 'Proyek X v2' });
  assert.equal(hub.projectGroups()[0].name, 'Proyek X v2');
  assert.deepEqual(new Hub({ dataDir: hub.dataDir }).projectGroups()[0]?.name, 'Proyek X v2', 'tersimpan');

  hub.dissolveProjectGroup(group.id);
  assert.deepEqual(hub.projectGroups(), []);
  assert.equal(hub.groupOf('pweb'), null, 'dissolve tidak menyentuh project');
});

test('hub: folder semantics — project pindah grup, maksimal satu grup; anggota dedupe', () => {
  const hub = makeHub();
  const a = hub.createProjectGroup('A', ['pweb']);
  hub.createProjectGroup('B', ['papi']);
  hub.updateProjectGroup(a.id, { add: ['pweb', 'pweb'] }); // pin ulang: no-op, tanpa duplikat
  assert.deepEqual(hub.projectGroups().find((g) => g.id === a.id).members, ['pweb']);
  hub.updateProjectGroup(a.id, { add: ['papi'] }); // pindah dari B ke A
  assert.deepEqual(hub.projectGroups().find((g) => g.id === a.id).members, ['pweb', 'papi']);
  assert.equal(hub.groupOf('papi').id, a.id, 'satu grup per project');
  assert.equal(hub.projectGroups().some((g) => g.name === 'B'), false, 'grup yang kehabisan anggota membubarkan dirinya');
  hub.updateProjectGroup(a.id, { remove: ['pweb'] });
  assert.deepEqual(hub.groupOf('pweb'), null);
});

test('hub: validasi — nama kosong/panjang, anggota tidak dikenal, id grup tak dikenal', () => {
  const hub = makeHub();
  assert.equal(hub.createProjectGroup('', ['pweb']), null);
  assert.equal(hub.createProjectGroup('x'.repeat(61), ['pweb']), null);
  assert.equal(hub.createProjectGroup('OK', ['tidak-ada']), null, 'anggota harus project yang ada');
  const g = hub.createProjectGroup('OK', ['pweb']);
  assert.equal(hub.updateProjectGroup('tidak-ada', { name: 'x' }), null);
  assert.equal(hub.updateProjectGroup(g.id, { add: ['tidak-ada'] }), null, 'anggota asing ditolak');
  assert.equal(hub.dissolveProjectGroup('tidak-ada'), null);
  assert.deepEqual(hub.projectGroups().find((x) => x.id === g.id).members, ['pweb'], 'tolakan tidak mengubah apa pun');
});

test('hub: project yang dilupakan dibersihkan dari semua grup', () => {
  const hub = makeHub();
  hub.createProjectGroup('A', ['pweb', 'papi']);
  hub.removeProjectFromGroups('pweb');
  assert.deepEqual(hub.projectGroups()[0].members, ['papi']);
  hub.removeProjectFromGroups('papi');
  assert.deepEqual(hub.projectGroups(), [], 'grup kosong ikut hilang');
});

// ---------- routes: CRUD + daftar sesi gabungan ----------

function ctxFor(hub) {
  return { hub, opencode: null, ledger: { query: () => [] }, device: null, sessions: {}, taskQueue: { pauseAll: () => {} } };
}

test('route /api/groups: create → update → dissolve; anggota asing 400', async () => {
  const hub = makeHub();
  hub.config = { engine: 'claude' };
  const ctx = ctxFor(hub);

  const created = await call('/api/groups', { name: 'Proyek X', members: ['pweb', 'papi'] }, ctx);
  assert.equal(created.status, 200, created.body);
  const group = created.json().group;
  assert.equal(group.name, 'Proyek X');
  assert.deepEqual(group.members, ['pweb', 'papi']);

  const listed = await call('/api/groups/list', {}, ctx);
  assert.equal(listed.status, 200, listed.body);
  assert.equal(listed.json().groups.length, 1, 'grup terdaftar di list');
  assert.ok(listed.json().projects.some((p) => p.id === 'pmob'), 'project bebas ikut list');

  const bad = await call('/api/groups', { name: 'Proyek X', members: ['tidak-ada'] }, ctx);
  assert.equal(bad.status, 400, 'anggota tidak dikenal ditolak');

  const updated = await call(`/api/groups/${group.id}`, { name: 'Proyek X v2', remove: ['papi'] }, ctx);
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json().group.members, ['pweb']);

  const gone = await call(`/api/groups/${group.id}/dissolve`, {}, ctx);
  assert.equal(gone.status, 200);
  assert.deepEqual(hub.projectGroups(), []);
});

function writeTranscript(projectPath, sessionId, title) {
  const dir = path.join(TRANSCRIPTS, path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ type: 'user', message: { content: title }, entrypoint: 'cli', timestamp: new Date('2026-11-13T08:00:00Z').toISOString() });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${line}\n`);
}

test('route sesi gabungan: sesi tiap anggota di-merge urut waktu + label sumber, tanpa memindahkan apa pun', async () => {
  const hub = makeHub();
  hub.config = { engine: 'claude' };
  const ctx = ctxFor(hub);
  // Two member repos, each with its own transcript (the sessions stay where they are).
  writeTranscript(path.join(TMP, 'web'), '11111111-1111-4111-8111-111111111111', 'fix login web');
  writeTranscript(path.join(TMP, 'api'), '22222222-2222-4222-8222-222222222222', 'tambah endpoint api');
  const group = hub.createProjectGroup('Proyek X', ['pweb', 'papi']);

  const res = await call(`/api/groups/${group.id}/sessions`, {}, ctx);
  assert.equal(res.status, 200, res.body);
  const body = res.json();
  assert.equal(body.group, group.id);
  const entries = body.sessions;
  assert.equal(entries.length, 2, 'dua sesi dari dua repo');
  for (const s of entries) {
    assert.ok(s.project && s.projectName, 'label sumber ada');
    assert.ok(['web', 'api'].includes(s.projectName), 'label sumber benar');
  }
  assert.deepEqual(entries.map((s) => s.title), ['tambah endpoint api', 'fix login web'], 'merge urut waktu (api lebih baru)');
  // Referensi saja: data sesi di repo masing-masing tidak tersentuh.
  assert.ok(hub.sessionIdFor('pweb') == null, 'current sesi pweb tidak berubah');
});
