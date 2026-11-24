// 🛰 Mission Control: the chat timeline of the current mission (since the last prompt) → stations, comms log,
// timeline and telemetry (public/js/core/mission-feed.js). Pure logic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missionFeed } from '../public/js/core/mission-feed.js';

const T0 = 1_000_000;
const at = (s) => T0 + s * 1000;

const chat = [
  { id: 'old', kind: 'user', text: 'misi lama', ts: at(-600) },
  { id: 'oldt', kind: 'tool', role: 'qa', tool: 'Bash', text: 'x', status: 'ok', input: { command: 'npm test' }, ts: at(-590) },
  { id: 'oldr', kind: 'result', ok: true, meta: { costUsd: 9, tokensOut: 999 }, ts: at(-580) },
  { id: 'u1', kind: 'user', text: 'fitur login\ndan validasi', ts: at(0) },
  { id: 'd1', kind: 'delegate', role: 'ba', from: 'claude', text: 'Analisis alur', status: 'ok', toolUseId: 'tu1', ts: at(30) },
  { id: 's1', kind: 'tool', role: 'ba', tool: 'Read', text: 'Membaca', status: 'ok', sub: true, parentToolUseId: 'tu1', input: { file: 'docs/a.md' }, ts: at(60) },
  { id: 'd2', kind: 'delegate', role: 'backend', from: 'claude', text: 'API auth', status: 'running', toolUseId: 'tu2', ts: at(130) },
  { id: 't2', kind: 'tool', role: 'backend', tool: 'Edit', text: 'Mengedit', status: 'running', input: { file: 'src/auth.js' }, ts: at(140) },
  { id: 'p1', kind: 'approval', role: 'dba', text: 'npx prisma migrate dev', status: 'pending', ts: at(300) },
  { id: 't3', kind: 'tool', role: 'qa', tool: 'Bash', text: 'Test', status: 'fail', input: { command: 'npm test' }, output: 'fail 1', ts: at(400) },
  { id: 'r1', kind: 'result', ok: true, meta: { costUsd: 0.25, tokensOut: 1200 }, ts: at(420) },
  { id: 'r2', kind: 'result', ok: true, meta: { costUsd: 0.17, tokensOut: 800 }, ts: at(440) },
];
const events = [{ kind: 'tests', role: 'qa', passed: 41, failed: 1 }];

test('the mission starts at the latest prompt; older work is not counted', () => {
  const m = missionFeed(chat, { now: at(460), coordinator: 'pm', team: ['claude', 'pm', 'ba', 'backend', 'dba', 'qa', 'devops'], events });
  assert.equal(m.start, at(0));
  assert.equal(m.prompt, 'fitur login');
  assert.equal(m.elapsedMs, 460_000);
  assert.deepEqual(m.telemetry, { steps: 3, delegations: 2, costUsd: 0.42, tokensOut: 2000 });
  assert.equal(m.phase, 'hold', 'an approval is waiting');
});

test('stations: GO while working, HOLD on an approval, FAIL on a failed step, DONE after work, STBY without work', () => {
  const m = missionFeed(chat, { now: at(460), coordinator: 'pm', team: ['claude', 'pm', 'ba', 'backend', 'dba', 'qa', 'devops'], events });
  const by = Object.fromEntries(m.stations.map((s) => [s.role, s]));
  assert.equal(by.backend.state, 'go');
  assert.equal(by.dba.state, 'hold');
  assert.equal(by.qa.state, 'fail');
  assert.equal(by.ba.state, 'done');
  assert.equal(by.devops.state, 'stby');
  assert.deepEqual(by.qa.tests, { passed: 41, failed: 1 });
  assert.equal(by.backend.what, '✎ edit auth.js');
  assert.equal(by.dba.what, '⚠ ACCESS REQUEST ▸ npx prisma migrate dev');
  // HOLD, GO, FAIL, DONE, STBY; the same state in team order. The Lead is the radar's centre, not a station
  assert.deepEqual(m.stations.map((s) => s.role), ['dba', 'backend', 'qa', 'pm', 'ba', 'devops']);
  assert.equal(by.backend.spark.length, 8);
  assert.ok(by.backend.spark.some((n) => n > 0) && by.devops.spark.every((n) => n === 0));
});

test('comms log: prompt, briefs and hand-outs (from the PM), reports, holds and failures, in time order', () => {
  const m = missionFeed(chat, { now: at(460), coordinator: 'pm', team: ['claude', 'pm', 'ba', 'backend', 'dba', 'qa'], events });
  assert.deepEqual(
    m.log.map((l) => `${l.t / 1000}|${l.text}|${l.tone}`),
    [
      '0|LEAD ← kamu: fitur login|info',
      '30|PM → ba: Analisis alur|info',
      '64|ba → PM: ✔ laporan|ok',
      '130|PM → backend: API auth|info',
      '300|dba: ⚠ HOLD npx prisma migrate dev|warn',
      '400|qa: ✖ gagal (npm test)|bad',
    ],
  );
  assert.deepEqual(m.holds, [{ role: 'dba', text: 'npx prisma migrate dev' }]);
});

test('timeline: per role segments from its rows, a running one reaching now, a delegation spanning its subagent work', () => {
  const m = missionFeed(chat, { now: at(460), coordinator: 'pm', team: ['claude', 'pm', 'ba', 'backend', 'dba', 'qa'], events });
  const lane = Object.fromEntries(m.timeline.map((l) => [l.role, l.segs.map(([a, b]) => [(a - T0) / 1000, (b - T0) / 1000])]));
  assert.deepEqual(lane.backend, [[130, 460]], 'running: until now (the edit merges into its delegation)');
  assert.deepEqual(lane.ba, [[30, 64]], 'the delegation lasts until its last subagent row (+ a short tail)');
  assert.deepEqual(lane.dba, [[300, 460]], 'waiting for approval: until now');
  assert.deepEqual(lane.qa, [[400, 404]]);
  assert.equal(lane.devops, undefined);
});

test('no mission yet: an empty but well-formed feed', () => {
  const m = missionFeed([], { now: at(0), team: ['claude', 'pm', 'qa'] });
  assert.equal(m.phase, 'idle');
  assert.equal(m.prompt, '');
  assert.deepEqual(m.log, []);
  assert.deepEqual(m.stations.map((s) => s.state), ['stby', 'stby']);
  assert.deepEqual(m.telemetry, { steps: 0, delegations: 0, costUsd: null, tokensOut: 0 });
});
