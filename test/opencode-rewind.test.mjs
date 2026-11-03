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
import { openCodeRevertPlan, openCodeRewindPoints, revertOpenCodeSession, rewindDeadline, validMessageId } from '../src/session-admin.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-oc-rewind-'));
const STORE = path.join(TMP, 'store');
const PROJECT = path.join(TMP, 'proj');
mkdirSync(STORE);
mkdirSync(PROJECT);
process.env.FAKE_ACP_STORE = STORE; // the fake `opencode api` inherits it
const opencode = { command: process.execPath, args: [path.join(APP, 'test-support', 'fake-acp.mjs')] };
const SID = 'ses_rewindunit1';

/** A session of `turns` prompts, each answered by `steps` assistant messages; turn 1 wrote a.txt (absent before), the last turn rewrote it. */
function seed(turns, steps = 1) {
  const messages = [];
  for (let i = 1; i <= turns; i++) {
    messages.push({ id: `msg_u${i}`, type: 'user', text: `prompt ${i}`, time: { created: i } });
    const before = i === 1 ? { 'a.txt': null } : i === turns ? { 'a.txt': 'versi 1\n' } : {};
    for (let s = 0; s < steps; s++) messages.push({ id: `msg_a${i}_${s}`, type: 'assistant', snapshot: { start: 'snap0', files: s ? [] : Object.keys(before) }, before: s ? {} : before });
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

test('points newest first; the preview scans exactly as far back as the 80 rewind points (across pages)', async () => {
  seed(150); // 300 messages: the 80th newest prompt (msg_u71) is on the first page of 200, msg_u1 on the second
  const points = await openCodeRewindPoints({ opencode, sessionId: SID });
  assert.equal(points.length, 80, 'as many as Claude\'s list');
  assert.deepEqual(points.slice(0, 2).map((p) => [p.uuid, p.text]), [['msg_u150', 'prompt 150'], ['msg_u149', 'prompt 149']]);
  assert.equal(points.at(-1).uuid, 'msg_u71');
  assert.deepEqual(await openCodeRevertPlan({ opencode, sessionId: SID, messageId: 'msg_u150' }), { found: true, files: ['a.txt'] });
  assert.deepEqual(await openCodeRevertPlan({ opencode, sessionId: SID, messageId: 'msg_u71' }), { found: true, files: ['a.txt'] }, 'the oldest rewind point is known');
  assert.deepEqual(await openCodeRevertPlan({ opencode, sessionId: SID, messageId: 'msg_u70' }), { found: false, files: ['a.txt'] }, 'past the points: unknown');
  assert.deepEqual(await openCodeRevertPlan({ opencode, sessionId: SID, messageId: 'msg_nope' }), { found: false, files: ['a.txt'] });
  await assert.rejects(openCodeRevertPlan({ opencode, sessionId: SID, messageId: 'msg_a149_0' }), { status: 400 }, 'only your prompts');

  seed(60, 20); // 60 prompts of 20 steps: the oldest point (msg_u1) lies past 1200 messages (the old 5-page limit)
  assert.deepEqual(await openCodeRevertPlan({ opencode, sessionId: SID, messageId: 'msg_u1' }), { found: true, files: ['a.txt'] }, 'no fixed page limit');
});

test('cursor: OpenCode 2.2.5 writes base64url JSON { id, order, direction } without padding; the deadline bounds every scan', async () => {
  const real = Buffer.from(JSON.stringify({ id: 'msg_1a28268100029fmBv5U4VkPmVe', order: 'desc', direction: 'next' })).toString('base64url');
  assert.match(real, /^[A-Za-z0-9_-]+$/);
  seed(3);
  const out = { left: () => 500 }; // less than a second left
  await assert.rejects(openCodeRewindPoints({ opencode, sessionId: SID, budget: out }), { status: 504 });
  await assert.rejects(openCodeRevertPlan({ opencode, sessionId: SID, messageId: 'msg_u1', budget: out }), { status: 504 });
  await assert.rejects(revertOpenCodeSession({ opencode, projectPath: PROJECT, sessionId: SID, messageId: 'msg_u1', files: true, budget: { left: () => 10_000 } }), { status: 504 }, 'the stage keeps time back for commit / clear');
  assert.equal(readFileSync(path.join(PROJECT, 'a.txt'), 'utf8'), 'versi terakhir\n', 'nothing ran');
  const budget = rewindDeadline(60_000);
  assert.ok(budget.left() > 59_000 && budget.left() <= 60_000);
});

test('"session not found" and "message not found" are told apart (OpenCode\'s _tag on stdout, HTTP status on stderr)', async () => {
  seed(2);
  await assert.rejects(openCodeRewindPoints({ opencode, sessionId: 'ses_hilang' }), { status: 404, message: /Sesi OpenCode ini tidak ditemukan/ });
  await assert.rejects(revertOpenCodeSession({ opencode, projectPath: PROJECT, sessionId: SID, messageId: 'msg_gone', files: true }), { status: 404, message: /Pesan itu tidak ada lagi/ });
});

test('a commit that fails twice is cleared again (files back, conversation whole) and reported; so is a lost stage answer', async () => {
  const flag = path.join(TMP, 'commit-fail');
  const clearLog = path.join(TMP, 'clear.log');
  process.env.FAKE_ACP_COMMIT_FAIL = flag;
  process.env.FAKE_ACP_STAGE_FAIL = path.join(TMP, 'stage-fail');
  process.env.FAKE_ACP_CLEAR_LOG = clearLog;
  try {
    seed(3);
    writeFileSync(flag, '1');
    await assert.rejects(revertOpenCodeSession({ opencode, projectPath: PROJECT, sessionId: SID, messageId: 'msg_u2', files: true }), { status: 502, message: /commit gagal.*revert dibatalkan/s });
    assert.equal(readFileSync(`${flag}.log`, 'utf8').split('\n').filter(Boolean).length, 2, 'one more try');
    assert.equal(readFileSync(path.join(PROJECT, 'a.txt'), 'utf8'), 'versi terakhir\n', 'the files are back as before the stage');
    assert.equal((await openCodeRewindPoints({ opencode, sessionId: SID }))[0].uuid, 'msg_u3', 'nothing deleted');
    rmSync(flag);

    seed(3);
    writeFileSync(process.env.FAKE_ACP_STAGE_FAIL, '1');
    await assert.rejects(revertOpenCodeSession({ opencode, projectPath: PROJECT, sessionId: SID, messageId: 'msg_u2', files: true }), { status: 502, message: /stage answer lost.*revert dibatalkan/s });
    assert.equal(readFileSync(path.join(PROJECT, 'a.txt'), 'utf8'), 'versi terakhir\n', 'cleared after a failed stage');
    assert.equal(readFileSync(clearLog, 'utf8').split('\n').filter(Boolean).length, 2, 'session.revert.clear each time');
  } finally {
    for (const k of ['FAKE_ACP_COMMIT_FAIL', 'FAKE_ACP_STAGE_FAIL', 'FAKE_ACP_CLEAR_LOG']) delete process.env[k];
    rmSync(path.join(TMP, 'stage-fail'), { force: true });
  }
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
