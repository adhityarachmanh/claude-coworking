// Engine caps: the pure rules the UI uses to hide Claude-only surfaces when OpenCode is active.
// The server sends OPENCODE_CAPS in config.engines.opencode.caps; these tests keep the server and UI in sync.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_CAPS, capReason, capsFor, engineBadge, engineChangeNeedsReload, engineOf, openCodeProviderGroups } from '../public/js/core/engine-caps.js';
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
  assert.deepEqual(caps.modes, ['build', 'plan'], 'OpenCode shows only Build and Plan');
});

test('caps without an engines entry fall back to Claude (older servers)', () => {
  const caps = capsFor({}, 'opencode');
  assert.equal(caps.permissions, true);
  assert.equal(caps.search, true);
});

test('engineOf: the project status wins over the app-wide default (Stage 1)', () => {
  // A project that chose OpenCode keeps it even while Akun's default (new projects) is Claude Code.
  assert.equal(engineOf({ engine: 'opencode' }, CONFIG), 'opencode');
  // And the other way: a Claude project is not dragged along by an OpenCode default.
  assert.equal(engineOf({ engine: 'claude' }, CONFIG), 'claude');
  // Older servers (no per-project engine) and a project not opened yet fall back to the default.
  assert.equal(engineOf({}, CONFIG), 'opencode');
  assert.equal(engineOf(undefined, CONFIG), 'opencode');
  assert.equal(engineOf({}, {}), 'claude', 'nothing known: Claude Code');
});

test('engineOf: a malformed status engine is ignored, never shown as a choice', () => {
  assert.equal(engineOf({ engine: 'Open Code!' }, { engine: 'opencode' }), 'opencode');
  assert.equal(engineOf({ engine: '' }, { engine: 'claude' }), 'claude');
  assert.equal(engineOf({ engine: 42 }, undefined), 'claude');
});

test('caps follow the project engine, not the default', () => {
  const config = { engine: 'claude', engines: CONFIG.engines };
  assert.equal(capsFor(config, engineOf({ engine: 'opencode' }, config)).permissions, false);
  assert.equal(capsFor(config, engineOf({ engine: 'claude' }, config)).permissions, true);
});

test('the badge is short and still names an engine the server adds later', () => {
  assert.equal(engineBadge('claude'), '✳ Claude');
  assert.equal(engineBadge('opencode'), '⌘ OpenCode');
  assert.equal(engineBadge('cursor'), 'cursor');
  assert.equal(engineBadge(undefined), 'claude', 'like engineLabel: the default engine id, never "undefined"');
});

test('the reason is clear and no longer says Fase 1', () => {
  assert.match(capReason('permissions', 'opencode'), /opencode\.json/i);
  assert.match(capReason('extensions', 'opencode'), /Claude Code/i);
  assert.match(capReason('rewind', 'opencode'), /OpenCode belum mendukung Rewind/);
  for (const cap of ['permissions', 'extensions', 'search', 'exportSession']) assert.doesNotMatch(capReason(cap, 'opencode'), /Fase 1/);
});

test('every engine change reloads open clients, including ONE project switching engine', () => {
  // App-wide default switch (no project) and per-project switch both invalidate chat/activity/history caches.
  assert.equal(engineChangeNeedsReload({ engine: 'opencode' }), true);
  assert.equal(engineChangeNeedsReload({ engine: 'opencode', project: 'p1' }), true);
  assert.equal(engineChangeNeedsReload(null), false, 'a malformed event does not reload the page');
});

const OC_PICKER_MODELS = Object.freeze([
  { value: 'river/GLM-5.3', name: 'GLM-5.3' },
  { value: 'river/zai-org/GLM-5.3-Flash', name: 'GLM 5.3 Flash' },
  { value: 'river/deepseek-ai/DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash' },
  { value: 'opencode-go/glm-5.3-flash', name: 'GLM 5.3 Flash' },
]);

test('the picker groups OpenCode models one group per provider, labelled by the provider display name when known', () => {
  const groups = openCodeProviderGroups(OC_PICKER_MODELS, '', { river: 'River AI' });
  assert.deepEqual(groups.map((g) => g.label), ['River AI', 'opencode-go'], 'urutan kemunculan pertama, label dari nama tampilan');
  assert.deepEqual(groups[0].models.map((m) => m.value), ['river/GLM-5.3', 'river/zai-org/GLM-5.3-Flash', 'river/deepseek-ai/DeepSeek-V4.1-Flash']);
  assert.equal(groups[1].label, 'opencode-go', 'tanpa nama tampilan: label jatuh ke id provider');
});

test('the provider picker groups keep the search filter and the no-name fallback', () => {
  const groups = openCodeProviderGroups(OC_PICKER_MODELS, 'glm', {});
  assert.deepEqual(groups.map((g) => g.label), ['river', 'opencode-go'], 'filter tetap bekerja; label id apa adanya');
  assert.deepEqual(groups[0].models.map((m) => m.value), ['river/GLM-5.3', 'river/zai-org/GLM-5.3-Flash']);
  const none = openCodeProviderGroups(OC_PICKER_MODELS, 'tidak-ada-yang-cocok', { river: 'River AI' });
  assert.deepEqual(none, [], 'tidak ada grup kosong saat filter tidak cocok');
  // A model without a provider prefix shares one "lainnya" group (providerOf's rule).
  const mixed = openCodeProviderGroups([...OC_PICKER_MODELS, { value: 'solo-model', name: 'Solo' }], '', {});
  assert.equal(mixed.at(-1).label, 'lainnya');
  assert.equal(mixed.at(-1).models[0].value, 'solo-model');
});

