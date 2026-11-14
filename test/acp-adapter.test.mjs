// AcpAdapter on its own (no server, no process): how a `subagent` call is only the LAUNCH and the child session's
// own steps — the ones that arrive AFTER the turn, with a `<sessionId>:` prefixed call id and
// `_meta['opencode/child-session']` — are still linked to that delegation and close their rows.
// Shapes come from the real `opencode acp` frames (docs/design-opencode.md; captured frames in the repo history).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpAdapter } from '../src/acp-session.js';

const CHILD_A = 'ses_e263fb10effeIWKz8cz7rYMmHw';
const CHILD_B = 'ses_e263fb10effdd648vEq9P1SvAu';
const marker = (sid, title) => ({ 'opencode/child-session': { id: sid, parentID: 'ses_parent', depth: 1, title } });

/** What the session does with the adapter: every update passes during a turn, only the recognised ones after it. */
function harness() {
  const out = [];
  const adapter = new AcpAdapter((msg) => out.push(msg));
  let busy = true;
  return {
    adapter,
    out,
    endTurn(interrupted = false) {
      adapter.finish({ ok: !interrupted, interrupted, durationMs: 1, usage: {} });
      busy = false;
    },
    /** What src/acp-session.js onUpdate does: drop a late update the adapter does not recognise. */
    feed(u) {
      if (busy || adapter.continues(u)) adapter.update(u);
    },
    /** The `tool_use` blocks the adapter emitted (what the translator turns into rows). */
    uses: () => out.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content.filter((c) => c.type === 'tool_use').map((c) => ({ ...c, parent: m.parent_tool_use_id ?? null }))),
    /** The `tool_result` blocks the adapter emitted (what closes a row). */
    results: () => out.filter((m) => m.type === 'user').flatMap((m) => m.message.content.filter((c) => c.type === 'tool_result').map((c) => c.tool_use_id)),
  };
}

const subPending = (id) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'subagent', kind: 'think', status: 'pending', rawInput: {} });
const subRunning = (id, description) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, title: 'subagent', kind: 'think', status: 'in_progress', rawInput: { agent: 'backend', description, prompt: 'periksa' } });

/** A subagent call resolving at once: the LAUNCH announced the child session (`rawOutput.metadata.sessionID`). */
const subLaunched = (id, sid) => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: id,
  status: 'completed',
  rawOutput: { metadata: { sessionID: sid, status: 'running', truncated: false } },
  content: [{ type: 'content', content: { type: 'text', text: `The subagent is working in the background (sessionID: ${sid}).` } }],
});

/** The child session's own step: id prefixed with the child session, its own title, the marker on every frame. */
const childStep = (sid, toolId, title, kind, status, extra = {}) => ({
  sessionUpdate: status === 'pending' ? 'tool_call' : 'tool_call_update',
  toolCallId: `${sid}:${toolId}`,
  title: `${title}: ${kind}`,
  kind,
  status,
  ...(status === 'pending' ? { rawInput: {} } : {}),
  ...(status === 'completed' ? { content: [{ type: 'content', content: { type: 'text', text: `isi ${toolId}` } }] } : {}),
  _meta: marker(sid, title),
  ...extra,
});

test('a `subagent` call is a launch: its key survives and the child steps after the turn close their rows', () => {
  const h = harness();
  h.feed(subPending('call-launch'));
  h.feed(subRunning('call-launch', 'Cek API latar'));
  h.feed(subLaunched('call-launch', CHILD_A));
  h.endTurn();
  // the turn is over; only the child session's own calls may still pass the idle gate
  assert.equal(h.adapter.continues(subPending('chatcmpl-unrelated')), false, 'an unknown late call is still dropped');
  const read = childStep(CHILD_A, 'chatcmpl-1', 'Cek API latar', 'read', 'pending');
  assert.equal(h.adapter.continues(read), true, 'a child step is recognised by its child session id');
  h.feed(read);
  h.feed(childStep(CHILD_A, 'chatcmpl-1', 'Cek API latar', 'read', 'in_progress', { rawInput: { path: 'README.md' } }));
  h.feed(childStep(CHILD_A, 'chatcmpl-1', 'Cek API latar', 'read', 'completed'));
  const uses = h.uses();
  assert.equal(uses.length, 2, 'the launch and the step each emitted a row');
  assert.deepEqual(uses.map((b) => b.parent), [null, 'call-launch'], 'the step hangs under the delegation, not the main thread');
  assert.equal(uses[1].name, 'Read');
  assert.deepEqual(h.results(), ['call-launch', `${CHILD_A}:chatcmpl-1`], 'both the launch and the late step closed');
  assert.equal(h.adapter.tools.get(`${CHILD_A}:chatcmpl-1`)?.done, true, 'the step is marked done (the row closed)');
});

test('the launch resolving does NOT end the delegation: a step that starts AND finishes after it still links', () => {
  const h = harness();
  h.feed(subPending('sub1'));
  h.feed(subRunning('sub1', 'Cek API latar'));
  h.feed(subLaunched('sub1', CHILD_A));
  h.endTurn();
  // a step that both starts and finishes long after the turn ended (the real bug: it used to be dropped entirely)
  h.feed(childStep(CHILD_A, 'chatcmpl-late', 'Cek API latar', 'grep', 'pending'));
  h.feed(childStep(CHILD_A, 'chatcmpl-late', 'Cek API latar', 'grep', 'in_progress', { rawInput: { pattern: 'api' } }));
  h.feed(childStep(CHILD_A, 'chatcmpl-late', 'Cek API latar', 'grep', 'completed'));
  assert.deepEqual(h.uses().map((b) => [b.name, b.parent]), [['Agent', null], ['Grep', 'sub1']]);
  assert.deepEqual(h.results(), ['sub1', `${CHILD_A}:chatcmpl-late`]);
});

test('two parallel delegations: the child session id decides the parent, never the title', () => {
  const h = harness();
  h.feed(subPending('call-a'));
  h.feed(subPending('call-b'));
  h.feed(subRunning('call-a', 'Kap A'));
  h.feed(subRunning('call-b', 'Kap B'));
  h.feed(subLaunched('call-a', CHILD_A));
  h.feed(subLaunched('call-b', CHILD_B));
  h.endTurn();
  // Kap B's step, but its title says "Kap A" and no description key of its own: only the marker can sort it out
  h.feed(childStep(CHILD_B, 'chatcmpl-b', 'Kap A', 'read', 'pending'));
  h.feed(childStep(CHILD_B, 'chatcmpl-b', 'Kap A', 'read', 'in_progress', { rawInput: { path: 'b.txt' } }));
  h.feed(childStep(CHILD_B, 'chatcmpl-b', 'Kap A', 'read', 'completed'));
  assert.deepEqual(h.uses().map((b) => b.parent), [null, null, 'call-b'], 'the marker, not the title, picked the delegation');
});

test('a child step whose marker never came still links through its `<sessionId>:` call id', () => {
  const h = harness();
  h.feed(subPending('sub1'));
  h.feed(subRunning('sub1', 'Cek API latar'));
  h.feed(subLaunched('sub1', CHILD_A));
  h.endTurn();
  h.feed({ sessionUpdate: 'tool_call', toolCallId: `${CHILD_A}:chatcmpl-2`, title: 'tanpa penanda', kind: 'read', status: 'pending', rawInput: {} });
  h.feed({ sessionUpdate: 'tool_call_update', toolCallId: `${CHILD_A}:chatcmpl-2`, status: 'in_progress', rawInput: { path: 'a.txt' } });
  h.feed({ sessionUpdate: 'tool_call_update', toolCallId: `${CHILD_A}:chatcmpl-2`, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] });
  assert.deepEqual(h.uses().map((b) => b.parent), [null, 'sub1']);
  assert.deepEqual(h.results(), ['sub1', `${CHILD_A}:chatcmpl-2`]);
});

test('a child step that goes silent is given one turn of grace, then released so the row can be closed', () => {
  const h = harness();
  h.feed(subPending('sub1'));
  h.feed(subRunning('sub1', 'Cek API latar'));
  h.feed(subLaunched('sub1', CHILD_A));
  h.endTurn();
  const stuck = `${CHILD_A}:chatcmpl-stuck`;
  h.feed(childStep(CHILD_A, 'chatcmpl-stuck', 'Cek API latar', 'read', 'pending'));
  h.feed(childStep(CHILD_A, 'chatcmpl-stuck', 'Cek API latar', 'read', 'in_progress', { rawInput: { path: 'a.txt' } }));
  assert.equal(h.adapter.tools.has(stuck), true, 'still known: the child may report at any moment');
  h.endTurn(); // the child went silent through that turn: it is kept one more turn...
  assert.equal(h.adapter.tools.has(stuck), true, 'one turn of grace: a late report still closes the row');
  // ...and the next turn's end drops it, so the translator closes it (never an endless spinner)
  h.endTurn();
  assert.equal(h.adapter.tools.has(stuck), false, 'after the grace turn the step is released');
  // and a frame that arrives even later must NOT open a fresh row for it (the translator already closed it)
  assert.equal(h.adapter.continues(childStep(CHILD_A, 'chatcmpl-stuck', 'Cek API latar', 'read', 'completed')), false, 'a released step is never resurrected');
});

test('a stopped turn keeps no launch open: its late completion cannot hang a row or a role', () => {
  const h = harness();
  h.feed(subPending('sub1'));
  h.feed(subRunning('sub1', 'Cek API latar')); // launched, but its completion never arrived before the stop
  h.endTurn(true); // ■ Stop
  assert.equal(h.adapter.tools.has('sub1'), false, 'a stopped turn kept no launch open');
  assert.equal(h.adapter.continues(subLaunched('sub1', CHILD_A)), false, 'its late completion is refused, so nothing hangs');
});

test('a frame that slipped past the gate for a released step still opens no phantom row', () => {
  const h = harness();
  h.feed(subPending('sub1'));
  h.feed(subRunning('sub1', 'Cek API latar'));
  h.feed(subLaunched('sub1', CHILD_A));
  h.endTurn();
  h.feed(childStep(CHILD_A, 'chatcmpl-stuck', 'Cek API latar', 'read', 'pending'));
  h.feed(childStep(CHILD_A, 'chatcmpl-stuck', 'Cek API latar', 'read', 'in_progress', { rawInput: { path: 'a.txt' } }));
  h.endTurn(); // one turn of grace
  h.endTurn(); // released: the translator closed the row with its synthetic note
  const before = h.uses().length;
  // the frame reaches update() anyway (a later turn is busy, so the idle gate is not consulted)
  h.adapter.update(childStep(CHILD_A, 'chatcmpl-stuck', 'Cek API latar', 'read', 'completed'));
  assert.equal(h.uses().length, before, 'no phantom row was created for the released step');
});

test('a child frame carrying the marker is accepted even when its launch was never seen (attach/load)', () => {
  const h = harness();
  h.endTurn(); // idle: no launch was ever announced to this adapter
  const frame = childStep(CHILD_A, 'chatcmpl-late', 'Cek API latar', 'read', 'pending'); // its `_meta` marker is present
  assert.equal(h.adapter.continues(frame), true, 'the marker, not the id shape, is what makes it a child step');
  h.feed(frame);
  h.feed(childStep(CHILD_A, 'chatcmpl-late', 'Cek API latar', 'read', 'in_progress', { rawInput: { path: 'a.txt' } }));
  h.feed(childStep(CHILD_A, 'chatcmpl-late', 'Cek API latar', 'read', 'completed'));
  assert.deepEqual(h.uses().map((b) => b.name), ['Read']);
  assert.deepEqual(h.results(), [`${CHILD_A}:chatcmpl-late`]);
});

test('an unknown `ses_`-looking call id never reopens the office while idle', () => {
  const h = harness();
  h.feed(subPending('sub1'));
  h.feed(subRunning('sub1', 'Cek API latar'));
  h.feed(subLaunched('sub1', CHILD_A));
  h.endTurn();
  // an id shaped like a child session that no launch ever announced (or a stopped turn's stray frame): refused
  const unknown = { sessionUpdate: 'tool_call', toolCallId: 'ses_never_seen_anywhere:chatcmpl-tool-Z', title: 'read', kind: 'read', status: 'pending', rawInput: {} };
  assert.equal(h.adapter.continues(unknown), false, 'only a KNOWN child session may stream after the turn');
  h.feed(unknown);
  assert.deepEqual(h.uses().map((b) => b.name), ['Agent'], 'nothing new was emitted for it');
});

test('a stopped turn keeps nothing open, and its late frames cannot reopen a row', () => {
  const h = harness();
  h.feed(subPending('sub1'));
  h.feed(subRunning('sub1', 'Cek API latar'));
  h.feed(subLaunched('sub1', CHILD_A));
  const open = `${CHILD_A}:chatcmpl-stopped`;
  h.feed(childStep(CHILD_A, 'chatcmpl-stopped', 'Cek API latar', 'read', 'pending'));
  h.feed(childStep(CHILD_A, 'chatcmpl-stopped', 'Cek API latar', 'read', 'in_progress', { rawInput: { path: 'a.txt' } }));
  h.endTurn(true); // ■ Stop: the turn was interrupted
  assert.equal(h.adapter.tools.has(open), false, 'the stopped turn kept no child step');
  assert.equal(h.adapter.continues(childStep(CHILD_A, 'chatcmpl-stopped', 'Cek API latar', 'read', 'completed')), false, 'its late frame is refused');
});
