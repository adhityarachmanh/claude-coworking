// ⏪ Rewind for OpenCode, the `opencode api` side (src/session-admin.js) against the fake (test-support/fake-acp.mjs,
// FAKE_ACP_STORE): ids checked before anything runs, the preview's file list from the snapshots across pages,
// OpenCode's own refusals (busy → 409, gone → 404). The full flow (routes, chat, 409 while a turn runs) is in
// test/opencode.test.mjs. No server, no real OpenCode.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openCodeRevertPlan, openCodeRewindPoints, revertOpenCodeSession, validMessageId } from '../src/session-admin.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-oc-rewind-'));
const STORE = path.join(TMP, 'store');
const PROJECT = path.join(TMP, 'proj');
mkdirSync(STORE);
mkdirSync(PROJECT);
process.env.FAKE_ACP_STORE = STORE; // the fake `opencode api` inherits it
const opencode = { command: process.execPath, args: [path.join(APP, 'test-support', 'fake-acp.mjs')] };
const SID = 'ses_rewindunit1';

/** A session of `turns` prompts; turn 1 wrote a.txt (absent before), the last turn rewrote it. */
function seed(turns) {
  const messages = [];
  for (let i = 1; i <= turns; i++) {
    messages.push({ id: `msg_u${i}`, type: 'user', text: `prompt ${i}`, time: { created: i } });
    const before = i === 1 ? { 'a.txt': null } : i === turns ? { 'a.txt': 'versi 1\n' } : {};
    messages.push({ id: `msg_a${i}`, type: 'assistant', snapshot: { start: 'snap0', files: Object.keys(before) }, before });
  }
  writeFileSync(path.join(STORE, `${SID}.json`), JSON.stringify({ dir: PROJECT, messages }));
  writeFileSync(path.join(PROJECT, 'a.txt'), 'versi terakhir\n');
}

after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

test('ids are checked before OpenCode is asked anything', async () => {
  assert.equal(validMessageId('msg_1a28268100029fmBv5U4VkPmVe_13'), true, 'a forked session\'s ids have "_"');
  for (const bad of ['', 'msg_', 'ses_x', 'msg_a b', 'msg_../x', `msg_${'a'.repeat(101)}`]) assert.equal(validMessageId(bad), false, bad);
  const none = { command: path.join(TMP, 'no-such-opencode'), args: [] }; // would fail if spawned
  await assert.rejects(openCodeRewindPoints({ opencode: none, sessionId: '../ses' }), { status: 400 });
  await assert.rejects(openCodeRevertPlan({ opencode: none, sessionId: SID, messageId: 'msg_a;b' }), { status: 400 });
  await assert.rejects(revertOpenCodeSession({ opencode: none, sessionId: 'ses_ok', messageId: 'x' }), { status: 400 });
});

test('points newest first; the preview lists the files of the turns after the prompt, also beyond the first page', async () => {
  seed(150); // 300 messages: the oldest prompt is on the second page of 200
  const points = await openCodeRewindPoints({ opencode, sessionId: SID });
  assert.equal(points.length, 80, 'as many as Claude\'s list');
  assert.deepEqual(points.slice(0, 2).map((p) => [p.uuid, p.text]), [['msg_u150', 'prompt 150'], ['msg_u149', 'prompt 149']]);
  assert.deepEqual(await openCodeRevertPlan({ opencode, sessionId: SID, messageId: 'msg_u150' }), { found: true, files: ['a.txt'] });
  assert.deepEqual(await openCodeRevertPlan({ opencode, sessionId: SID, messageId: 'msg_u1' }), { found: true, files: ['a.txt'] }, 'found on page 2');
  assert.deepEqual(await openCodeRevertPlan({ opencode, sessionId: SID, messageId: 'msg_nope' }), { found: false, files: ['a.txt'] });
  await assert.rejects(openCodeRevertPlan({ opencode, sessionId: SID, messageId: 'msg_a3' }), { status: 400 }, 'only your prompts');
});

test('revert: files back from the earliest snapshot, the rest of the conversation deleted; OpenCode refusals keep their meaning', async () => {
  seed(3);
  const res = await revertOpenCodeSession({ opencode, projectPath: PROJECT, sessionId: SID, messageId: 'msg_u2', files: true });
  assert.deepEqual(res, { files: ['a.txt'], committed: true });
  assert.equal(readFileSync(path.join(PROJECT, 'a.txt'), 'utf8'), 'versi 1\n', 'as before prompt 2');
  assert.deepEqual((await openCodeRewindPoints({ opencode, sessionId: SID })).map((p) => p.uuid), ['msg_u1']);

  seed(3);
  await revertOpenCodeSession({ opencode, projectPath: PROJECT, sessionId: SID, messageId: 'msg_u1', files: false });
  assert.equal(readFileSync(path.join(PROJECT, 'a.txt'), 'utf8'), 'versi terakhir\n', 'conversation only: files untouched');
  assert.deepEqual(await openCodeRewindPoints({ opencode, sessionId: SID }), []);

  seed(2);
  await assert.rejects(revertOpenCodeSession({ opencode, projectPath: PROJECT, sessionId: SID, messageId: 'msg_gone', files: true }), { status: 404 });
  process.env.FAKE_ACP_REVERT_BUSY = '1';
  try {
    await assert.rejects(revertOpenCodeSession({ opencode, projectPath: PROJECT, sessionId: SID, messageId: 'msg_u1', files: true }), { status: 409 });
  } finally {
    delete process.env.FAKE_ACP_REVERT_BUSY;
  }
  assert.ok(existsSync(path.join(PROJECT, 'a.txt')), 'a refused revert changes nothing');
});
