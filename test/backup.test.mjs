// History backup end to end: two real servers (fake Claude Code) with different home folders. Export from
// "the old laptop" A, import into "the new laptop" B: folders remapped to B's home, merge rules, usage and
// prompt history merged, sessions listed by the API, limits and zip-slip refused. Throwaway folders only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeProjectPath, makeRemap } from '../src/backup.js';
import { projectId as projectIdOf } from '../src/util.js';
import { ZipReader, ZipWriter } from '../src/zip.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-backup-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIT = 2 * 1024 * 1024; // B's upload limit (OFFICE_BACKUP_MAX_BYTES)
const DAY_AGO = new Date(Date.now() - 86_400_000);
const S = (n) => `0000000${n}-aaaa-4bbb-8ccc-000000000000`; // session ids

const homeA = path.join(TMP, 'homeA');
const homeB = path.join(TMP, 'homeB');
const machine = (home, name) => ({
  home,
  data: path.join(TMP, `data${name}`),
  claude: path.join(home, '.claude'),
  projects: path.join(home, '.claude', 'projects'),
  root: path.join(home, 'projects'),
});
const A = machine(homeA, 'A');
const B = machine(homeB, 'B');

const line = (sessionId, cwd, text, ts) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid: `${sessionId}-${ts}`, parentUuid: null, sessionId, cwd, timestamp: new Date(ts).toISOString(), promptSource: 'typed', entrypoint: 'cli' });
const transcript = (sessionId, cwd, texts) => `${texts.map((t, i) => line(sessionId, cwd, t, Date.parse('2024-03-01T10:00:00Z') + i * 1000)).join('\n')}\n`;
const usageRow = (n) => JSON.stringify({ ts: 1_700_000_000_000 + n, account: { id: 'acc-1', email: 'a@b.c', org: null }, source: 'cli', project: 'toko', projectId: 'x', sessionId: S(1), model: 'claude-x', input: n, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: null, requests: 1, turns: 0 });

/** Writes a file with an old mtime (so it is not treated as a session being written right now). */
function put(file, content, mtime = DAY_AGO) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  utimesSync(file, mtime, mtime);
}

const servers = [];
async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function start(m, extraEnv = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      HOME: m.home,
      USERPROFILE: m.home, // os.homedir() on Windows
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: m.data,
      PROJECTS_ROOT: m.root,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: m.projects,
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      OFFICE_OPEN_DRY_RUN: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(proc);
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    proc.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  proc.stderr.resume();
  const base = `http://localhost:${port}`;
  const token = (await (await fetch(base)).text()).match(/office-token" content="([^"]+)"/)[1];
  const api = (p, body = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const upload = (body, headers = {}) =>
    fetch(`${base}/api/backup/import`, { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Office-Token': token, ...headers }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));
  async function snapshot() {
    const controller = new AbortController();
    const res = await fetch(`${base}/stream`, { signal: controller.signal });
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    return JSON.parse(text.match(/^data: (.*)$/m)[1]);
  }
  return { port, base, token, api, upload, snapshot };
}

// ---------- the two machines ----------

const cwdA = { toko: path.join(A.root, 'toko'), kasir: path.join(homeA, 'work', 'kasir'), hilang: path.join(A.root, 'hilang') };
const cwdB = { toko: path.join(B.root, 'toko'), kasir: path.join(homeB, 'work', 'kasir') };
const dirA = (name) => path.join(A.projects, encodeProjectPath(cwdA[name]));
const dirB = (name) => path.join(B.projects, encodeProjectPath(cwdB[name]));
const T = {
  s1: transcript(S(1), cwdA.toko, ['halo toko', 'lanjut', 'selesai']),
  s2: transcript(S(2), cwdA.toko, ['sesi dua', 'kedua']),
  s3: transcript(S(3), cwdA.kasir, ['halo kasir', 'bayar']),
  s5: transcript(S(5), cwdA.toko, ['sesi lima', 'aktif', 'masih']),
  s6: transcript(S(6), cwdA.hilang, ['project yang tidak ada di B']),
  s7: transcript(S(7), cwdA.toko, ['versi A', 'lanjutan A']),
};
const S3_MTIME = new Date('2024-03-02T08:09:10Z');

let a;
let b;
let zipFile;

before(async () => {
  for (const dir of [cwdA.toko, cwdA.kasir, cwdA.hilang, cwdB.toko, cwdB.kasir]) mkdirSync(dir, { recursive: true });
  // Old laptop A: three projects, subagents, memory, prompt history, checkpoints, plans, usage.
  put(path.join(dirA('toko'), `${S(1)}.jsonl`), T.s1);
  put(path.join(dirA('toko'), `${S(2)}.jsonl`), T.s2);
  put(path.join(dirA('toko'), `${S(5)}.jsonl`), T.s5);
  put(path.join(dirA('toko'), S(1), 'subagents', 'agent-x1.jsonl'), '{"type":"assistant"}\n');
  put(path.join(dirA('toko'), `${S(7)}.jsonl`), T.s7);
  put(path.join(dirA('toko'), 'memory', 'MEMORY.md'), '# memori toko\n');
  put(path.join(dirA('toko'), 'memory', 'catatan.md'), '# catatan dari A\n');
  put(path.join(dirA('kasir'), `${S(3)}.jsonl`), T.s3, S3_MTIME);
  put(path.join(dirA('hilang'), `${S(6)}.jsonl`), T.s6);
  put(path.join(A.claude, 'history.jsonl'), [JSON.stringify({ display: 'halo toko', timestamp: 1000, project: cwdA.toko }), JSON.stringify({ display: 'halo kasir', timestamp: 3000, project: cwdA.kasir })].join('\n') + '\n');
  put(path.join(A.claude, 'file-history', S(1), 'abc123@v1'), 'isi checkpoint\n');
  put(path.join(A.claude, 'plans', 'rencana.md'), '# rencana\n', new Date()); // newer than B's: still never replaces it
  put(path.join(A.claude, '.credentials.json'), '{"secret":"JANGAN-DIEKSPOR"}');
  put(path.join(A.claude, 'cache', 'x.json'), '{}');
  put(path.join(A.data, 'usage.jsonl'), `${usageRow(1)}\n${usageRow(2)}\n`);
  put(path.join(A.data, 'usage-archive', 'usage-20260101-000000.jsonl'), `${usageRow(4)}\n`);
  // HTTPS certificate + key from `tailscale cert` (src/tls.js): machine-bound secrets, never in a backup
  put(path.join(A.data, 'tls', 'office.test.crt'), 'CERT-JANGAN-DIEKSPOR');
  put(path.join(A.data, 'tls', 'office.test.key'), 'KEY-JANGAN-DIEKSPOR');

  // New laptop B: toko already has some history of its own.
  put(path.join(dirB('toko'), `${S(1)}.jsonl`), transcript(S(1), cwdA.toko, ['halo toko'])); // shorter: A's wins
  put(path.join(dirB('toko'), `${S(2)}.jsonl`), transcript(S(2), cwdA.toko, ['sesi dua', 'kedua', 'lanjutan di B'])); // longer: kept
  put(path.join(dirB('toko'), `${S(4)}.jsonl`), transcript(S(4), cwdB.toko, ['hanya di B']));
  put(path.join(dirB('toko'), `${S(5)}.jsonl`), transcript(S(5), cwdA.toko, ['sesi lima']), new Date(Date.now() + 10 * 60_000)); // being written right now
  put(path.join(dirB('toko'), `${S(7)}.jsonl`), transcript(S(7), cwdA.toko, ['versi B yang lain'])); // shorter, but not a prefix of A's
  put(path.join(dirB('toko'), 'memory', 'MEMORY.md'), '# memori toko versi B\n');
  put(path.join(B.claude, 'plans', 'rencana.md'), '# rencana versi B\n');
  put(path.join(B.data, 'tmp', 'import-123-dead.zip'), 'sisa import yang terputus'); // cleaned at start
  put(path.join(B.claude, 'history.jsonl'), `${JSON.stringify({ display: 'di B', timestamp: 2000, project: cwdB.toko })}\n`);
  put(path.join(B.data, 'usage.jsonl'), `${usageRow(1)}\n${usageRow(3)}\n`);

  a = await start(A);
  b = await start(B, { OFFICE_BACKUP_MAX_BYTES: String(LIMIT) });
});

after(async () => {
  for (const proc of servers) proc.kill();
  await sleep(500);
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(TMP, { recursive: true, force: true });
      break;
    } catch {
      await sleep(200);
    }
  }
});

// ---------- tests ----------

test('remap: home prefix moves, Claude Code folder naming, Windows case-insensitive', () => {
  const r = makeRemap('C:\\Users\\old', 'C:\\Users\\new', 'win32');
  if (process.platform === 'win32') {
    assert.equal(r.mapPath('C:\\Users\\Old\\projects\\x'), 'C:\\Users\\new\\projects\\x');
    assert.equal(r.mapFolder('C--Users-old-projects-x', 'C:\\Users\\old\\projects\\x'), 'C--Users-new-projects-x');
    assert.equal(r.mapFolder('C--Users-old-projects-y', null), 'C--Users-new-projects-y', 'no cwd: by the encoded home prefix');
    assert.equal(r.mapFolder('C--Users-older-x', null), 'C--Users-older-x', 'only a whole path segment matches');
    assert.equal(r.unmapPath('C:\\Users\\new\\projects\\x'), 'C:\\Users\\old\\projects\\x');
  }
  assert.equal(r.mapPath('D:\\work\\x'), 'D:\\work\\x', 'outside home: unchanged');
  assert.equal(encodeProjectPath('C:\\Users\\adhit\\projects\\claude-coworking'), 'C--Users-adhit-projects-claude-coworking');
  assert.ok(makeRemap('/home/same', '/home/same', 'linux').identity || process.platform === 'win32');
});

test('export: a streamed .zip with every project, history, checkpoints, plans, state and usage — no credentials', async () => {
  const fav = (await a.snapshot()).projects.find((p) => p.name === 'toko').id;
  assert.equal((await a.api(`/api/projects/${fav}/favorite`, { on: true })).status, 200);
  assert.equal((await a.api('/api/team', { names: { qa: 'Budi QA' } })).status, 200);
  assert.equal((await a.api(`/api/projects/${fav}/settings`, { mode: 'acceptEdits', effort: 'high' })).status, 200);

  const res = await fetch(`${a.base}/api/backup/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': a.token }, body: '{}' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="adhit-office-backup-\d{4}-\d{2}-\d{2}\.zip"$/);
  zipFile = path.join(TMP, 'backup.zip');
  const out = createWriteStream(zipFile);
  for await (const chunk of res.body) out.write(chunk);
  await new Promise((r) => out.end(r));

  const zip = await ZipReader.open(zipFile);
  const names = zip.entries.map((e) => e.name);
  const manifest = JSON.parse(await zip.read(zip.entries.find((e) => e.name === 'manifest.json')));
  const state = JSON.parse(await zip.read(zip.entries.find((e) => e.name === 'office/state.json')));
  await zip.close();
  const enc = encodeProjectPath(cwdA.toko);
  for (const want of [`claude/projects/${enc}/${S(1)}.jsonl`, `claude/projects/${enc}/${S(1)}/subagents/agent-x1.jsonl`, `claude/projects/${enc}/memory/MEMORY.md`, 'claude/history.jsonl', `claude/file-history/${S(1)}/abc123@v1`, 'claude/plans/rencana.md', 'office/state.json', 'office/usage.jsonl', 'office/usage-archive/usage-20260101-000000.jsonl']) {
    assert.ok(names.includes(want), `missing ${want}`);
  }
  assert.ok(!names.some((n) => /credentials|cache\//.test(n)), 'no credentials or caches');
  assert.ok(!names.some((n) => /(^|\/)tls\/|\.(crt|key)$/.test(n)), 'no HTTPS certificate or key (data/tls)');
  assert.equal(manifest.format, 'adhit-office-backup');
  assert.equal(manifest.homeDir, homeA);
  assert.equal(manifest.projects.find((p) => p.folder === enc).cwd, cwdA.toko, 'project path read from the transcript');
  assert.equal(manifest.projects.find((p) => p.folder === enc).sessions, 4);
  assert.ok(!('remote' in state), 'no paired-device hashes (nor the VAPID key, persisted.remote.vapid) in the backup');
  assert.deepEqual(state.favorites, [fav]);
});

test('import endpoints: token, content type and laptop-only checks', async () => {
  const body = readFileSync(zipFile);
  const noToken = await fetch(`${b.base}/api/backup/import`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body });
  assert.equal(noToken.status, 403);
  assert.equal((await b.upload(body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await b.upload(body, { Origin: 'https://evil.example' })).status, 403);
  const exportNoToken = await fetch(`${b.base}/api/backup/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(exportNoToken.status, 403);
  const { wifiAllows } = await import('../src/remote.js');
  assert.ok(!wifiAllows('/api/backup/export') && !wifiAllows('/api/backup/import'), 'never allowed over WiFi');
});

test('import: folders remapped to the new home, merge rules, usage and prompt history merged, sessions listed', async () => {
  const before = (await b.snapshot()).projects.map((p) => p.name);
  assert.ok(!before.includes('kasir'), 'kasir is not known on B yet');
  const { status, body: summary } = await b.upload(readFileSync(zipFile));
  assert.equal(status, 200, JSON.stringify(summary));

  // folder names follow B's home; nothing lands under A's encoded names
  assert.ok(summary.remapped.some((r) => r.from === encodeProjectPath(cwdA.toko) && r.to === encodeProjectPath(cwdB.toko)));
  assert.ok(!existsSync(path.join(B.projects, encodeProjectPath(cwdA.toko))), 'old folder name not created');
  assert.equal(summary.projects, 3);

  // sessions: S3 + S6 added, S1 continued (B's is its prefix), S2 kept (B's is longer), S5 untouched (being
  // written), S7 kept (A's is longer but does not continue B's: never replaced, no duplicate copy)
  assert.deepEqual(summary.sessions, { added: 2, updated: 1, skipped: 3 });
  assert.equal(readFileSync(path.join(dirB('toko'), `${S(7)}.jsonl`), 'utf8'), transcript(S(7), cwdA.toko, ['versi B yang lain']));
  assert.ok(summary.warnings.some((w) => /bukan lanjutan/.test(w) && w.includes(S(7))));
  assert.ok(!readdirSync(dirB('toko')).some((f) => f.startsWith(S(7)) && f !== `${S(7)}.jsonl`), 'no second copy of a transcript');
  assert.equal(readFileSync(path.join(dirB('toko'), `${S(1)}.jsonl`), 'utf8'), T.s1);
  assert.match(readFileSync(path.join(dirB('toko'), `${S(2)}.jsonl`), 'utf8'), /lanjutan di B/);
  assert.doesNotMatch(readFileSync(path.join(dirB('toko'), `${S(5)}.jsonl`), 'utf8'), /masih/, 'an active session file is never replaced');
  assert.ok(summary.warnings.some((w) => /sedang berjalan/.test(w) && w.includes(S(5))));
  assert.equal(readFileSync(path.join(dirB('kasir'), `${S(3)}.jsonl`), 'utf8'), T.s3);
  assert.equal(Math.round(statSync(path.join(dirB('kasir'), `${S(3)}.jsonl`)).mtimeMs / 1000), S3_MTIME.getTime() / 1000, 'mtime restored (session order)');
  // existing non-session files are never replaced: the backup's version goes next to them, with a warning
  assert.equal(readFileSync(path.join(dirB('toko'), 'memory', 'MEMORY.md'), 'utf8'), '# memori toko versi B\n');
  assert.equal(readFileSync(path.join(dirB('toko'), 'memory', 'MEMORY.md.from-backup'), 'utf8'), '# memori toko\n');
  assert.equal(readFileSync(path.join(B.claude, 'plans', 'rencana.md'), 'utf8'), '# rencana versi B\n', 'even when the backup claims a newer time');
  assert.equal(readFileSync(path.join(B.claude, 'plans', 'rencana.md.from-backup'), 'utf8'), '# rencana\n');
  assert.ok(summary.warnings.some((w) => /tidak ditimpa/.test(w) && w.includes('MEMORY.md')));
  // memory added to a project this machine already had is always reported
  assert.equal(readFileSync(path.join(dirB('toko'), 'memory', 'catatan.md'), 'utf8'), '# catatan dari A\n');
  assert.ok(summary.warnings.some((w) => /Memori project ditambahkan/.test(w) && w.includes('catatan.md')));
  assert.deepEqual(summary.files, { added: 3, copies: 2, skipped: 0 });
  assert.equal(readFileSync(path.join(dirB('toko'), S(1), 'subagents', 'agent-x1.jsonl'), 'utf8'), '{"type":"assistant"}\n');
  assert.equal(readFileSync(path.join(B.claude, 'file-history', S(1), 'abc123@v1'), 'utf8'), 'isi checkpoint\n');
  assert.ok(!existsSync(path.join(B.claude, '.credentials.json')));

  // prompt history: unique lines of both, by timestamp, project paths moved to B's home
  const history = readFileSync(path.join(B.claude, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(history.map((h) => h.display), ['halo toko', 'di B', 'halo kasir']);
  assert.equal(history[0].project, cwdB.toko);
  assert.equal(summary.history.added, 2);

  // usage: one shared row, one from each side plus the rotated archive (merged through the ledger)
  const usage = readFileSync(path.join(B.data, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).input);
  assert.deepEqual(usage.sort(), [1, 2, 3, 4]);
  assert.equal(summary.usage.added, 2);

  // the app lists the history right away: toko (under the root) and kasir (added as its folder exists)
  assert.deepEqual(summary.projectsAdded, [cwdB.kasir]);
  assert.ok(summary.warnings.some((w) => w.includes(path.join(homeB, 'projects', 'hilang'))), 'missing project folder reported');
  const snap = await b.snapshot();
  const toko = snap.projects.find((p) => p.name === 'toko');
  const kasir = snap.projects.find((p) => p.name === 'kasir');
  assert.ok(kasir, 'kasir listed without a restart');
  const tokoSessions = (await b.api(`/api/projects/${toko.id}/sessions`)).body.sessions.map((s) => s.id).sort();
  assert.deepEqual(tokoSessions, [S(1), S(2), S(4), S(5), S(7)]);
  const kasirSessions = (await b.api(`/api/projects/${kasir.id}/sessions`)).body.sessions;
  assert.deepEqual(kasirSessions.map((s) => [s.id, s.title]), [[S(3), 'halo kasir']]);

  // office state: the favorite follows the project to its new id; team names fill in
  assert.equal(toko.favorite, true);
  assert.equal(snap.config.teamNames.qa, 'Budi QA');
  assert.equal(summary.state.favorites, 1);
  // settings come along, the permission mode never does (a backup can't switch a project to auto-accept)
  const saved = JSON.parse(readFileSync(path.join(B.data, 'state.json'), 'utf8'));
  assert.deepEqual({ mode: saved.settings[toko.id].mode, effort: saved.settings[toko.id].effort }, { mode: 'manual', effort: 'high' });

  // restored transcripts are history, not live activity: the mirror does not replay them into the chat
  await sleep(2500);
  const chats = (await b.snapshot()).chats;
  assert.ok(!JSON.stringify(chats).includes('halo kasir'), 'imported history is not replayed as live chat');
  assert.deepEqual(readdirSync(path.join(B.data, 'tmp')), [], 'temp upload removed, and the stale one from before the start');
});

test('import again: idempotent (nothing added twice)', async () => {
  const { status, body } = await b.upload(readFileSync(zipFile));
  assert.equal(status, 200);
  assert.equal(body.sessions.added + body.sessions.updated, 0);
  assert.equal(body.files.added + body.files.copies, 0, 'a .from-backup copy already holding these bytes is not made again');
  assert.equal(body.history.added, 0);
  assert.equal(body.usage.added, 0);
  assert.equal(readFileSync(path.join(B.data, 'usage.jsonl'), 'utf8').trim().split('\n').length, 4);
});

test('uploads over the limit are refused with 413 (declared size and streamed size)', async () => {
  const declared = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: b.port, path: '/api/backup/import', method: 'POST', headers: { Host: `localhost:${b.port}`, 'Content-Type': 'application/zip', 'X-Office-Token': b.token, 'Content-Length': String(LIMIT + 1) } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.write(Buffer.alloc(1024));
  });
  assert.equal(declared, 413);

  const streamed = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: b.port, path: '/api/backup/import', method: 'POST', headers: { Host: `localhost:${b.port}`, 'Content-Type': 'application/zip', 'X-Office-Token': b.token, 'Transfer-Encoding': 'chunked' } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    // The server cuts the connection after answering; a reset before the answer was read is reported as such.
    req.on('error', (err) => (['ECONNRESET', 'EPIPE'].includes(err.code) ? resolve({ status: err.code, text: '{}' }) : reject(err)));
    const chunk = Buffer.alloc(64 * 1024);
    let sent = 0;
    const pump = () => {
      while (sent < LIMIT * 2) {
        sent += chunk.length;
        if (!req.write(chunk)) return req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
  assert.equal(streamed.status, 413);
  assert.match(JSON.parse(streamed.text).error, /terlalu besar/);
  await sleep(200);
  assert.deepEqual(readdirSync(path.join(B.data, 'tmp')), [], 'partial upload removed');
});

test('zip-slip and foreign entries: refused before anything is written', async () => {
  async function craft(entries) {
    const file = path.join(TMP, `crafted-${Math.random().toString(36).slice(2)}.zip`);
    const out = createWriteStream(file);
    const zip = new ZipWriter(out);
    await zip.add('manifest.json', Buffer.from(JSON.stringify({ format: 'adhit-office-backup', version: 1, homeDir: homeA, platform: process.platform, projects: [] })));
    for (const [name, data] of entries) await zip.add(name, Buffer.from(data));
    await zip.finish();
    await new Promise((r) => out.end(r));
    return readFileSync(file);
  }
  const evil = path.join(TMP, 'evil.txt');
  for (const name of ['claude/projects/x/../../../../evil.txt', 'claude/plans/..\\..\\..\\evil.txt', '/evil.txt', 'C:/evil.txt', 'evil.txt', 'claude/.credentials.json', 'office/../../evil.txt']) {
    const res = await b.upload(await craft([['claude/plans/ok-before.md', 'ok'], [name, 'pwned']]));
    assert.equal(res.status, 400, `${name}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, /tidak valid/);
  }
  assert.ok(!existsSync(evil), 'nothing written outside');
  assert.ok(!existsSync(path.join(B.claude, 'plans', 'ok-before.md')), 'nothing written at all from a refused archive');
  assert.equal((await b.upload(Buffer.from('bukan zip'))).status, 400);
  const empty = await b.upload(await craft([]));
  assert.equal(empty.status, 200, 'a manifest-only backup is valid (and restores nothing)');
  assert.equal(empty.body.sessions.added, 0);
});

// ---------- untrusted backups (someone else's .zip) ----------

/** A backup built by hand: manifest (+ overrides), then [name, content] entries. */
async function craftBackup(entries, manifest = {}) {
  const file = path.join(TMP, `untrusted-${Math.random().toString(36).slice(2)}.zip`);
  const out = createWriteStream(file);
  const zip = new ZipWriter(out);
  await zip.add('manifest.json', Buffer.from(JSON.stringify({ format: 'adhit-office-backup', version: 1, homeDir: homeA, platform: process.platform, projects: [], ...manifest })));
  for (const [name, data] of entries) await zip.add(name, Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)));
  await zip.finish();
  await new Promise((r) => out.end(r));
  return file;
}

test('untrusted state.json: no permission mode, no session planted to resume', async () => {
  const kasir = (await b.snapshot()).projects.find((p) => p.name === 'kasir');
  const oldId = projectIdOf(cwdA.kasir); // the id kasir had on A
  const state = { settings: { [oldId]: { mode: 'dontAsk', effort: 'high', model: 'sonnet' } }, sessions: { [oldId]: S(3) } };
  const { status, body } = await b.upload(readFileSync(await craftBackup([['office/state.json', state]])));
  assert.equal(status, 200, JSON.stringify(body));
  const saved = JSON.parse(readFileSync(path.join(B.data, 'state.json'), 'utf8'));
  assert.equal(saved.settings[kasir.id].mode, 'manual', 'the permission mode is never restored');
  assert.equal(saved.settings[kasir.id].effort, 'high', 'validated model/effort/team still are');
  assert.equal(saved.sessions[kasir.id], undefined, 'no session is set to continue with the next prompt');
  assert.equal((await b.snapshot()).statuses[kasir.id]?.sessionId ?? null, null);
});

test('untrusted folders: roots, added folders and project paths outside this home are skipped with a warning', async () => {
  const outside = path.join(TMP, 'outside');
  const okRoot = path.join(homeA, 'work'); // maps to B's home/work, which exists
  mkdirSync(outside, { recursive: true });
  const folder = encodeProjectPath(outside);
  const file = await craftBackup(
    [
      ['office/state.json', { roots: [outside, homeA, path.parse(TMP).root, '\\server\share', okRoot], custom: [outside, homeA] }],
      [`claude/projects/${folder}/${S(8)}.jsonl`, transcript(S(8), outside, ['di luar home'])],
    ],
    { projects: [{ folder, cwd: outside }] },
  );
  const { status, body } = await b.upload(readFileSync(file));
  assert.equal(status, 200, JSON.stringify(body));
  const saved = JSON.parse(readFileSync(path.join(B.data, 'state.json'), 'utf8'));
  const norm = (p) => path.resolve(p).toLowerCase();
  const kept = [...saved.roots, ...saved.custom].map(norm);
  for (const bad of [outside, homeB, path.parse(TMP).root]) assert.ok(!kept.includes(norm(bad)), `${bad} not added`);
  assert.ok(kept.includes(norm(path.join(homeB, 'work'))), 'a root below this home (after remap) is fine');
  assert.equal(body.state.roots, 1);
  assert.deepEqual(body.projectsAdded, []);
  assert.ok(body.warnings.filter((w) => /dilewati \(di luar folder home/.test(w)).length >= 4, body.warnings.join('\n'));
  assert.ok(!(await b.snapshot()).projects.some((p) => p.name === 'outside'), 'the outside folder is not listed as a project');
});

test('untrusted sizes: usage/history above the merge limit are skipped with a warning', async () => {
  const { restoreBackup } = await import('../src/backup.js');
  const root = path.join(TMP, 'inproc');
  const file = await craftBackup([
    ['claude/history.jsonl', `${JSON.stringify({ display: 'x'.repeat(500), timestamp: 1 })}\n`],
    ['office/usage.jsonl', `${usageRow(9)}\n`.repeat(5)],
  ]);
  const ledger = { importRows: () => assert.fail('an oversized usage file is not read') };
  const { summary } = await restoreBackup(file, { locations: { projectsDir: path.join(root, 'projects'), claudeDir: root }, homeDir: root, ledger, maxMergeBytes: 100 });
  assert.equal(summary.warnings.filter((w) => /terlalu besar untuk digabung/.test(w)).length, 2);
  assert.ok(!existsSync(path.join(root, 'history.jsonl')));
});
