// Task monitor detail (src/task-detail.js): a subagent's transcript summarised into short, ordered steps,
// read only inside the Claude projects folder, within size limits. Fake transcripts in a throwaway folder.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-task-detail-'));
const ROOT = path.join(TMP, 'claude-projects');
const PROJECT = path.join(TMP, 'projects', 'toko');
const SESSION = randomUUID();
let mod;

const dirOf = () => path.join(ROOT, path.resolve(PROJECT).replace(/[^a-zA-Z0-9]/g, '-'), SESSION, 'subagents');
const line = (type, content, ts = '2026-11-01T10:00:00.000Z') => JSON.stringify({ type, isSidechain: true, timestamp: ts, message: { role: type, content } });
const use = (id, name, input) => line('assistant', [{ type: 'tool_use', id, name, input }]);
const res = (id, isError = false) => line('user', [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }]);

function writeAgent(agentId, lines, meta) {
  mkdirSync(dirOf(), { recursive: true });
  const file = path.join(dirOf(), `agent-${agentId}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  if (meta) writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta));
  return file;
}

before(async () => {
  process.env.CLAUDE_PROJECTS_DIR = ROOT; // read when transcripts.js loads
  mod = await import('../src/task-detail.js');
});
after(() => rmSync(TMP, { recursive: true, force: true }));

test('agent detail: ordered short steps with ok/error, the final report, the prompt — never the raw input', () => {
  const big = 'x'.repeat(500_000);
  writeAgent(
    'a1',
    [
      line('user', 'Jalankan tes checkout.'),
      line('assistant', [{ type: 'thinking', thinking: 'rahasia' }, { type: 'text', text: 'Mulai baca kode.' }], '2026-11-01T10:00:01.000Z'),
      use('t1', 'Read', { file_path: 'src/checkout.ts' }),
      res('t1'),
      use('t2', 'Bash', { command: 'npm test -- checkout' }),
      res('t2', true),
      use('t3', 'Write', { file_path: 'src/big.txt', content: big }),
      '{ rusak',
      use('t4', 'SubagentHandback', { message: 'Semua tes lulus.' }),
    ],
    { agentType: 'qa', description: 'Uji checkout', toolUseId: 'toolu_A' },
  );
  const d = mod.taskDetail(PROJECT, SESSION, { id: 'task-x', kind: 'agent', status: 'running', toolUseId: 'toolu_A' });
  assert.equal(d.found, true);
  assert.equal(d.agentId, 'a1');
  assert.equal(d.agentType, 'qa');
  assert.equal(d.prompt, 'Jalankan tes checkout.');
  assert.deepEqual(
    d.steps.map((s) => [s.type, s.label ?? s.text, s.status]),
    [
      ['text', 'Mulai baca kode.', undefined],
      ['tool', 'Membaca checkout.ts', 'ok'],
      ['tool', 'Menjalankan test', 'error'],
      ['tool', 'Menulis big.txt', 'running'],
    ],
  );
  assert.equal(d.steps[2].detail, 'npm test -- checkout');
  assert.equal(d.steps[0].ts, Date.parse('2026-11-01T10:00:01.000Z'));
  assert.equal(d.result, 'Semua tes lulus.');
  assert.equal(d.truncated, false);
  assert.ok(JSON.stringify(d).length < 5000, 'no file content in the answer');
  assert.ok(!JSON.stringify(d).includes('rahasia'), 'thinking is not shown');
});

test('limits: at most maxSteps steps and maxBytes read from the end', () => {
  const lines = [line('user', 'Banyak langkah.')];
  for (let i = 0; i < 500; i++) lines.push(use(`s${i}`, 'Read', { file_path: `f${i}.js` }), res(`s${i}`));
  writeAgent('a2', lines, { agentType: 'qa', toolUseId: 'toolu_B' });
  const task = { id: 'tb', kind: 'agent', status: 'running', toolUseId: 'toolu_B' };
  const d = mod.taskDetail(PROJECT, SESSION, task);
  assert.equal(d.steps.length, mod.DETAIL_MAX_STEPS);
  assert.equal(d.truncated, true);
  assert.equal(d.steps.at(-1).label, 'Membaca f499.js', 'the newest steps are kept');
  const small = mod.taskDetail(PROJECT, SESSION, task, { maxBytes: 4096 });
  assert.ok(small.steps.length > 0 && small.steps.length < 30, `only the tail is read (${small.steps.length})`);
  assert.equal(small.steps.at(-1).label, 'Membaca f499.js');
  assert.equal(small.truncated, true);
});

test('limits: the answer stays under DETAIL_MAX_ANSWER even with long messages', () => {
  const lines = [line('user', 'Panjang.')];
  for (let i = 0; i < 400; i++) lines.push(line('assistant', [{ type: 'text', text: `pesan ${i} ${'y'.repeat(3000)}` }]), use(`p${i}`, 'Bash', { command: `echo ${'z'.repeat(5000)}` }));
  writeAgent('a4', lines, { agentType: 'qa', toolUseId: 'toolu_C' });
  const d = mod.taskDetail(PROJECT, SESSION, { id: 'tc', kind: 'agent', status: 'running', toolUseId: 'toolu_C' });
  assert.ok(JSON.stringify(d).length <= mod.DETAIL_MAX_ANSWER, `${JSON.stringify(d).length} bytes`);
  assert.ok(d.steps.length > 20 && d.truncated);
  assert.equal(d.steps.at(-1).label, 'Menjalankan echo', 'the label never carries the 5000-char argument');
});

test('finding the transcript: meta toolUseId, then the agent id, then description + type', () => {
  writeAgent('a3', [line('user', 'Tiga.'), line('assistant', [{ type: 'text', text: 'Selesai tanpa laporan.' }])], { agentType: 'backend', description: 'Perbaiki API' });
  assert.equal(mod.taskDetail(PROJECT, SESSION, { id: 'a3', kind: 'agent', status: 'running' }).agentId, 'a3', 'by agent id');
  const byDesc = mod.taskDetail(PROJECT, SESSION, { id: 'zz', kind: 'agent', status: 'completed', description: 'Perbaiki API', agent: 'backend' });
  assert.equal(byDesc.agentId, 'a3', 'by description');
  assert.equal(byDesc.result, 'Selesai tanpa laporan.', 'ended without a report: its last message');
  assert.equal(mod.taskDetail(PROJECT, SESSION, { id: 'zz', kind: 'agent', description: 'Perbaiki API', agent: 'qa' }).found, false, 'type must match');
  assert.equal(mod.taskDetail(PROJECT, SESSION, { id: 'nope', kind: 'agent', status: 'running' }).found, false);
});

test('shell tasks: their command, no transcript read', () => {
  const d = mod.taskDetail(PROJECT, SESSION, { id: 'b1', kind: 'shell', status: 'running', command: 'npm run dev' });
  assert.deepEqual(d, { taskId: 'b1', kind: 'shell', status: 'running', command: 'npm run dev', steps: [], truncated: false, result: null });
});

test('paths: never outside the projects folder, whatever the ids look like', () => {
  // A transcript outside the session folder that a crafted id could point at.
  writeFileSync(path.join(ROOT, 'agent-evil.jsonl'), `${line('assistant', [{ type: 'text', text: 'BOCOR' }])}\n`);
  assert.equal(mod.subagentsDir(PROJECT, '../../..'), null, 'session id must be a uuid');
  assert.equal(mod.subagentsDir(PROJECT, `${SESSION}/../..`), null);
  assert.equal(mod.taskDetail(PROJECT, '..', { id: 'a1', kind: 'agent', toolUseId: 'toolu_A' }).found, false);
  for (const id of ['../../agent-evil', '..\\..\\evil', '/etc/passwd', 'a1/../../evil']) {
    const d = mod.taskDetail(PROJECT, SESSION, { id, kind: 'agent', description: 'x' });
    assert.equal(d.found, false, id);
    assert.ok(!JSON.stringify(d).includes('BOCOR'), id);
  }
  // A folder named like a transcript is skipped, not read.
  mkdirSync(path.join(dirOf(), 'agent-dir.jsonl'), { recursive: true });
  assert.equal(mod.taskDetail(PROJECT, SESSION, { id: 'dir', kind: 'agent' }).found, false);
  // Outside the configured root: refused even for a valid session id.
  assert.equal(mod.subagentsDir(PROJECT, SESSION, path.join(TMP, 'elsewhere')), null);
});
