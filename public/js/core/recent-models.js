// Models picked recently, per project (pure): the picker shows three of them above the long list. Small and
// device-local: a model is a UI preference, not project data, so it never reaches the server.
const KEY = 'office.recentModels';
const MAX_PER_PROJECT = 3;
const MAX_PROJECTS = 100;

const clean = (value) => (typeof value === 'string' && value && value.length <= 200 ? value : null);

/** All per-project lists, validated. */
export function readAllRecent(storage = globalThis.localStorage) {
  try {
    const data = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out = {};
    for (const [project, list] of Object.entries(data)) {
      if (!/^[\w-]{1,40}$/.test(project) || !Array.isArray(list)) continue;
      const values = [...new Set(list.map(clean).filter(Boolean))].slice(0, MAX_PER_PROJECT);
      if (values.length) out[project] = values;
    }
    return out;
  } catch {
    return {};
  }
}

/** The recent model values of one project, newest first. */
export function readRecentModels(projectId, storage = globalThis.localStorage) {
  return readAllRecent(storage)[projectId] ?? [];
}

/** Records a pick (newest first, no duplicates, three per project). Returns the new list. */
export function rememberRecentModel(projectId, value, storage = globalThis.localStorage) {
  const model = clean(value);
  if (!projectId || !model || model === 'auto') return readRecentModels(projectId, storage);
  const all = readAllRecent(storage);
  const list = [model, ...(all[projectId] ?? []).filter((v) => v !== model)].slice(0, MAX_PER_PROJECT);
  all[projectId] = list;
  // Bound the number of projects: drop the oldest keys (object insertion order is stable in practice).
  const keys = Object.keys(all);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PROJECTS))) delete all[key];
  try {
    storage?.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage blocked (private mode): the picker simply shows no recents
  }
  return list;
}
