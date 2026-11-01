// Maps Claude Code agents/tools onto the office roles, plus human-readable tool labels.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CATALOG, CATALOG_IDS, DEFAULT_ENABLED, GENERALIST, resolveRole } from './role-catalog.js';
import { basename, truncate } from './util.js';

// Every role a team can have (src/role-catalog.js). `freelancer` is the generalist at the spare desk: any
// subagent type that is not a specialist.
export const ROLE_IDS = CATALOG_IDS;

// The active team (👥 Kelola tim). Every role this module hands out is one of these, or the Lead (`claude`):
// a switched-off role's work goes along its fallback chain (resolveRole in src/role-catalog.js). The optional
// roles' own patterns are only consulted while they are on, so with them off every mapping is exactly what
// it was before they existed.
const team = { active: new Set(DEFAULT_ENABLED) };

/** Sets the active roles (ids already validated by normalizeEnabled). */
export function setActiveRoles(ids) {
  team.active = new Set(ids);
}

export const activeRoles = () => CATALOG_IDS.filter((id) => team.active.has(id));
const resolve = (role) => resolveRole(role, team.active);
/** An optional role's own pattern of one kind (agent / file / command / mcp), only while that role is on. */
const signal = (role, kind) => (team.active.has(role) ? CATALOG[role].signals?.[kind] : null);

// Built-in agent types whose name alone would be misread by the patterns below.
const AGENT_ALIASES = {
  plan: 'architect', // "Plan" designs the implementation — a tech lead job
  'general-purpose': 'freelancer',
  fork: 'freelancer',
  claude: 'freelancer',
};

/** Role for a subagent type; unknown types are the freelancer, never silently "backend". */
export const agentRole = (agentType) => toRole(agentType ?? 'general-purpose') ?? resolve(GENERALIST);

// Agent type → role. Ordered: first match wins ("code-reviewer" is architect, not backend;
// "frontend-developer" is frontend; "claude-code-guide" is writer). A `null` pattern is an optional
// role's own pattern (catalog `signals.agent`), skipped while that role is off.
const ROLE_PATTERNS = [
  [/\b(security|sec|pentest|pentester|appsec|vuln|vulnerability|audit|auditor)\b/, 'security'],
  [/\b(devops|sre|ops|infra|infrastructure|deploy|deployer|cicd|ci|release|platform|statusline-setup)\b/, 'devops'],
  [null, 'data'], // data-engineer, ml, llm… (before dba, whose pattern also has "data")
  [/\b(dba|db|database|sql|data|migration|migrator|schema)\b/, 'dba'],
  [/\b(writer|docs?|documentation|documenter|technical-writer|changelog|guide)\b/, 'writer'],
  [/\b(qa|test|tests|tester|testing|verify|verifier|e2e)\b/, 'qa'],
  [null, 'support'],
  [null, 'reviewer'], // review, code-reviewer… (while it is off, the architect below takes them, as before)
  [/\b(architect|architecture|arch|tech-lead|techlead|lead|review|reviewer|code-reviewer)\b/, 'architect'],
  [/\b(ui|ux|uiux|ui-ux|design|designer)\b/, 'ui-ux'],
  [null, 'mobile'], // flutter, android, ios… (before frontend, whose pattern also has "mobile")
  [/\b(frontend|front-end|fe|web|react|vue|nuxt|next|angular|mobile)\b/, 'frontend'],
  [/\b(backend|back-end|be|api|server|developer|dev|engineer|coder|code|general|fullstack|build|fix|fixer|implement)\b/, 'backend'],
  [/\b(ba|analyst|analysis|explore|explorer|research|researcher)\b/, 'ba'],
  [/\b(pm|plan|planner|planning|product|project|manager|scrum|owner)\b/, 'pm'],
];

// `(^|[\\/])dir[\\/]` matches a folder name in both relative and absolute paths.
const TEST_FILE = /[._-](test|spec)s?\.[a-z0-9]+$|(^|[\\/])(__tests__|tests?|specs?|e2e|cypress|playwright)[\\/]/i;
const TEST_CLASS = /[a-z0-9](Test|Tests|Spec)\.[A-Za-z]+$/; // LoginTest.php, UserServiceTests.cs
const DOC_FILE = /\.(md|mdx|txt|rst|adoc|pdf|docx)$|(^|[\\/])docs?[\\/]|(^|[\\/])(README|CHANGELOG|CONTRIBUTING)[^\\/]*$/i;
const DB_FILE = /\.(sql|prisma|dbml)$|(^|[\\/])(migrations?|seeders?|seeds|schema)[\\/]|knexfile|ormconfig|alembic|schema\.(rb|ts|js)$/i;
const OPS_FILE = /dockerfile|docker-compose|\.dockerignore|\.tf$|(^|[\\/])\.github[\\/]|\.gitlab-ci|jenkinsfile|nginx|(^|[\\/])(k8s|helm)[\\/]|ecosystem\.config|(^|[\\/])\.env(\.|$)|\.(ya?ml)$/i;
const STYLE_FILE = /\.(css|scss|sass|less|svg)$|tailwind\.config|(^|[\\/])(styles?|design|tokens|themes?)[\\/]/i;
const FRONTEND_FILE = /\.(tsx|jsx|vue|svelte|html|astro)$|\.blade\.php$|(^|[\\/])(components|pages|views|layouts|composables|hooks|stores?|public|assets)[\\/]/i;

// A `null` pattern is an optional role's own one (catalog `signals.command`), skipped while that role is off.
const COMMAND_ROLES = [
  [/\b(npm audit|yarn audit|pnpm audit|composer audit|snyk|trivy|semgrep|gitleaks|osv-scanner|bandit|safety check)\b/i, 'security'],
  [/\b(test|tests|jest|vitest|pytest|playwright|cypress|mocha|phpunit|pest|coverage|lint|eslint|tsc|ruff|flake8|phpstan|pint)\b/i, 'qa'],
  [null, 'mobile'],
  [null, 'data'],
  [/\b(psql|mysql|mysqldump|sqlite3|mongosh?|redis-cli|migrate|migration|prisma|sequelize|knex|alembic|flyway|db:seed|typeorm)\b/i, 'dba'],
  [/\b(docker|docker-compose|kubectl|helm|terraform|ansible|deploy|ssh|scp|rsync|nginx|pm2|systemctl|vercel|netlify|gcloud|aws|az|gh run|gh workflow)\b|\bgit push\b|\b(build|webpack|vite build|next build|nuxt build)\b/i, 'devops'],
  [null, 'reviewer'],
  [/\bgit\s+(diff|log|blame|show|status)\b|\bgh pr\b/i, 'architect'],
];

/** First role whose pattern matches `text`; a `null` pattern is the optional role's own `kind` pattern while it is on. */
function matchRole(table, kind, text) {
  for (const [own, role] of table) {
    const pattern = own ?? signal(role, kind);
    if (pattern?.test(text)) return role;
  }
  return null;
}

// ---- shell command analysis: judge each command in a chain by its verb, not by stray keywords ----

// Read-only inspection (reading/searching code) — what the Grep/Glob tools also do.
const INSPECT_VERBS = new Set([
  'grep', 'rg', 'egrep', 'fgrep', 'sed', 'cat', 'head', 'tail', 'less', 'more', 'ls', 'dir', 'tree', 'find', 'wc', 'awk',
  'diff', 'cmp', 'stat', 'file', 'jq', 'xxd', 'strings', 'select-string', 'get-content', 'gc', 'get-childitem', 'gci', 'type',
]);
// Machine / process / network housekeeping.
const OPS_VERBS = new Set([
  'ps', 'kill', 'pkill', 'killall', 'lsof', 'netstat', 'ss', 'top', 'htop', 'df', 'du', 'free', 'uptime', 'ping', 'nslookup',
  'dig', 'traceroute', 'tracert', 'ipconfig', 'ifconfig', 'tailscale', 'schtasks', 'sc', 'service', 'tasklist', 'taskkill',
  'get-process', 'stop-process', 'start-process', 'get-service', 'restart-service', 'get-nettcpconnection', 'test-netconnection',
  'netsh', 'new-netfirewallrule', 'get-netfirewallrule', 'chmod', 'chown', 'crontab', 'apt', 'apt-get', 'brew', 'winget', 'choco', 'scoop',
]);
// Hitting a running app to see whether it answers correctly.
const HTTP_VERBS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);
const INSTALL = /^(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|uninstall|update|upgrade)\b|^(pip3?|uv|poetry)\s+(install|add|remove|uninstall)\b|^composer\s+(install|require|update|remove)\b|^(go\s+get|cargo\s+add|gem\s+install|bundle(\s+install)?$)/i;
const SYNTAX_CHECK = /^(node\s+--check|php\s+-l|python3?\s+-m\s+py_compile|bash\s+-n)\b/i;
// Leading noise that is not the command itself: `S=/x;`, `OFFICE_PORT=1 node …`, `$p = …`, `cd x &&`, `do …`.
const SKIP_SEGMENT = /^(cd|pushd|popd|set-location|sl|echo|printf|write-host|write-output|export|set|source|\.|true|false|done|fi|esac|then|else|\{|\})(\s|$)|^\$?[A-Za-z_][\w]*\s*=/i;
const LEADING_NOISE = /^((sudo|time|nohup|npx|exec|env|do|then|&)\s+|[A-Za-z_]\w*=("[^"]*"|'[^']*'|\S*)\s+)+/i;

/** Splits a shell line into its commands (`a && b | c; d`), dropping setup noise like `cd` and assignments. */
function commandSegments(command) {
  return String(command)
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim().replace(LEADING_NOISE, '').replace(/^["']|["']$/g, ''))
    .filter((s) => s && !SKIP_SEGMENT.test(s));
}

/** Role for a single command, or 'inspect' for read-only looking around, or null when it says nothing. */
function segmentRole(raw) {
  // `/c/php83/php.exe -l x` → `php -l x`, so full program paths are judged like bare names.
  const [first, ...args] = raw.split(/\s+/);
  const verb = first.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
  const segment = [verb, ...args].join(' ');
  if (INSPECT_VERBS.has(verb) && !(verb === 'sed' && /\s-i\b/.test(segment))) return 'inspect';
  if (verb === 'git') {
    // Judge git by its subcommand only — a commit message mentioning "tests" is not running tests.
    const sub = segment.split(/\s+/).find((w, i) => i > 0 && !w.startsWith('-')) ?? '';
    if (sub === 'push') return 'devops';
    if (/^(diff|log|blame|show|status)$/.test(sub)) return 'architect';
    if (/^(ls-files|ls-tree|grep)$/.test(sub)) return 'inspect';
    return 'backend';
  }
  if (INSTALL.test(segment)) return 'devops'; // dependencies are DevOps' job, even `pip install pytest`
  const known = matchRole(COMMAND_ROLES, 'command', segment);
  if (known) return known;
  if (OPS_VERBS.has(verb)) return 'devops';
  if (HTTP_VERBS.has(verb)) return /\s(-o|-O|--output|-OutFile)\b/.test(segment) ? 'devops' : 'qa';
  if (SYNTAX_CHECK.test(segment)) return 'qa';
  return null;
}

/** Office role (in the active team) of a subagent type; null when its name says nothing. */
export function toRole(agentType) {
  if (!agentType) return null;
  const key = String(agentType).toLowerCase().trim();
  if (ROLE_IDS.includes(key)) return resolve(key);
  if (AGENT_ALIASES[key]) return resolve(AGENT_ALIASES[key]);
  const role = matchRole(ROLE_PATTERNS, 'agent', key);
  return role ? resolve(role) : null;
}

/** Who owns a file, judged by its path. `reading` sends docs to the analyst instead of the writer. */
function fileRole(file, reading) {
  if (!file) return reading ? 'architect' : 'backend';
  if (TEST_FILE.test(file) || TEST_CLASS.test(file)) return 'qa';
  if (DOC_FILE.test(file)) return reading ? 'ba' : 'writer';
  // Optional roles' files, only while on: *.dart / android/ / ios/ → mobile; *.ipynb / dbt/ / airflow → data.
  if (signal('mobile', 'file')?.test(file)) return 'mobile';
  if (signal('data', 'file')?.test(file)) return 'data';
  if (DB_FILE.test(file)) return 'dba';
  if (OPS_FILE.test(file)) return 'devops';
  if (STYLE_FILE.test(file)) return 'ui-ux';
  if (FRONTEND_FILE.test(file)) return 'frontend';
  return 'backend';
}

/**
 * Who would run this shell line. The first command that reveals an intent (test, deploy, migrate…)
 * decides; a line that only reads/searches is the tech lead investigating (QA when it reads tests).
 */
function classifyCommand(command = '') {
  let inspected = null;
  for (const segment of commandSegments(command)) {
    const role = segmentRole(segment);
    if (role === 'inspect') inspected ??= segment;
    else if (role) return { role, readOnly: false };
  }
  if (!inspected) return { role: 'backend', readOnly: false };
  const readsTests = inspected.split(/\s+/).some((arg) => TEST_FILE.test(arg.replace(/["']/g, '')));
  return { role: readsTests ? 'qa' : 'architect', readOnly: true };
}

const commandRole = (command) => classifyCommand(command).role;

// MCP server name (mcp__<server>__<tool>) → role. Browser automation is UI testing.
const MCP_ROLES = [
  [/chrome|browser|playwright|puppeteer|selenium/, 'qa'],
  [/postgres|mysql|sqlite|supabase|mongo|redis|bigquery|snowflake|database|\bdb\b|prisma/, 'dba'],
  [/figma|canva|design/, 'ui-ux'],
  [/docs|notion|confluence|drive|sheets|slides|word|gmail|outlook|calendar|slack/, 'writer'],
  [/sentry|datadog|grafana|vercel|netlify|cloudflare|aws|gcp|azure|docker|kubernetes|k8s/, 'devops'],
  [/github|gitlab|bitbucket/, 'architect'],
  [/jira|linear|asana|trello|monday|clickup/, 'pm'],
  [/context7|search|research|pubmed|consensus/, 'ba'],
];

function mcpRole(tool) {
  const server = tool.split('__')[1]?.toLowerCase() ?? '';
  if (signal('support', 'mcp')?.test(server)) return 'support';
  for (const [pattern, role] of MCP_ROLES) if (pattern.test(server)) return role;
  return 'claude';
}

/** Guess who in the office would do this tool call when no subagent is involved: an active role or the Lead. */
export const inferRole = (tool, input = {}) => resolve(ownerOf(tool, input));

/** The role that owns a tool call, before the active team is applied. */
function ownerOf(tool, input) {
  switch (tool) {
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return 'pm';
    case 'Read':
      return fileRole(input.file_path, true);
    case 'Grep':
    case 'Glob':
      return 'architect';
    case 'WebFetch':
    case 'WebSearch':
      return 'ba';
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return fileRole(input.file_path ?? input.notebook_path, false);
    case 'Bash':
    case 'PowerShell':
      return commandRole(input.command);
    case 'Artifact':
      return 'ui-ux'; // a published page / report is design work
    default:
      // Coordination tools (AskUserQuestion, Skill, ToolSearch, TaskStop…) stay with Claude, the lead.
      return tool.startsWith('mcp__') ? mcpRole(tool) : 'claude';
  }
}

const ROLE_SCREEN = { qa: 'tests', dba: 'db', devops: 'pipeline', security: 'security', architect: 'review', reviewer: 'review', writer: 'doc', ba: 'doc', 'ui-ux': 'design' };
// Shell lines that only read/search show the search screen, like Grep does.
const shellScreen = (command) => {
  const { role, readOnly } = classifyCommand(command);
  return readOnly ? 'search' : (ROLE_SCREEN[role] ?? 'terminal');
};

/** Which kind of content the worker's monitor shows for this tool. */
export function screenFor(tool, input = {}) {
  switch (tool) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return ROLE_SCREEN[fileRole(input.file_path ?? input.notebook_path, false)] ?? 'code';
    case 'Read':
      return DOC_FILE.test(input.file_path ?? '') ? 'doc' : 'code';
    case 'Grep':
    case 'Glob':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'browser';
    case 'Bash':
    case 'PowerShell':
      return shellScreen(input.command);
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'ExitPlanMode':
      return 'kanban';
    case 'Artifact':
      return 'design';
    default:
      if (tool.startsWith('mcp__')) {
        const role = mcpRole(tool);
        return role === 'qa' ? 'browser' : (ROLE_SCREEN[role] ?? 'terminal');
      }
      return 'terminal';
  }
}

function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return truncate(url, 30);
  }
}

export function describeTool(tool, input = {}) {
  switch (tool) {
    case 'Read':
      return `Membaca ${basename(input.file_path)}`;
    case 'Write':
      return `Menulis ${basename(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Mengedit ${basename(input.file_path)}`;
    case 'NotebookEdit':
      return `Mengedit ${basename(input.notebook_path)}`;
    case 'Bash':
    case 'PowerShell':
      return `$ ${truncate(input.command, 60)}`;
    case 'Grep':
      return `Mencari "${truncate(input.pattern, 28)}"`;
    case 'Glob':
      return `Mencari file ${truncate(input.pattern, 28)}`;
    case 'WebSearch':
      return `Riset "${truncate(input.query, 36)}"`;
    case 'WebFetch':
      return `Membuka ${hostname(input.url)}`;
    case 'TodoWrite':
      return `Update papan task (${input.todos?.length ?? 0})`;
    case 'TaskCreate':
      return `Task baru: ${truncate(input.subject, 40)}`;
    case 'TaskUpdate':
      return `Update task #${input.taskId ?? '?'}${input.status ? ` → ${input.status}` : ''}`;
    case 'AskUserQuestion': {
      const question = input.questions?.[0]?.question;
      return question ? `Bertanya: ${truncate(question, 60)}` : 'Bertanya ke kamu';
    }
    case 'ExitPlanMode':
      return 'Mengajukan rencana kerja';
    case 'Skill':
      return `Skill: ${input.skill ?? input.name ?? ''}`;
    default:
      return tool.startsWith('mcp__') ? `Pakai ${tool.split('__').slice(1).join(' › ')}` : tool;
  }
}

export function extractTodos(tool, input) {
  if (tool !== 'TodoWrite' || !Array.isArray(input?.todos)) return undefined;
  return input.todos.map((t) => ({ content: truncate(t.content, 60), status: t.status }));
}

/**
 * Parses `.claude/agents/*.md` (frontmatter + body) into the JSON shape accepted by
 * `claude --agents`, so the role subagents work in every project, not just this one.
 */
export function loadAgentDefinitions(dir) {
  const agents = {};
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return agents;
  }
  for (const file of files) {
    const raw = readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) continue;
    const meta = Object.fromEntries(
      match[1]
        .split('\n')
        .map((line) => line.match(/^([\w-]+):\s*(.*)$/))
        .filter(Boolean)
        .map(([, key, value]) => [key, value.trim()]),
    );
    if (!meta.name) continue;
    agents[meta.name] = {
      description: meta.description ?? meta.name,
      prompt: match[2].trim(),
      ...(meta.tools ? { tools: meta.tools.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
      ...(meta.model ? { model: meta.model } : {}),
    };
  }
  return agents;
}
