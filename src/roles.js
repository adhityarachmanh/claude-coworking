// Maps Claude Code agents/tools onto the office roles, plus human-readable tool labels.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CATALOG, CATALOG_IDS, COMMAND_RULES, DEFAULT_ENABLED, GENERALIST, resolveRole } from './role-catalog.js';
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
  [null, 'compliance'], // privacy, gdpr, dpo… (before security, whose pattern has "audit")
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
  if (signal('compliance', 'file')?.test(file)) return 'compliance'; // privacy policy, DPIA, consent docs (before DOC_FILE)
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

const ROLE_SCREEN = { qa: 'tests', dba: 'db', devops: 'pipeline', security: 'security', compliance: 'security', architect: 'review', reviewer: 'review', writer: 'doc', ba: 'doc', 'ui-ux': 'design' };
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

// Shell line → what the person is doing, for the office bubble and the chat row (the exact command stays in the
// row's detail). Checked per segment of a chain; an action (test, build, commit…) beats looking around (cat, ls…).
const fileArg = (args) => basename(args.split(/\s+/).reverse().find((a) => /[\w-]\.[\w]+["']?$/.test(a))?.replace(/["']/g, '') ?? '');
const SHELL_ACTIONS = [
  [/^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|^(npx\s+)?(jest|vitest|mocha|playwright|cypress)\b|^node\s+--test\b|^(pytest|phpunit|pest)\b|^go\s+test\b|^cargo\s+test\b|^(php\s+)?artisan\s+test\b/i, 'Menjalankan test'],
  [/^(npm|pnpm|yarn)\s+(run\s+)?lint\b|^(npx\s+)?(--yes\s+)?eslint\b|^(ruff|flake8|phpstan|pint)\b|^(npx\s+)?tsc\b/i, 'Mengecek kualitas kode (lint)'],
  [/^(npm|pnpm|yarn|bun)\s+(ci|install|add|i)\b|^pip3?\s+install\b|^composer\s+(install|require|update)\b|^go\s+get\b|^cargo\s+add\b/i, 'Memasang dependency'],
  [/^(npm|pnpm|yarn)\s+(run\s+)?build\b|^(vite|next|nuxt)\s+build\b|^cargo\s+build\b|^go\s+build\b|^(flutter|gradlew|\.\/gradlew)\s+\S*(build|assemble)/i, 'Mem-build aplikasi'],
  [/^(npm|pnpm|yarn)\s+(run\s+)?(dev|start|serve)\b|^node\s+server\.js\b|^(php\s+)?artisan\s+serve\b/i, 'Menjalankan aplikasi'],
  [/^git\s+commit\b/i, 'Membuat commit'],
  [/^git\s+push\b/i, 'Push ke repository'],
  [/^git\s+(pull|fetch)\b/i, 'Mengambil update dari repository'],
  [/^git\s+(checkout|switch|branch)\b/i, 'Mengatur branch git'],
  [/^git\s+(add|restore|reset|stash)\b/i, 'Menyiapkan perubahan git'],
  [/^git\s+(diff|status|log|show|blame)\b/i, 'Mengecek perubahan di git'],
  [/^(docker|docker-compose|kubectl|helm)\b/i, 'Mengurus container'],
  [/^(terraform|ansible|vercel|netlify|gcloud|aws|az)\b/i, 'Mengurus infrastruktur'],
  [/^(psql|mysql|sqlite3|mongosh?|redis-cli)\b|\b(migrate|migration|prisma|db:seed)\b/i, 'Mengurus database'],
  [/^(curl|wget|http|Invoke-WebRequest|Invoke-RestMethod)\b/i, 'Memanggil API / URL'],
  [/^(python3?|py)\s+(-\s|-c\b|<<|-I\b.*<<)|^node\s+(-e\b|-\s|<<)|^(python3?|node)\s*$/i, 'Menjalankan skrip kecil'],
  [/^(python3?|py|node|deno|bun|php|ruby)\s+\S+/i, (s) => `Menjalankan ${fileArg(s) || 'skrip'}`],
  // `cat > f <<EOF`, `tee f`, `echo x > f`, Set-Content: writing a file, not reading it.
  [/^cat\s*>>?\s*\S|^tee\b|^(echo|printf)\b.*>>?\s*\S|^(Set-Content|Add-Content|Out-File)\b/i, (s) => (fileArg(s) ? `Menulis ${fileArg(s)}` : 'Menulis file')],
  [/^(mkdir|rm|rmdir|mv|cp|touch|New-Item|Remove-Item|Move-Item|Copy-Item)\b/i, 'Mengatur file & folder'],
  [/^(Stop-Process|kill|taskkill|Get-Process|ps|netstat|lsof|Get-CimInstance)\b/i, 'Mengecek proses'],
  [/^(tailscale|ipconfig|ping|nslookup)\b/i, 'Mengecek jaringan'],
];
const SHELL_LOOKS = [
  [/^(cat|head|tail|less|more|type|Get-Content)\b|^sed\s+-n\b/i, (s) => (fileArg(s) ? `Membaca ${fileArg(s)}` : 'Membaca file')],
  [/^(grep|rg|ag|findstr|Select-String)\b/i, 'Mencari di kode'],
  [/^wc\b/i, (s) => (fileArg(s) ? `Menghitung baris ${fileArg(s)}` : 'Menghitung baris')],
  [/^(ls|dir|find|tree|Get-ChildItem)\b/i, 'Melihat isi folder'],
];
function shellLabel(input) {
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  // Claude Code's own one-line description of the command is the best "what am I doing".
  if (description) return truncate(description.charAt(0).toUpperCase() + description.slice(1), 70);
  const segments = commandSegments(input.command ?? '').map((s) =>
    s
      .replace(/^(\w+=\S*\s+)+/, '') // FOO=1 BAR=2 cmd
      .replace(/^timeout\s+\d+\w?\s+/i, '') // timeout 60 cmd
      .replace(/^["']?(\S*?)["']?(?=\s|$)/, '$1') // "C:/Program Files…/node.exe" x
      .replace(/^\S*[\\/]/, '') // C:/nvm/node.exe x → node.exe x
      .replace(/^(\S+)\.exe\b/i, '$1'), // node.exe → node
  );
  // The phrase order is the priority: `git add && git commit` is committing, `cd x && npm test` is testing.
  for (const table of [SHELL_ACTIONS, SHELL_LOOKS]) {
    for (const [re, text] of table) {
      const segment = segments.find((s) => re.test(s));
      if (segment) return typeof text === 'function' ? text(segment) : text;
    }
  }
  // Unknown command: name the program only — arguments, paths and secrets never reach the bubble
  // (the exact command stays in the chat row's detail).
  const raw = String(input.command ?? '').trim().replace(/^(\w+=\S*\s+)+/, '');
  const first = /^["']/.test(raw) ? raw.slice(1, raw.indexOf(raw[0], 1) >>> 0) : raw.split(/\s+/)[0]; // "C:/My App/run.exe" x
  const program = truncate(first.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').replace(/[^\w.@+-]/g, ''), 30);
  return program ? `Menjalankan ${program}` : 'Menjalankan perintah';
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
      return shellLabel(input);
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
      // Every subagent gets the same never-hang rules for running commands (src/role-catalog.js).
      prompt: `${match[2].trim()}\n\n${COMMAND_RULES}`,
      ...(meta.tools ? { tools: meta.tools.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
      ...(meta.model ? { model: meta.model } : {}),
    };
  }
  return agents;
}
