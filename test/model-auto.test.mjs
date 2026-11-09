// Model Auto's ladder: the defaults per engine, a project's own tiers changing the applied model, and the
// validation in Hub.cleanSettings (an invalid model is never stored). Offline and fast: no server, no CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, Hub } from '../src/hub.js';
import { autoModelFor, classifierModelFor, DEFAULT_TIERS, shortModelLabel, tierFor, tiersFor } from '../src/model-auto.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'office-model-auto-'));
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));

/** A Hub with no state on disk: cleanSettings is pure (nothing is saved by the calls below). */
const hub = new Hub({ dataDir });

/** settings.modelTiers after one settings patch, validated the same way the settings route stores it. */
const cleaned = (patch, base = DEFAULT_SETTINGS) => hub.cleanSettings(base, patch).modelTiers;

test('Model Auto: the default ladders per engine are cheap but still tiered', () => {
  assert.deepEqual(DEFAULT_TIERS.claude, { hemat: 'haiku', seimbang: 'sonnet', kuat: 'opus', maks: 'fable' });
  assert.deepEqual(DEFAULT_TIERS.opencode, {
    hemat: 'opencode-go/deepseek-v4.1-flash',
    seimbang: 'opencode-go/glm-5.3-flash',
    kuat: 'opencode-go/deepseek-v4-pro',
    maks: 'opencode-go/glm-5.3',
  });
  for (const model of Object.values(DEFAULT_TIERS.opencode)) assert.ok(!/kimi/i.test(model), `${model} bukan Kimi mahal`);
  assert.equal(tierFor('low').model, 'haiku');
  assert.equal(tierFor('high', 'opencode').model, 'opencode-go/deepseek-v4-pro');
  assert.equal(tierFor('bogus', 'opencode').model, 'opencode-go/glm-5.3-flash', 'an unknown level is Seimbang');
  assert.equal(tierFor('high', 'mesin-lain').model, 'opus', 'an unknown engine uses the Claude ladder');
  assert.deepEqual(tiersFor('opencode', null), DEFAULT_TIERS.opencode, 'no ladder = the defaults');
  assert.deepEqual(tiersFor('opencode', {}), DEFAULT_TIERS.opencode);
});

test('classifierModelFor: the Auto classifier always uses the Seimbang tier, never the active model', () => {
  assert.equal(classifierModelFor('opencode'), 'opencode-go/glm-5.3-flash');
  assert.equal(classifierModelFor('claude'), 'sonnet');
  assert.equal(classifierModelFor('opencode', { opencode: { seimbang: 'opencode-go/deepseek-v4.1-flash', kuat: 'opencode-go/deepseek-v4-pro' } }), 'opencode-go/deepseek-v4.1-flash');
  assert.equal(classifierModelFor('opencode', { opencode: { seimbang: '' } }), 'opencode-go/glm-5.3-flash', 'an empty slot falls back to the default');
  assert.equal(classifierModelFor('mesin-lain'), 'sonnet', 'an unknown engine uses the Claude ladder');
});

test('Model Auto: a custom tier changes the applied model for a classified level only', () => {
  const modelTiers = { opencode: { hemat: 'opencode-go/mimo-v2.6-flash' } };
  assert.deepEqual(tierFor('low', 'opencode', modelTiers), { key: 'hemat', label: 'Hemat', model: 'opencode-go/mimo-v2.6-flash', engine: 'opencode' });
  assert.equal(autoModelFor('opencode', 'low', modelTiers), 'opencode-go/mimo-v2.6-flash');
  assert.equal(autoModelFor('opencode', 'high', modelTiers), 'opencode-go/deepseek-v4-pro', 'other tiers keep their default');
  assert.equal(autoModelFor('claude', 'low', modelTiers), 'haiku', "one engine's ladder never leaks into the other");
  assert.equal(autoModelFor('bogus', 'low', modelTiers), 'haiku', 'an unknown engine still reads the Claude ladder');
  assert.equal(shortModelLabel(autoModelFor('opencode', 'low', modelTiers)), 'mimo-v2.6-flash');
});

test('Model Auto: both engines keep separate ladders; unknown keys are ignored', () => {
  const modelTiers = {
    claude: { hemat: 'fable', maks: 'claude-haiku-4-5-20251001' },
    opencode: { hemat: 'opencode-go/mimo-v2.6-flash', maks: 'opencode-go/kimi-k3' },
    mesin: { hemat: 'opencode-go/kimi-k3' }, // an unknown engine name, as a hand-edited state.json could hold
  };
  assert.equal(autoModelFor('claude', 'low', modelTiers), 'fable');
  assert.equal(autoModelFor('claude', 'max', modelTiers), 'claude-haiku-4-5-20251001');
  assert.equal(autoModelFor('opencode', 'low', modelTiers), 'opencode-go/mimo-v2.6-flash');
  assert.equal(autoModelFor('opencode', 'max', modelTiers), 'opencode-go/kimi-k3');
  const merged = tiersFor('opencode', { opencode: { hemat: 'opencode-go/kimi-k3', hemat2: 'x/y', maks: '' } });
  assert.equal(merged.hemat, 'opencode-go/kimi-k3');
  assert.equal(merged.maks, 'opencode-go/glm-5.3', 'an empty value is no value');
  assert.equal(merged.seimbang, 'opencode-go/glm-5.3-flash');
  assert.deepEqual(Object.keys(merged).sort(), ['hemat', 'kuat', 'maks', 'seimbang'], 'unknown keys are never part of a ladder');
});

test('settings: a valid custom ladder is stored trimmed; an invalid model is dropped and the previous value stays', () => {
  const custom = cleaned({ modelTiers: { opencode: { hemat: '  opencode-go/mimo-v2.6-flash  ', kuat: 'opencode-go/kimi-k3' } } });
  assert.deepEqual(custom, { opencode: { hemat: 'opencode-go/mimo-v2.6-flash', kuat: 'opencode-go/kimi-k3' } });

  // Invalid for OpenCode: no provider prefix, a space, too long, and a Claude alias.
  for (const bad of ['tanpa-provider', 'opencode-go/model dengan spasi', `p${'x'.repeat(200)}/m`, 'haiku', 42]) {
    const next = cleaned({ modelTiers: { opencode: { hemat: bad } } }, { ...DEFAULT_SETTINGS, modelTiers: custom });
    assert.deepEqual(next, custom, `${String(bad)} is not stored`);
  }
  // Invalid for Claude: not an alias, not a claude-… id, not in the catalog; the previous tier survives.
  for (const bad of ['gpt-4', 'sonnet; rm -rf', 'haiku[2m]', '--dangerously-skip-permissions']) {
    const next = cleaned({ modelTiers: { claude: { hemat: bad } } }, { ...DEFAULT_SETTINGS, modelTiers: { claude: { hemat: 'fable' } } });
    assert.deepEqual(next, { claude: { hemat: 'fable' } }, `${bad} is not stored`);
  }
  assert.deepEqual(cleaned({ modelTiers: { opencode: { hemat: 'tanpa-provider' } } }), {}, 'nothing invalid is ever stored');
  // Unknown engines are ignored, a non-object patch changes nothing.
  assert.deepEqual(cleaned({ modelTiers: { mesin: { hemat: 'opencode-go/kimi-k3' } } }), {});
  assert.deepEqual(cleaned({ modelTiers: 'opencode-go/kimi-k3' }), {});
});

test('settings: clearing a slot returns to the default; an empty ladder keeps the status small', () => {
  const base = { ...DEFAULT_SETTINGS, modelTiers: { opencode: { hemat: 'opencode-go/mimo-v2.6-flash', kuat: 'opencode-go/kimi-k3' } } };
  const cleared = cleaned({ modelTiers: { opencode: { hemat: '' } } }, base);
  assert.deepEqual(cleared, { opencode: { kuat: 'opencode-go/kimi-k3' } });
  assert.equal(autoModelFor('opencode', 'low', cleared), 'opencode-go/deepseek-v4.1-flash', 'the default model is back');
  assert.equal(autoModelFor('opencode', 'high', cleared), 'opencode-go/kimi-k3', 'the other slot is untouched');
  assert.deepEqual(cleaned({ modelTiers: { opencode: { kuat: '' } } }, { opencode: { kuat: 'opencode-go/kimi-k3' } }), {}, 'an empty ladder leaves no key');
  // A stored ladder is what settingsFor shows (and so what the status broadcasts).
  hub.persisted.settings.tiers = { ...DEFAULT_SETTINGS, modelTiers: { claude: { hemat: 'fable' } } };
  assert.deepEqual(hub.settingsFor('tiers').modelTiers, { claude: { hemat: 'fable' } });
  hub.persisted.settings.broken = { modelTiers: 'bukan objek' };
  assert.deepEqual(hub.settingsFor('broken').modelTiers, {}, 'a hand-edited state.json cannot break the status shape');
});
