// Which engine runs a project (Claude Code / OpenCode) and what it can do (docs/design-opencode.md §6, D10).
// Pure: no DOM, no state. The UI asks `capsFor(config, engine)` instead of branching on engine names, so a
// feature an engine lacks is hidden or disabled in one way everywhere, with the reason from `capReason`.

export const DEFAULT_ENGINE = 'claude';

/**
 * True for any engine-change event (app-wide or one project). Chat/activity/history caches belong to the old
 * engine, so every open client must reload into the server's new snapshot; two windows must never diverge.
 */
export const engineChangeNeedsReload = (data) => Boolean(data && typeof data === 'object' && (data.project || data.engine));

/** Display names; an engine the server adds later still shows (its id) without a code change. */
export const ENGINE_LABEL = { claude: 'Claude Code', opencode: 'OpenCode' };

/** Short badge labels (session bar): compact enough for a phone. */
export const ENGINE_BADGE = { claude: '✳ Claude', opencode: '⌘ OpenCode' };

/** The faint one-character mark on a chat row: shown only when the engine changes in the timeline. */
export const ENGINE_MARK = { claude: '✳', opencode: '▢' };

export const ALL_MODES = ['build', 'plan'];

/** Legacy/unknown values from an older server or state read as Build; Plan remains Plan. */
export const normalizeMode = (mode) => (mode === 'plan' ? 'plan' : 'build');

/** Everything on: what Claude Code supports, and the safe default for a server without `config.engines`. */
export const CLAUDE_CAPS = Object.freeze({
  effort: true,
  team: true,
  rewind: true,
  mcp: true,
  bgTasks: true,
  askQuestion: true,
  exportSession: true,
  permissions: true,
  extensions: true,
  search: true,
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
  exportSession: 'export sesi lengkap Claude Code (pakai Export percakapan)',
  permissions: 'aturan izin Claude Code',
  extensions: 'pengelolaan ekstensi Claude Code',
  search: 'pencarian percakapan',
  mirror: 'mirror sesi terminal',
};

/**
 * Claude-only surfaces get a message that says where the same thing lives for the active engine.
 * No trailing period: callers (guardCap) add one.
 */
const CAP_REASON = {
  permissions: 'Aturan izin Claude Code hanya tersedia saat mesin Claude Code aktif; OpenCode memakai aturan di opencode.json',
  extensions: 'Ekstensi Claude Code hanya tersedia saat mesin Claude Code aktif; OpenCode memakai plugin dan agent di opencode.json',
  exportSession: 'Export sesi lengkap Claude Code hanya tersedia saat mesin Claude Code aktif; pakai Export percakapan atau export JSON di Riwayat Sesi',
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cleanId = (v) => (typeof v === 'string' && /^[a-z][\w-]{0,31}$/.test(v) ? v : null);

export const engineLabel = (engine) => ENGINE_LABEL[engine] ?? String(engine ?? DEFAULT_ENGINE);

/** A compact badge label: "✳ Claude" / "⌘ OpenCode"; an engine the server adds later shows its own name. */
export const engineBadge = (engine) => ENGINE_BADGE[engine] ?? engineLabel(engine);

/** The one-character mark a timeline row uses when its engine differs from the previous message. */
export const engineMark = (engine) => ENGINE_MARK[engine] ?? '▢';

/**
 * The engine a project runs on. The engine follows the model picked in Pengaturan giliran: the project status
 * (`status.engine`) is set from that choice, and `config.engine` is only the DEFAULT for new projects, so it is the
 * fallback for older servers (and for a project without a status yet: never opened this run — it must still show the
 * default engine's models and modes). Anything missing or malformed is Claude Code.
 */
export function engineOf(status, config) {
  return cleanId(status?.engine) ?? cleanId(config?.engine) ?? DEFAULT_ENGINE;
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
  const rawModes = Array.isArray(raw.modes) ? raw.modes : [];
  const modes = ALL_MODES.filter((m) => rawModes.map(normalizeMode).includes(m));
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

/** Why a control is off: a Claude-only feature gets its own hint, other caps the generic reason. */
export function capReason(cap, engine) {
  return CAP_REASON[cap] ?? `${engineLabel(engine)} belum mendukung ${CAP_FEATURE[cap] ?? cap}`;
}

/** A stored mode the engine doesn't offer is shown as the first mode it does offer (always Build or Plan). */
export function modeFor(mode, caps) {
  const modes = caps?.modes ?? CLAUDE_CAPS.modes;
  const wanted = normalizeMode(mode);
  return modes.includes(wanted) ? wanted : modes.includes('build') ? 'build' : modes[0];
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

/**
 * The picker's OpenCode section: one group per provider (first-seen order, the search filter still applied), each
 * label the provider's display name when known (custom providers, e.g. "River AI") and the id otherwise. Empty
 * input yields no groups — the renderer shows its own info line instead.
 */
export function openCodeProviderGroups(models, query = '', providerNames = {}) {
  return groupModels(models, query).map((g) => ({ ...g, label: providerNames?.[g.provider] ?? g.provider }));
}
