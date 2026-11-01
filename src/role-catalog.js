// The built-in role catalog: the only roles a team can be assembled from (no free-form roles).
// One source of truth for ids, default names/titles, descriptions, the fallback chain of each role,
// the matching signals of the four optional roles, and the Lead's team prompt.
//
// The Lead (`claude`) is not in the catalog: it always exists. `freelancer` is locked on too — it is the
// generalist every fallback chain ends at (unknown/general-purpose subagents), so subagent work never
// lands on the Lead's desk (the Lead is the main thread only).

export const LEAD_ID = 'claude';
export const MAX_ACTIVE_ROLES = 16;
/** Roles that cannot be switched off (besides the Lead, which is not in the list at all). */
export const LOCKED_ROLES = Object.freeze(['freelancer']);
/** Terminal of every fallback chain. */
export const GENERALIST = 'freelancer';

/**
 * Catalog order = the team strip order. `fallback`: who takes the role's work while it is switched off
 * (tried in order, recursively; GENERALIST and then the Lead close every chain). `lead`: the line the Lead's
 * system prompt uses for the role (roles without an agent file — the freelancer — have none).
 * `signals` (optional roles only): agent-type / file / command / MCP patterns, consulted only while active.
 */
const ENTRIES = [
  { id: 'pm', name: 'Adhit - PM', title: 'Product Manager', description: 'Scope, prioritas, acceptance criteria, pecah pekerjaan jadi task.', fallback: ['ba', 'architect'], lead: 'scope, priorities, acceptance criteria, task breakdown' },
  { id: 'ba', name: 'Adhit - BA', title: 'Business Analyst', description: 'Kebutuhan, aturan bisnis, analisis kode & dokumen yang ada.', fallback: ['pm', 'architect'], lead: 'requirements, business rules, analysis of existing code and documents' },
  { id: 'architect', name: 'Adhit - Tech Lead', title: 'Tech Lead / Architect', description: 'Desain teknis, keputusan arsitektur, review diff.', fallback: ['backend'], lead: 'technical design, architecture decisions, code review of diffs' },
  { id: 'ui-ux', name: 'Adhit - UI/UX', title: 'UI/UX Designer', description: 'Alur pengguna, desain UI, styling, aksesibilitas.', fallback: ['frontend'], lead: 'user flows, UI design, styling, accessibility' },
  { id: 'frontend', name: 'Adhit - Frontend', title: 'Frontend Developer', description: 'Implementasi UI: komponen, halaman, state di client.', fallback: ['ui-ux', 'backend'], lead: 'UI implementation (components, pages, client state)' },
  { id: 'backend', name: 'Adhit - Backend', title: 'Backend Developer', description: 'API, logika bisnis, integrasi, perbaikan di server.', fallback: ['frontend'], lead: 'APIs, business logic, integrations, server-side fixes' },
  { id: 'dba', name: 'Adhit - DBA', title: 'Database Engineer', description: 'Skema, migrasi, query, perbaikan data, performa database.', fallback: ['backend'], lead: 'schema, migrations, queries, data fixes, database performance' },
  { id: 'qa', name: 'Adhit - QA', title: 'QA Engineer', description: 'Rencana test, test otomatis, reproduksi bug, verifikasi.', fallback: ['backend'], lead: 'test plans, automated tests, bug reproduction, verification' },
  { id: 'security', name: 'Adhit - Security', title: 'Security Engineer', description: 'Security review, kerentanan, secret, audit dependency.', fallback: ['reviewer', 'architect'], lead: 'security review, vulnerabilities, secrets, dependency audit' },
  { id: 'devops', name: 'Adhit - DevOps', title: 'DevOps / SRE', description: 'Build, CI/CD, Docker, deployment, environment & konfigurasi.', fallback: ['backend'], lead: 'build, CI/CD, Docker, deployment, environment and config issues' },
  { id: 'writer', name: 'Adhit - Writer', title: 'Technical Writer', description: 'README, dokumentasi API, changelog, panduan pengguna.', fallback: ['ba'], lead: 'README, API docs, changelog, user guides' },
  { id: 'freelancer', name: 'Adhit - Freelancer', title: 'Freelancer / Generalist', description: 'Generalis untuk subagent yang bukan spesialis (general-purpose, fork, tipe kustom). Selalu aktif.', fallback: [], lead: null },
  {
    id: 'mobile', name: 'Adhit - Mobile', title: 'Mobile Developer', description: 'Aplikasi mobile (Flutter, React Native, Android/iOS), build & bug khusus perangkat.', fallback: ['frontend'], optional: true,
    lead: 'mobile apps (Flutter, React Native, Android/iOS), device-specific bugs, app builds',
    signals: {
      agent: /\b(mobile|flutter|android|ios|react-native|swift|swiftui|kotlin|dart|expo|xamarin)\b/,
      file: /\.(dart|swift|kt|kts|xib|storyboard|xcodeproj|pbxproj|gradle)$|(^|[\\/])(android|ios)[\\/]|(^|[\\/])(pubspec\.yaml|Podfile|AndroidManifest\.xml|Info\.plist)$/i,
      command: /\b(flutter|xcodebuild|xcrun|gradlew|adb|pod install|fastlane|expo|react-native|eas build)\b/i,
    },
  },
  {
    id: 'data', name: 'Adhit - Data/AI', title: 'Data / AI Engineer', description: 'Pipeline data, analitik, notebook, fitur ML/AI (LLM, embedding, RAG).', fallback: ['backend', 'dba'], optional: true,
    lead: 'data pipelines, analytics, notebooks, ML/AI features (LLM, embeddings, RAG), data quality',
    signals: {
      agent: /\b(data-engineer|data-scientist|data-analyst|data-science|ml|mlops|machine-learning|ai|ai-engineer|analytics|notebook|jupyter|llm|embedding|embeddings|rag|etl|dbt|airflow)\b/,
      file: /\.(ipynb|parquet|feather|avro|orc)$|(^|[\\/])(notebooks?|dbt|airflow|dags)[\\/]|(^|[\\/])dbt_project\.yml$/i,
      command: /\b(jupyter|nbconvert|papermill|dbt|airflow|spark-submit|mlflow)\b/i,
    },
  },
  {
    id: 'support', name: 'Adhit - Support', title: 'Tech Support / Ops Helpdesk', description: 'Triage laporan user, reproduksi dari log, respons awal insiden, jawaban helpdesk.', fallback: ['qa', 'ba'], optional: true,
    lead: 'triage of user reports, reproducing issues from logs, first incident response, helpdesk answers',
    signals: {
      agent: /\b(support|helpdesk|help-desk|triage|triager|incident|incident-responder|repro|reproducer|on-call|oncall|customer-support|ticket)\b/,
      mcp: /zendesk|intercom|freshdesk|helpscout|pagerduty|opsgenie|statuspage/,
    },
  },
  {
    id: 'reviewer', name: 'Adhit - Reviewer', title: 'Code Reviewer', description: 'Review kode independen atas diff: kebenaran, keterbacaan, test.', fallback: ['architect'], optional: true,
    lead: 'independent code review of diffs (correctness, readability, tests) before work is done',
    signals: {
      agent: /\b(review|reviewer|code-reviewer|pr-review|pr-reviewer|code-review)\b/,
      command: /\bgh pr (review|diff|checks)\b/i,
    },
  },
];

// agentFile: the subagent template in .claude/agents (sent with --agents while the role is on).
export const ROLE_CATALOG = Object.freeze(ENTRIES.map((r) => Object.freeze({ ...r, agentFile: r.lead ? `${r.id}.md` : null })));

export const CATALOG = Object.freeze(Object.fromEntries(ROLE_CATALOG.map((r) => [r.id, r])));
export const CATALOG_IDS = Object.freeze(ROLE_CATALOG.map((r) => r.id));
/** The team before the catalog existed: every role except the four optional ones (kept for the Lead prompt and regression checks). */
export const CLASSIC_TEAM = Object.freeze(ROLE_CATALOG.filter((r) => !r.optional).map((r) => r.id));
/** Default team (never saved / reset): the whole catalog — all 16 roles on. */
export const DEFAULT_ENABLED = Object.freeze([...CATALOG_IDS]);

/** A team setting the user sent that cannot be accepted (shown as-is, HTTP 400). */
export class TeamConfigError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * Validates a submitted list of active role ids: catalog ids only, the Lead never in it, at most
 * MAX_ACTIVE_ROLES. Duplicates are dropped, locked roles are always added; returned in catalog order.
 */
export function normalizeEnabled(input) {
  if (!Array.isArray(input)) throw new TeamConfigError('Daftar role aktif (enabled) harus berupa array ID role.');
  const wanted = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') throw new TeamConfigError('ID role harus berupa teks.');
    const id = raw.trim();
    if (id === LEAD_ID) throw new TeamConfigError('Lead (claude) selalu ada dan tidak boleh dimasukkan ke daftar role.');
    if (!Object.hasOwn(CATALOG, id)) throw new TeamConfigError(`Role "${id.slice(0, 40)}" tidak ada di katalog role bawaan.`);
    wanted.add(id);
  }
  for (const id of LOCKED_ROLES) wanted.add(id);
  if (wanted.size > MAX_ACTIVE_ROLES) throw new TeamConfigError(`Maksimal ${MAX_ACTIVE_ROLES} role aktif.`);
  return CATALOG_IDS.filter((id) => wanted.has(id));
}

/** The stored team (state.json `team.enabled`), or the default team when missing or no longer valid. */
export function storedEnabled(team) {
  try {
    return normalizeEnabled(team?.enabled);
  } catch {
    return [...DEFAULT_ENABLED];
  }
}

/**
 * Who does `role`'s work in a team where only `active` (Set of ids) is on: the role itself, else the first
 * active role along its fallback chain (depth-first), else the generalist, else the Lead.
 */
export function resolveRole(role, active) {
  if (!role || role === LEAD_ID || active.has(role)) return role;
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return null;
    seen.add(id);
    for (const next of CATALOG[id]?.fallback ?? []) {
      if (active.has(next)) return next;
      const deeper = walk(next);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(role) ?? (active.has(GENERALIST) ? GENERALIST : LEAD_ID);
}

/** The catalog as the browser gets it (no RegExps). */
export const publicCatalog = () =>
  ROLE_CATALOG.map(({ id, name, title, description, fallback, optional }) => ({ id, name, title, description, fallback, optional: Boolean(optional), locked: LOCKED_ROLES.includes(id) }));

/** Only the active roles' subagent definitions go to `claude --agents`. */
export function activeAgents(all, enabled) {
  return Object.fromEntries(enabled.filter((id) => all[id]).map((id) => [id, all[id]]));
}

const DEFAULT_FLOWS = [
  '- New feature: pm → ba → architect → ui-ux → frontend/backend/dba → qa → security (when auth, input or data is touched) → writer.',
  '- Bug fix: qa reproduces it (ideally a failing test) → the owning frontend/backend/dba fixes the root cause → architect reviews the diff → qa verifies.',
  '- Build/deploy/incident: devops first, then backend or dba as needed, qa verifies.',
];
const OPTIONAL_FLOWS = {
  mobile: '- Mobile app work: mobile builds the app side, backend the API it calls, qa verifies on a device/emulator build.',
  data: '- Data/AI work: data designs the pipeline, analysis or model integration; dba owns the schema, backend serves it, qa verifies.',
  support: '- A user-reported problem or incident: support triages it and reproduces it from logs first, then hands the owning developer a clear report.',
  reviewer: '- Before code work is reported done: reviewer reviews the diff (architect stays on design decisions).',
};

/**
 * The Lead's system prompt (`--append-system-prompt`): the roles of THIS team and how work flows between them.
 * With the classic 12-role team it is the prompt the app always had.
 */
export function teamPrompt(enabled, agentNames = enabled) {
  const on = new Set(enabled);
  const hasAgent = new Set(agentNames);
  const roles = ROLE_CATALOG.filter((r) => on.has(r.id) && r.lead && hasAgent.has(r.id)).map((r) => `- ${r.id}: ${r.lead}`);
  const flows = [...DEFAULT_FLOWS, ...ROLE_CATALOG.filter((r) => r.optional && on.has(r.id)).map((r) => OPTIONAL_FLOWS[r.id])];
  const missing = CLASSIC_TEAM.some((id) => !on.has(id));
  return [
    'You are the Engineering Lead of an IT team that the user watches live in the "Adhit Office" pixel office.',
    'Delegate focused work to the specialist subagents with the Agent tool, but only to the roles a task actually needs:',
    'each delegation costs time and tokens, so do small or trivial work yourself.',
    ...roles,
    'Typical flows:',
    ...flows,
    ...(missing ? ['Only the roles listed above are on this team: when a flow names a role that is not listed, give that step to the closest listed role or do it yourself.'] : []),
    "Run independent pieces in parallel when they do not touch the same files. Reply in the user's language.",
  ].join('\n');
}
