// Remembers effort levels a provider refused for a model, so they are never sent again — even after a restart.
// The key is the model id the app stores in its settings ("provider/model"), because the levels belong to the model,
// not to the project or the page. Everything here is best effort: a missing, locked or torn file must never block a
// turn, and junk in it is dropped instead of trusted.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const EFFORT_MEMORY_FILE = 'effort-refusals.json';
// Enough for every level a model offers; a provider that keeps refusing must not grow the file.
const MAX_PER_MODEL = 12;
const MAX_MODELS = 60;

/** A level/name OpenCode could have sent: short, no spaces, nothing that looks like a path or a shell word. */
const cleanLevel = (value) => (typeof value === 'string' && /^[\w-]{1,24}$/.test(value) ? value : '');
const cleanModel = (value) => (typeof value === 'string' ? value.trim().slice(0, 200) : '');

/**
 * The refusals file as `{ "<provider>/<model>": ["low", …] }`; `{}` when it is missing, unreadable or not an object.
 * @param {string} [dataDir]
 * @returns {Record<string, string[]>}
 */
export function readEffortRefusals(dataDir) {
  if (!dataDir) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(path.join(dataDir, EFFORT_MEMORY_FILE), 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, list] of Object.entries(raw)) {
    const model = cleanModel(key);
    if (!model || !Array.isArray(list)) continue;
    const levels = [...new Set(list.map(cleanLevel).filter(Boolean))].slice(0, MAX_PER_MODEL);
    if (levels.length) out[model] = levels;
  }
  return out;
}

/**
 * The levels this model already lost to its provider: never send them again.
 * @param {string} [dataDir]
 * @param {string} modelId
 * @returns {Set<string>}
 */
export function refusalsFor(dataDir, modelId) {
  const model = cleanModel(modelId);
  return new Set(model ? (readEffortRefusals(dataDir)[model] ?? []) : []);
}

/**
 * Records one refusal for a model. Returns true only when the file was written with something new.
 * @param {string} [dataDir]
 * @param {string} modelId
 * @param {string} level
 */
export function rememberEffortRefusal(dataDir, modelId, level) {
  const model = cleanModel(modelId);
  const refused = cleanLevel(level);
  if (!dataDir || !model || !refused) return false;
  const all = readEffortRefusals(dataDir);
  const levels = all[model] ?? [];
  if (levels.includes(refused)) return false;
  all[model] = [...levels, refused].slice(-MAX_PER_MODEL);
  const models = Object.keys(all);
  if (models.length > MAX_MODELS) for (const old of models.slice(0, models.length - MAX_MODELS)) delete all[old];
  try {
    mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, EFFORT_MEMORY_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(temp, file); // the reader sees the old file or the new one, never half of each
    return true;
  } catch {
    return false; // a locked folder only costs the memory, not the turn
  }
}
