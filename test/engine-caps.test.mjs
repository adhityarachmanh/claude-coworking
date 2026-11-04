// Engine caps: the pure rules the UI uses to hide Claude-only surfaces when OpenCode is active.
// The server sends OPENCODE_CAPS in config.engines.opencode.caps; these tests keep the server and UI in sync.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_CAPS, capReason, capsFor } from '../public/js/core/engine-caps.js';
import { OPENCODE_CAPS } from '../src/acp-session.js';

const CONFIG = Object.freeze({
  engine: 'opencode',
  engines: {
    claude: { available: true },
    opencode: { available: true, caps: OPENCODE_CAPS },
  },
});

test('Claude Code keeps the Claude-only surfaces', () => {
  assert.equal(CLAUDE_CAPS.permissions, true);
  assert.equal(CLAUDE_CAPS.extensions, true);
  assert.equal(CLAUDE_CAPS.search, true);
  const caps = capsFor({}, 'claude');
  assert.equal(caps.permissions, true);
  assert.equal(caps.extensions, true);
  assert.equal(caps.search, true);
});

test('OpenCode turns off Claude-only permissions/extensions, but keeps conversation search', () => {
  const caps = capsFor(CONFIG, 'opencode');
  assert.equal(caps.permissions, false, 'Claude permission files are not OpenCode rules');
  assert.equal(caps.extensions, false, 'plugins/agents/hooks are Claude Code files');
  assert.equal(caps.search, true, 'conversation search covers OpenCode sessions too');
  assert.equal(caps.exportSession, false, 'full session export reads Claude transcripts');
  assert.deepEqual(caps.modes, ['manual', 'plan'], 'OpenCode shows only Build and Plan');
});

test('caps without an engines entry fall back to Claude (older servers)', () => {
  const caps = capsFor({}, 'opencode');
  assert.equal(caps.permissions, true);
  assert.equal(caps.search, true);
});

test('the reason is clear and no longer says Fase 1', () => {
  assert.match(capReason('permissions', 'opencode'), /opencode\.json/i);
  assert.match(capReason('extensions', 'opencode'), /Claude Code/i);
  assert.match(capReason('rewind', 'opencode'), /OpenCode belum mendukung Rewind/);
  for (const cap of ['permissions', 'extensions', 'search', 'exportSession']) assert.doesNotMatch(capReason(cap, 'opencode'), /Fase 1/);
});
