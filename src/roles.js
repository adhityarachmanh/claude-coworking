// Maps Claude Code agents/tools onto the office roles, plus human-readable tool labels.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { basename, truncate } from './util.js';

export const ROLE_IDS = ['pm', 'ba', 'architect', 'ui-ux', 'frontend', 'backend', 'dba', 'qa', 'security', 'devops', 'writer'];

// Agent type → role. Ordered: first match wins ("code-reviewer" is architect, not backend;
// "frontend-developer" is frontend; "claude-code-guide" is ba).
const ROLE_PATTERNS = [
  [/\b(security|sec|pentest|pentester|appsec|vuln|vulnerability|audit|auditor)\b/, 'security'],
  [/\b(devops|sre|ops|infra|infrastructure|deploy|deployer|cicd|ci|release|platform|statusline-setup)\b/, 'devops'],
  [/\b(dba|db|database|sql|data|migration|migrator|schema)\b/, 'dba'],
  [/\b(writer|docs?|documentation|documenter|technical-writer|changelog|guide)\b/, 'writer'],
  [/\b(qa|test|tests|tester|testing|verify|verifier|e2e)\b/, 'qa'],
  [/\b(architect|architecture|arch|tech-lead|techlead|lead|review|reviewer|code-reviewer)\b/, 'architect'],
  [/\b(ui|ux|uiux|ui-ux|design|designer)\b/, 'ui-ux'],
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

const COMMAND_ROLES = [
  [/\b(npm audit|yarn audit|pnpm audit|composer audit|snyk|trivy|semgrep|gitleaks|osv-scanner|bandit|safety check)\b/i, 'security'],
  [/\b(test|tests|jest|vitest|pytest|playwright|cypress|mocha|phpunit|pest|coverage|lint|eslint|tsc|ruff|flake8|phpstan|pint)\b/i, 'qa'],
  [/\b(psql|mysql|mysqldump|sqlite3|mongosh?|redis-cli|migrate|migration|prisma|sequelize|knex|alembic|flyway|db:seed|typeorm)\b/i, 'dba'],
  [/\b(docker|docker-compose|kubectl|helm|terraform|ansible|deploy|ssh|scp|rsync|nginx|pm2|systemctl|vercel|netlify|gcloud|aws|az|gh run|gh workflow)\b|\bgit push\b|\b(build|webpack|vite build|next build|nuxt build)\b/i, 'devops'],
  [/\bgit\s+(diff|log|blame|show|status)\b|\bgh pr\b/i, 'architect'],
];

export function toRole(agentType) {
  if (!agentType) return null;
  const key = String(agentType).toLowerCase().trim();
  if (ROLE_IDS.includes(key)) return key;
  for (const [pattern, role] of ROLE_PATTERNS) if (pattern.test(key)) return role;
  return null;
}

/** Who owns a file, judged by its path. `reading` sends docs to the analyst instead of the writer. */
function fileRole(file, reading) {
  if (!file) return reading ? 'architect' : 'backend';
  if (TEST_FILE.test(file) || TEST_CLASS.test(file)) return 'qa';
  if (DOC_FILE.test(file)) return reading ? 'ba' : 'writer';
  if (DB_FILE.test(file)) return 'dba';
  if (OPS_FILE.test(file)) return 'devops';
  if (STYLE_FILE.test(file)) return 'ui-ux';
  if (FRONTEND_FILE.test(file)) return 'frontend';
  return 'backend';
}

function commandRole(command = '') {
  for (const [pattern, role] of COMMAND_ROLES) if (pattern.test(command)) return role;
  return 'backend';
}

/** Guess who in the office would do this tool call when no subagent is involved. */
export function inferRole(tool, input = {}) {
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
    default:
      return 'claude';
  }
}

const ROLE_SCREEN = { qa: 'tests', dba: 'db', devops: 'pipeline', security: 'security', architect: 'review', writer: 'doc', ba: 'doc', 'ui-ux': 'design' };

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
      return ROLE_SCREEN[commandRole(input.command)] ?? 'terminal';
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'ExitPlanMode':
      return 'kanban';
    default:
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
    case 'AskUserQuestion':
      return 'Bertanya ke kamu';
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
