// 🛡️ Preset izin: one-click allow presets for the 🛡 Aturan izin dialog — "Paket & test" and
// "Kerja penuh" pre-approve the safe categories once from the laptop so remote sessions rarely ask.
// Pure data + planning: no DOM, no fetch (also imported by test/permissions.test.mjs).
//
// The dialog applies a preset by writing its rules as REAL allow rules through the same add API as a
// hand-typed rule (same validation, same audit) — only list `allow`, never deny/ask, never removing.
//
// Claude Code evaluates rules deny → ask → allow across every settings file, first match wins, so an
// allow the preset wants to add is dead weight when a deny or ask rule — in ANY file — already shares
// a command with it. planPreset() marks those so the dialog can show why and skip instead of writing
// rules the merge would ignore (a user deny catch-all like `Bash` always wins).

const PRESET_LISTS = ['deny', 'ask', 'allow'];

/** The presets, in dialog order. Patterns are Claude Code's own: `Tool`, `Tool(exact)`, `Tool(prefix*)`. */
export const PERMISSION_PRESETS = [
  {
    id: 'paket-test',
    label: '📦 Paket & test',
    hint: 'npm/npx/pnpm/bun dan git harian jalan tanpa bertanya',
    rules: [
      'Bash(npm *)', 'Bash(npx *)', 'Bash(pnpm *)', 'Bash(bun *)',
      'Bash(git status*)', 'Bash(git add*)', 'Bash(git commit*)', 'Bash(git push*)',
      'Bash(git pull*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git branch*)',
    ],
  },
  {
    id: 'kerja-penuh',
    label: '💼 Kerja penuh',
    hint: 'Paket & test plus Edit/Write/Read — sikap ⚡ Auto sebagai aturan',
    rules: null, // filled below from PAKET_RULES
  },
];

const PAKET_RULES = PERMISSION_PRESETS[0].rules;
PERMISSION_PRESETS[1].rules = [...PAKET_RULES, 'Edit', 'Write', 'Read'];

// `Tool` or `Tool(pattern)` — the same shape src/permissions.js validates. Stored rules may predate
// that format check, so anything that does not split simply covers nothing.
const splitRule = (rule) => {
  const m = String(rule).trim().match(/^([A-Za-z][\w-]*)(?:\((.*)\))?$/);
  return m ? { tool: m[1], pattern: m[2] ?? null } : null;
};

/** A pattern text as a glob: `*` matches anything, every other regex metacharacter is literal. */
const patternRe = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

/**
 * Every command `candidate` matches is already covered by the allow rule `existing`
 * (same tool): a bare tool covers the whole tool, a `prefix*` pattern covers candidates
 * inside its prefix, an exact pattern covers only itself. A narrower existing allow
 * (Bash(npm install *)) does NOT cover a broader candidate (Bash(npm *)) — that one is still worth adding.
 */
const alreadyAllowed = (existing, candidate) => {
  const e = splitRule(existing), c = splitRule(candidate);
  if (!e || !c || e.tool !== c.tool) return false;
  if (e.pattern == null) return true;
  if (c.pattern == null) return false;
  if (e.pattern === c.pattern) return true;
  if (!e.pattern.endsWith('*')) return false; // exact text vs anything else: only equality covers
  const prefix = e.pattern.slice(0, -1);
  return (c.pattern.endsWith('*') ? c.pattern.slice(0, -1) : c.pattern).startsWith(prefix);
};

/**
 * A deny/ask rule `existing` masks an allow `candidate` when the two share even one command:
 * deny → ask → allow, first match wins, so the prompt/denial happens before the new allow is
 * ever reached. A bare tool on either side shares every command of that tool.
 */
const blockedAnyway = (existing, candidate) => {
  const e = splitRule(existing), c = splitRule(candidate);
  if (!e || !c || e.tool !== c.tool) return false;
  if (e.pattern == null || c.pattern == null) return true;
  if (e.pattern === c.pattern) return true;
  if (patternRe(e.pattern).test(c.pattern) || patternRe(c.pattern).test(e.pattern)) return true;
  if (!e.pattern.endsWith('*') || !c.pattern.endsWith('*')) return false;
  const pe = e.pattern.slice(0, -1), pc = c.pattern.slice(0, -1);
  return pe.startsWith(pc) || pc.startsWith(pe);
};

/**
 * Maps a preset's rules onto what writing them would do, given the scopes as readPermissions
 * returned them: [{ scope, rules: { allow, deny, ask } }, …]. One entry per rule, in preset order:
 *   { rule, status: 'add' }                              — would be a real new allow
 *   { rule, status: 'deny' | 'ask' | 'allow', via }      — skipped; via = { list, rule, scope }
 * 'allow' includes the exact rule already stored, so applying twice adds nothing (idempotent).
 */
export function planPreset(rules, scopes = []) {
  const stored = scopes.flatMap((s) =>
    PRESET_LISTS.flatMap((list) => (s.rules?.[list] ?? []).map((rule) => ({ list, rule, scope: s.scope }))));
  return rules.map((rule) => {
    const masks = (list) => stored.find((e) => e.list === list && blockedAnyway(e.rule, rule));
    const hit = masks('deny') ?? masks('ask')
      ?? stored.find((e) => e.list === 'allow' && alreadyAllowed(e.rule, rule));
    return hit ? { rule, status: hit.list, via: hit } : { rule, status: 'add' };
  });
}
