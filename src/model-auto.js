// Model Auto: the model follows the task. The same one-shot classifier as Effort Auto (src/effort-classifier.js)
// picks an effort level; here the level maps to a tier (hemat / seimbang / kuat / maks) with one model per engine.
// The defaults below are the ladder; a project may replace single tiers with models of its own (settings.modelTiers,
// validated in src/hub.js cleanSettings). The tier names are what the chat line shows, the model is what is applied.
import { cleanAutoLevel } from './effort.js';

/** From cheapest to strongest, in the order the picker would show them. */
export const MODEL_TIERS = ['hemat', 'seimbang', 'kuat', 'maks'];

const LABELS = { hemat: 'Hemat', seimbang: 'Seimbang', kuat: 'Kuat', maks: 'Maks' };
// xhigh and max both mean "the strongest": one tier, not two.
const TIER_BY_LEVEL = { low: 'hemat', medium: 'seimbang', high: 'kuat', xhigh: 'maks', max: 'maks' };
const FALLBACK_TIER = 'seimbang'; // medium: an unknown level never picks a big/expensive model

// Claude Code: aliases its `--model` accepts (src/hub.js MODEL_ALIAS).
// OpenCode: "provider/model" ids, as `opencode models` lists them.
// DEFAULT_TIERS is what a project without its own ladder uses, and the value each cleared slot falls back to.
export const DEFAULT_TIERS = {
  claude: { hemat: 'haiku', seimbang: 'sonnet', kuat: 'opus', maks: 'fable' },
  opencode: {
    hemat: 'opencode-go/deepseek-v4.1-flash',
    seimbang: 'opencode-go/glm-5.3-flash',
    kuat: 'opencode-go/deepseek-v4-pro',
    maks: 'opencode-go/glm-5.3',
  },
};

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/** An unknown engine falls back to Claude's models (never to an id the running engine cannot use). */
const engineKey = (engine) => (DEFAULT_TIERS[engine] ? engine : 'claude');

/**
 * One engine's ladder: the project's own tiers over the defaults. Only the four tier names count and an empty
 * value is no value, so a hand-edited state.json can never blank out a tier (an unknown key is ignored).
 * @param {'claude'|'opencode'} engine
 * @param {Record<string, Record<string, string>>|null|undefined} modelTiers  settings.modelTiers
 * @returns {Record<'hemat'|'seimbang'|'kuat'|'maks', string>}
 */
export function tiersFor(engine, modelTiers) {
  const key = engineKey(engine);
  const tiers = { ...DEFAULT_TIERS[key] };
  const custom = isObject(modelTiers) ? modelTiers[key] : null;
  if (!isObject(custom)) return tiers;
  for (const tier of MODEL_TIERS) {
    const value = custom[tier];
    if (typeof value === 'string' && value.trim()) tiers[tier] = value.trim();
  }
  return tiers;
}

/**
 * The tier of one classified level for one engine.
 * @param {string} level a level from src/effort.js (low…max); anything else is treated as medium
 * @param {'claude'|'opencode'} engine
 * @param {Record<string, Record<string, string>>|null|undefined} [modelTiers] the project's own ladder
 * @returns {{ key: 'hemat'|'seimbang'|'kuat'|'maks', label: string, model: string, engine: string }}
 */
export function tierFor(level, engine = 'claude', modelTiers = null) {
  const known = cleanAutoLevel(level);
  const key = TIER_BY_LEVEL[known ?? ''] ?? FALLBACK_TIER;
  const name = engineKey(engine);
  return { key, label: LABELS[key], model: tiersFor(name, modelTiers)[key], engine: name };
}

/** The model Model Auto applies for `level` on `engine` (the value stored in settings.model). */
export function autoModelFor(engine, level, modelTiers = null) {
  return tierFor(level, engine, modelTiers).model;
}

/** "opencode-go/glm-5.3" → "glm-5.3": the provider prefix says nothing in a one-line chat note. */
export function shortModelLabel(model) {
  const raw = String(model ?? '');
  const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  return bare.length > 40 ? `${bare.slice(0, 39)}…` : bare;
}
