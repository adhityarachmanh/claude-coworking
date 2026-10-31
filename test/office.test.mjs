// Office scene logic (no canvas needed): who counts as "working" while the chat is still loading.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Scene } from '../public/js/office/scene.js';

/** Runs `fn` with performance.now() frozen at `ms`, so busy timers can be checked deterministically. */
function at(ms, fn) {
  const real = performance.now;
  performance.now = () => ms;
  try {
    return fn();
  } finally {
    performance.now = real;
  }
}

test('a long-running tool keeps its role busy until it ends, not just for 9 s', () => {
  const scene = at(0, () => new Scene());
  const qa = scene.people.qa;
  at(1_000, () => scene.handle({ kind: 'tool_start', role: 'qa', label: 'npm test', tool: 'Bash' }));
  assert.ok(qa.isBusy(5_000), 'busy right after starting');
  assert.ok(qa.isBusy(60_000), 'still busy a minute later: the tool has not finished');
  at(60_000, () => scene.handle({ kind: 'tool_end', role: 'qa', label: 'npm test', tool: 'Bash' }));
  assert.ok(qa.isBusy(62_000), 'short wind-down after the tool ends');
  assert.ok(!qa.isBusy(70_000), 'idle again once done');
});

test('parallel tools: busy until the last one ends; a failed tool counts as ended', () => {
  const scene = at(0, () => new Scene());
  const be = scene.people.backend;
  at(0, () => {
    scene.handle({ kind: 'tool_start', role: 'backend', label: 'a', tool: 'Bash' });
    scene.handle({ kind: 'tool_start', role: 'backend', label: 'b', tool: 'Bash' });
  });
  at(30_000, () => scene.handle({ kind: 'tool_fail', role: 'backend', label: 'a', tool: 'Bash' }));
  assert.ok(be.isBusy(50_000), 'one tool still running');
  at(50_000, () => scene.handle({ kind: 'tool_end', role: 'backend', label: 'b', tool: 'Bash' }));
  assert.ok(!be.isBusy(60_000));
  at(60_000, () => scene.handle({ kind: 'tool_end', role: 'backend', label: 'extra', tool: 'Bash' }));
  assert.equal(be.openTools, 0, 'an unmatched end never goes negative');
});

test('end of turn / stop clears tools that never reported back', () => {
  const scene = at(0, () => new Scene());
  at(0, () => scene.handle({ kind: 'tool_start', role: 'devops', label: 'build', tool: 'Bash' }));
  at(20_000, () => scene.handle({ kind: 'stop', role: 'claude', label: 'Selesai', activeRoles: [] }));
  assert.ok(!scene.people.devops.isBusy(40_000));
  at(40_000, () => scene.handle({ kind: 'tool_start', role: 'devops', label: 'build', tool: 'Bash' }));
  at(41_000, () => scene.handle({ kind: 'halt', role: 'claude' }));
  assert.ok(!scene.people.devops.isBusy(50_000));
});

test('replayed history (not live) does not leave anyone typing forever', () => {
  const scene = at(0, () => new Scene());
  at(0, () => scene.handle({ kind: 'tool_start', role: 'qa', label: 'npm test', tool: 'Bash' }, false));
  assert.ok(!scene.people.qa.isBusy(30_000));
});

test('thinking keeps the role at work and sends it back to its desk', () => {
  const scene = at(0, () => new Scene());
  const lead = scene.people.claude;
  at(0, () => lead.go([{ type: 'walk', x: lead.seat.x + 40, y: lead.seat.y + 40 }]));
  at(1_000, () => scene.handle({ kind: 'think', role: 'claude' }));
  assert.ok(lead.isBusy(3_000));
  assert.ok(lead.headingHome() || lead.seated, 'walks back to the desk');
});
