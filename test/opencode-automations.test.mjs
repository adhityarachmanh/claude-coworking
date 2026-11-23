// ⏰ OpenCode automations: trigger/action validation and the list/create/pause/resume/delete wrappers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanAction, cleanTrigger, createAutomation, deleteAutomation, listAutomations, pauseAutomation } from '../src/opencode-automations.js';

const info = {
  id: 'aut_1',
  name: 'Cek build',
  projectID: 'prj_1',
  directory: '/work/app',
  trigger: { type: 'every', every: '1 hour' },
  action: { type: 'prompt', prompt: 'Cek build', to: { session: 'ses_1' } },
  status: 'active',
  runCount: 2,
  time: { created: 1, updated: 2 },
  state: { secret: 'jangan bocor' },
  lastOutput: 'ok',
};
const fake = (payload) => ({
  command: process.execPath,
  args: ['-e', `const op=process.argv[2]; console.log(${JSON.stringify(JSON.stringify(payload))}.replace('OP', op));`, '--'],
});

test('automation: list tidak membocorkan state, create memakai payload tervalidasi', async () => {
  const rows = await listAutomations(fake({ data: [info, { id: 'x' }] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Cek build');
  assert.equal('state' in rows[0], false);
  assert.equal(rows[0].action, 'prompt');
  await assert.rejects(createAutomation(fake({ data: info }), { name: ' ', trigger: { type: 'every', every: '1 hour' }, action: { type: 'prompt', prompt: 'x' } }), (e) => e.status === 400);
  const created = await createAutomation(fake({ data: info }), { name: 'Cek', directory: '/work/app', trigger: { type: 'cron', cron: '0 9 * * 1-5' }, action: { type: 'prompt', prompt: 'Cek build' } });
  assert.equal(created.id, 'aut_1');
});

test('automation: trigger/action divalidasi, id aksi aneh ditolak', () => {
  assert.deepEqual(cleanTrigger({ type: 'at', at: 'in 10 minutes' }), { type: 'at', at: 'in 10 minutes' });
  assert.deepEqual(cleanTrigger({ type: 'event', server: 'ci', event: 'build.failed', args: { branch: 'main' } }), { type: 'event', server: 'ci', event: 'build.failed', args: { branch: 'main' } });
  assert.deepEqual(cleanAction({ type: 'code', code: 'return { done: true }' }), { type: 'code', code: 'return { done: true }' });
  for (const bad of [{ type: 'later' }, { type: 'cron' }, { type: 'event', server: 'ci' }]) assert.throws(() => cleanTrigger(bad), (e) => e.status === 400);
  assert.throws(() => cleanAction({ type: 'prompt', prompt: 'x'.repeat(4001) }), (e) => e.status === 400);
  assert.throws(() => cleanAction({ type: 'code', code: '' }), (e) => e.status === 400);
  assert.deepEqual(cleanAction({ type: 'prompt', prompt: ' x ', to: { subagent: 'qa' } }), { type: 'prompt', prompt: 'x', to: { subagent: 'qa' } });
});

test('automation: pause/resume/delete dan id wajib aut_', async () => {
  const row = await pauseAutomation(fake({ data: info }), 'aut_1');
  assert.equal(row.status, 'active');
  assert.deepEqual(await deleteAutomation(fake({}), 'aut_1'), { removed: true });
  await assert.rejects(pauseAutomation(fake({}), '../x'), (e) => e.status === 400);
});
