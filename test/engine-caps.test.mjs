// Engine caps: the pure rules the UI uses to hide Claude-only surfaces when OpenCode is active.
// The server sends OPENCODE_CAPS in config.engines.opencode.caps; these tests keep the server and UI in sync.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_CAPS, capReason, capsFor, engineChangeNeedsReload, engineDown, engineOf, favoriteModelList, normalizeMode, openCodeProviderGroups } from '../public/js/core/engine-caps.js';
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
  assert.equal(CLAUDE_CAPS.plugins, true, 'the plugin dialog works for Claude too');
  assert.equal(CLAUDE_CAPS.search, true);
  const caps = capsFor({}, 'claude');
  assert.equal(caps.permissions, true);
  assert.equal(caps.extensions, true);
  assert.equal(caps.plugins, true);
  assert.equal(caps.search, true);
});

test('OpenCode turns off Claude-only permissions/extensions, but keeps conversation search', () => {
  const caps = capsFor(CONFIG, 'opencode');
  assert.equal(caps.permissions, false, 'Claude permission files are not OpenCode rules');
  assert.equal(caps.extensions, false, 'plugins/agents/hooks are Claude Code files');
  assert.equal(caps.plugins, true, 'OpenCode plugins (npm/Git) are managed in the same dialog');
  assert.equal(caps.search, true, 'conversation search covers OpenCode sessions too');
  assert.equal(caps.exportSession, false, 'full session export reads Claude transcripts');
  assert.deepEqual(caps.modes, ['build', 'plan', 'autopilot'], 'OpenCode menawarkan Build, Plan, dan Auto');
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

test('Auto ikut kosakata UI: normalizeMode mempertahankan autopilot, bukan auto lama', () => {
  assert.equal(normalizeMode('autopilot'), 'autopilot');
  assert.equal(normalizeMode('auto'), 'build', 'auto lama tetap Build');
  assert.equal(normalizeMode('plan'), 'plan');
});

test('caps follow the project engine, not the default', () => {
  const config = { engine: 'claude', engines: CONFIG.engines };
  assert.equal(capsFor(config, engineOf({ engine: 'opencode' }, config)).permissions, false);
  assert.equal(capsFor(config, engineOf({ engine: 'claude' }, config)).permissions, true);
});

test('the neutral reason never names an engine (one app, one timeline)', () => {
  assert.match(capReason('permissions', 'opencode'), /opencode\.json/i);
  assert.match(capReason('extensions', 'opencode'), /Claude/);
  assert.equal(capReason('rewind', 'opencode'), 'Belum tersedia untuk model yang aktif: Rewind');
  assert.doesNotMatch(capReason('rewind', 'opencode'), /OpenCode|Claude Code/);
  for (const cap of ['permissions', 'extensions', 'search', 'exportSession']) assert.doesNotMatch(capReason(cap, 'opencode'), /Fase 1/);
});

test('engineDown: only an OpenCode project shows ⚠ OpenCode berhenti, with its exit code', () => {
  assert.deepEqual(engineDown({ engine: 'opencode', openCodeDown: true, openCodeExit: 7 }, CONFIG), { exit: 7 });
  assert.deepEqual(engineDown({ engine: 'opencode', openCodeDown: true }, CONFIG), { exit: null }, 'no code is not a guess');
  assert.deepEqual(engineDown({ engine: 'opencode', openCodeDown: true, openCodeExit: 'x' }, CONFIG), { exit: null });
  assert.equal(engineDown({ engine: 'opencode', openCodeDown: false }, CONFIG), null);
  assert.equal(engineDown({ engine: 'opencode' }, CONFIG), null, 'a status without the flag is a live engine');
  // A stale flag from an earlier OpenCode session must never warn a Claude project.
  assert.equal(engineDown({ engine: 'claude', openCodeDown: true }, CONFIG), null);
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

const AUTH_KNOWN = ['river', 'opencode-go', 'openai'];
const AUTH_CONNECTED = ['opencode-go', 'openai']; // river has no credentials yet

test('the provider groups carry which providers still lack credentials', () => {
  const groups = openCodeProviderGroups(OC_PICKER_MODELS, '', { river: 'River AI' }, { known: AUTH_KNOWN, connected: AUTH_CONNECTED });
  assert.deepEqual(groups.map((g) => [g.label, g.connected]), [['River AI', false], ['opencode-go', true]], 'river belum terhubung, opencode-go iya');
});

test('providers unknown to the auth view and the unnamed group stay enabled', () => {
  const auth = { known: ['river'], connected: [] };
  const [river, go, other] = openCodeProviderGroups(
    [...OC_PICKER_MODELS, { value: 'solo-model', name: 'Solo' }], '', {}, auth,
  );
  assert.equal(river.connected, false, 'river diketahui dan tidak terhubung');
  assert.equal(go.connected, true, 'provider yang tidak ada di daftar auth dianggap terhubung (tidak dipagari)');
  assert.equal(other.connected, true, 'grup "lainnya" tanpa provider id tidak pernah dipagari');
});

test('an unreadable account view is marked unknown (null), not silently "connected"', () => {
  // The bug this guards: an empty auth list used to mean "everything is fine", so a logged-out provider was offered
  // (and the first prompt failed). No data now says "unknown": usable, but the renderer warns instead of gating.
  const noAuth = openCodeProviderGroups(OC_PICKER_MODELS, '', {}, null);
  assert.deepEqual(noAuth.map((g) => g.connected), [null, null], 'tanpa data auth: status login tak terbaca');
  const empty = openCodeProviderGroups(OC_PICKER_MODELS, '', {}, { known: [], connected: [] });
  assert.deepEqual(empty.map((g) => g.connected), [null, null], 'daftar kosong juga "tak terbaca", bukan "semua terhubung"');
});

const FAV_CLAUDE = [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }];

test('favoriteModelList: ids terpinji jadi entri ber-engine, urutan favorit, yang tak dikenal dilewati', () => {
  const favs = favoriteModelList(['river/GLM-5.3', 'sonnet', 'hilang', 'river/GLM-5.3'], FAV_CLAUDE, OC_PICKER_MODELS);
  assert.deepEqual(
    favs.map((m) => [m.value, m.engine]),
    [['river/GLM-5.3', 'opencode'], ['sonnet', 'claude']],
    'urutan mengikuti daftar favorit; dua entri, id ganda dilewati, id asing dilewati',
  );
  assert.deepEqual(favoriteModelList([], FAV_CLAUDE, OC_PICKER_MODELS), [], 'tanpa favorit: kosong');
  assert.deepEqual(favoriteModelList(null, FAV_CLAUDE, OC_PICKER_MODELS), [], 'daftar rusak: kosong');
});

