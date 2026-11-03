// Which engine runs a project (Claude Code / OpenCode) and what it can do (docs/design-opencode.md §6, D10).
// Pure: no DOM, no state. The UI asks `capsFor(config, engine)` instead of branching on engine names, so a
// feature an engine lacks is hidden or disabled in one way everywhere, with the reason from `capReason`.

export const DEFAULT_ENGINE = 'claude';

/** Display names; an engine the server adds later still shows (its id) without a code change. */
export const ENGINE_LABEL = { claude: 'Claude Code', opencode: 'OpenCode' };

export const ALL_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk'];

/** Everything on: what Claude Code supports, and the safe default for a server without `config.engines`. */
export const CLAUDE_CAPS = Object.freeze({
  effort: true,
  team: true,
  rewind: true,
  mcp: true,
  bgTasks: true,
  askQuestion: true,
  exportSession: true,
  mirror: true,
  modes: Object.freeze([...ALL_MODES]),
});

const BOOL_CAPS = Object.keys(CLAUDE_CAPS).filter((k) => k !== 'modes');

/** What each cap switches off, for "<Engine> belum mendukung <feature>". */
const CAP_FEATURE = {
  effort: 'pengaturan effort',
  team: 'Mode tim',
  rewind: 'Rewind',
  mcp: 'pengelolaan server MCP dari sini (atur di config OpenCode)',
  bgTasks: 'tugas latar',
  askQuestion: 'pertanyaan/rencana interaktif',
  exportSession: 'export sesi lengkap (pakai Export percakapan)',
  mirror: 'mirror sesi terminal',
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cleanId = (v) => (typeof v === 'string' && /^[a-z][\w-]{0,31}$/.test(v) ? v : null);

export const engineLabel = (engine) => ENGINE_LABEL[engine] ?? String(engine ?? DEFAULT_ENGINE);

/**
 * The engine a project runs on: the app-wide one (`config.engine`, chosen in Akun) when the server sends it, else
 * the project status' (older servers); anything missing or malformed is Claude Code. A project without a status
 * yet (never opened this run) must still show the active engine's models and modes.
 */
export function engineOf(status, config) {
  return cleanId(config?.engine) ?? cleanId(status?.engine) ?? DEFAULT_ENGINE;
}

/**
 * Caps of `engine` from `config.engines[engine].caps`, every field validated (never trust the server blindly):
 * a missing/non-boolean flag falls back to Claude's, `modes` keeps only known modes and never ends up empty.
 * A config without `engines`, or without an entry for the engine, gives Claude's caps (design §6.2).
 */
export function capsFor(config, engine = DEFAULT_ENGINE) {
  const raw = isObj(config?.engines) && isObj(config.engines[engine]) ? config.engines[engine].caps : null;
  if (!isObj(raw)) return { ...CLAUDE_CAPS, modes: [...CLAUDE_CAPS.modes] };
  const caps = {};
  for (const key of BOOL_CAPS) caps[key] = typeof raw[key] === 'boolean' ? raw[key] : CLAUDE_CAPS[key];
  const modes = Array.isArray(raw.modes) ? ALL_MODES.filter((m) => raw.modes.includes(m)) : [];
  caps.modes = modes.length ? modes : [...CLAUDE_CAPS.modes];
  return caps;
}

/**
 * The engines the picker offers: `[]` when the server doesn't report `config.engines` (picker hidden) or only
 * knows one engine. Claude Code is always first and always available.
 */
export function engineChoices(config) {
  if (!isObj(config?.engines)) return [];
  const ids = Object.keys(config.engines).map(cleanId).filter(Boolean);
  if (!ids.includes(DEFAULT_ENGINE)) ids.unshift(DEFAULT_ENGINE);
  const list = [DEFAULT_ENGINE, ...ids.filter((id) => id !== DEFAULT_ENGINE)].map((id) => {
    const e = isObj(config.engines[id]) ? config.engines[id] : {};
    const available = id === DEFAULT_ENGINE || e.available === true;
    const version = typeof e.version === 'string' ? e.version.slice(0, 40) : '';
    return {
      id,
      label: engineLabel(id),
      available,
      version,
      reason: available ? '' : `${engineLabel(id)} tidak ditemukan di laptop ini. Pasang lalu restart server (lihat README: Memakai OpenCode).`,
    };
  });
  return list.length > 1 ? list : [];
}

/** Why a control is off: "OpenCode belum mendukung Rewind (Fase 1)". */
export function capReason(cap, engine) {
  return `${engineLabel(engine)} belum mendukung ${CAP_FEATURE[cap] ?? cap} (Fase 1)`;
}

/** A stored mode the engine doesn't offer (dontAsk on OpenCode) is shown and used as 🛡️ manual, as the server does. */
export function modeFor(mode, caps) {
  const modes = caps?.modes ?? CLAUDE_CAPS.modes;
  return modes.includes(mode) ? mode : modes.includes('manual') ? 'manual' : modes[0];
}

/** Claude Code's models come with the app config; any other engine lists its own per project (`/models`). */
export const modelsPerProject = (engine) => engine !== DEFAULT_ENGINE;

const MAX_MODELS = 2000;

/** The `/models` answer, validated: `{ models:[{value,name}], current, needsStart }`. */
export function cleanModelList(data) {
  const seen = new Set();
  const models = [];
  for (const m of Array.isArray(data?.models) ? data.models : []) {
    const value = typeof m?.value === 'string' ? m.value.trim().slice(0, 200) : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 200) : value;
    models.push({ value, name });
    if (models.length >= MAX_MODELS) break;
  }
  return {
    models,
    current: typeof data?.current === 'string' ? data.current.slice(0, 200) : '',
    needsStart: data?.needsStart === true || (!models.length && data?.needsStart !== false),
  };
}

/** `provider/model` → provider (models without a prefix share one group). */
export const providerOf = (value) => (value.includes('/') ? value.slice(0, value.indexOf('/')) : 'lainnya');

/**
 * The models matching `query` (every word must appear in the value or the name, case-insensitive), grouped by
 * provider in first-seen order: `[{ provider, models }]`.
 */
export function groupModels(models, query = '') {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map();
  for (const m of models) {
    const hay = `${m.value} ${m.name}`.toLowerCase();
    if (words.some((w) => !hay.includes(w))) continue;
    const p = providerOf(m.value);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(m);
  }
  return [...groups].map(([provider, list]) => ({ provider, models: list }));
}
