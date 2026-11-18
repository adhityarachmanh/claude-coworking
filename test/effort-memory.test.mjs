// Effort refusals a provider reported for a model (src/effort-memory.js): they must survive a restart so the app
// never sends the same refused level again. Pure file logic: no server, no OpenCode.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { EFFORT_MEMORY_FILE, readEffortRefusals, refusalsFor, rememberEffortRefusal } from '../src/effort-memory.js';

const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-effort-memory-'));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('effort memory: a refusal is written per model and read back as a Set', () => {
  const dir = tmp();
  assert.deepEqual([...refusalsFor(dir, 'river/glm-5.3')], [], 'nothing remembered yet');
  assert.equal(rememberEffortRefusal(dir, 'river/glm-5.3', 'medium'), true);
  const saved = JSON.parse(readFileSync(path.join(dir, EFFORT_MEMORY_FILE), 'utf8'));
  assert.deepEqual(saved, { 'river/glm-5.3': ['medium'] });
  assert.deepEqual([...refusalsFor(dir, 'river/glm-5.3')], ['medium']);
  assert.deepEqual([...refusalsFor(dir, 'opencode-go/deepseek-v4.1-flash')], [], 'another model is untouched');
});

test('effort memory: the same level is stored once and several levels accumulate', () => {
  const dir = tmp();
  assert.equal(rememberEffortRefusal(dir, 'a/b', 'medium'), true);
  assert.equal(rememberEffortRefusal(dir, 'a/b', 'medium'), false, 'already known: no second write');
  assert.equal(rememberEffortRefusal(dir, 'a/b', 'low'), true);
  assert.deepEqual(refusalsFor(dir, 'a/b'), new Set(['medium', 'low']));
});

test('effort memory: a missing, corrupt or junk file never throws and never invents levels', () => {
  const dir = tmp();
  assert.deepEqual(readEffortRefusals(dir), {}, 'no file yet');
  assert.deepEqual(readEffortRefusals(path.join(dir, 'no-such-dir')), {}, 'no folder either');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, EFFORT_MEMORY_FILE), '{ not json');
  assert.deepEqual(readEffortRefusals(dir), {}, 'a torn file reads as empty');
  writeFileSync(path.join(dir, EFFORT_MEMORY_FILE), JSON.stringify({ ok: ['medium'], bad: 'medium', '': ['low'], 'x/y': ['med ium', 42, 'low'] }));
  assert.deepEqual(readEffortRefusals(dir), { ok: ['medium'], 'x/y': ['low'] }, 'only usable model/level pairs survive');
});

test('effort memory: junk input is ignored and a model keeps a bounded list', () => {
  const dir = tmp();
  assert.equal(rememberEffortRefusal(dir, '', 'low'), false, 'no model, nothing to remember');
  assert.equal(rememberEffortRefusal(dir, 'a/b', ''), false, 'no level, nothing to remember');
  assert.equal(rememberEffortRefusal(dir, 'a/b', 'low; rm -rf'), false, 'a name-shaped level only');
  for (let i = 0; i < 20; i++) rememberEffortRefusal(dir, 'a/b', `l${i}`);
  const levels = [...refusalsFor(dir, 'a/b')];
  assert.equal(levels.length, 12, `bounded (${levels.length})`);
  assert.ok(levels.includes('l19'), 'the newest levels are kept');
});
