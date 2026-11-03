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
  general: 'freelancer', // OpenCode's built-in general subagent
  fork: 'freelancer',
  claude: 'freelancer',
};

// ---------- learned mappings (src/role-memory.js): corrections and the AI's answers for names no rule knows ----------
// `lookup(key, projectPath)` → a role id or null (the project's .office-roles.json, then this laptop's); it wins
// over the rules. `unknown(key, hint, projectPath)` hears about names the rules fell back on. Keys: mcp:<server>,
// skill:<name>, agent:<type>, script:<file name>, cmd:<program>.
const learned = { lookup: null, unknown: null };
export function setRoleMemory({ lookup = null, unknown = null } = {}) {
  learned.lookup = lookup;
  learned.unknown = unknown;
}
const learnedRole = (key, ctx) => (key ? (learned.lookup?.(key, ctx?.projectPath) ?? null) : null);

/** Role for a subagent type; unknown types are the freelancer, never silently "backend". */
export function agentRole(agentType, ctx = {}) {
  const type = String(agentType ?? 'general-purpose');
  const key = `agent:${type.toLowerCase().trim()}`;
  const own = learnedRole(key, ctx);
  if (own) return resolve(own);
  const role = toRole(type);
  if (!role) learned.unknown?.(key, type, ctx?.projectPath);
  return role ?? resolve(GENERALIST);
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

// Agent type → role. Ordered: first match wins ("code-reviewer" is architect, not backend;
// "frontend-developer" is frontend; "claude-code-guide" is writer; "accessibility-auditor" is UI/UX, not security;
// "code-explorer" is analysis, not backend). A `null` pattern is an optional role's own pattern (catalog
// `signals.agent`), skipped while that role is off.
const ROLE_PATTERNS = [
  [null, 'compliance'], // privacy, gdpr, dpo… (before security, whose pattern has "audit")
  [/\b(a11y|accessibility|wcag)\b/, 'ui-ux'], // an accessibility audit is UI/UX work (before security's "audit")
  [/\b(security|sec|devsecops|pentest|pentester|appsec|vuln|vulnerability|audit|auditor|threat|secrets?)\b/, 'security'],
  [/\b(devops|sre|ops|infra|infrastructure|deploy|deployer|deployment|cicd|ci|release|platform|cloud|docker|kubernetes|k8s|helm|terraform|ansible|aws|gcp|azure|statusline-setup)\b/, 'devops'],
  [null, 'data'], // data-engineer, ml, llm… (before dba, whose pattern also has "data")
  [/\b(dba|db|database|sql|postgres|postgresql|mysql|mariadb|mongo|mongodb|redis|prisma|data|migration|migrator|schema)\b/, 'dba'],
  [/\b(writer|docs?|documentation|documenter|technical-writer|tech-writer|copywriter|changelog|guide|readme|translator|localization|i18n)\b/, 'writer'],
  [/\b(qa|test|tests|tester|testing|verify|verifier|e2e|debug|debugger|performance|perf|benchmark|benchmarker)\b/, 'qa'],
  [null, 'support'],
  [null, 'reviewer'], // review, code-reviewer… (while it is off, the architect below takes them, as before)
  [/\b(api-design|api-designer|system-design|system-designer|solution-architect)\b/, 'architect'], // before ui-ux's "designer"
  [/\b(architect|architecture|arch|tech-lead|techlead|lead|review|reviewer|code-reviewer)\b/, 'architect'],
  [/\b(ui|ux|uiux|ui-ux|design|designer|figma)\b/, 'ui-ux'],
  [null, 'mobile'], // flutter, android, ios… (before frontend, whose pattern also has "mobile")
  [/\b(frontend|front-end|fe|web|react|reactjs|vue|vuejs|nuxt|next|nextjs|angular|svelte|tailwind|css|html|mobile)\b/, 'frontend'],
  [/\b(ba|analyst|analysis|explore|explorer|research|researcher|requirements)\b/, 'ba'], // before backend's "code"
  [/\b(backend|back-end|be|api|server|developer|dev|engineer|coder|code|fullstack|full-stack|build|fix|fixer|implement|implementer|integration|integrator|payment|webhook|refactor|refactorer)\b/, 'backend'],
  [/\b(pm|plan|planner|planning|product|project|manager|scrum|owner)\b/, 'pm'],
];

// ---------- files: who owns a file, by its path (Read / Edit / Write, and the shell's cat / sed -i / echo >) ----------
// `(^|[\\/])dir[\\/]` matches a folder name in both relative and absolute paths.
const TEST_FILE = /[._-](test|spec)s?\.[a-z0-9]+$|(^|[\\/])(__tests__|__mocks__|tests?|specs?|e2e|cypress|playwright|fixtures?|test-support|testdata)[\\/]/i;
const TEST_CLASS = /[a-z0-9](Test|Tests|Spec)\.[A-Za-z]+$/; // LoginTest.php, UserServiceTests.cs
// Test runner / coverage configuration
const TEST_CONFIG = /(^|[\\/])(jest|vitest|playwright|cypress|karma|ava|wdio|nightwatch)\.conf(ig)?\.[a-z]+$|(^|[\\/])(\.mocharc[^\\/]*|pytest\.ini|tox\.ini|conftest\.py|phpunit\.xml(\.dist)?|setupTests\.[a-z]+|codecov\.ya?ml|\.nycrc[^\\/]*|\.coveragerc)$/i;
// Lint / format configuration (code quality: QA)
const LINT_CONFIG = /(^|[\\/])(\.eslintrc[^\\/]*|eslint\.config\.[a-z]+|\.eslintignore|\.prettierrc[^\\/]*|prettier\.config\.[a-z]+|\.prettierignore|\.stylelintrc[^\\/]*|stylelint\.config\.[a-z]+|biome\.jsonc?|\.editorconfig|ruff\.toml|\.flake8|\.pylintrc|phpstan\.neon(\.dist)?|\.php-cs-fixer[^\\/]*|pint\.json|\.rubocop\.yml|\.golangci\.ya?ml|\.markdownlint[^\\/]*|\.shellcheckrc|\.hadolint\.ya?ml)$/i;
// Licences and third-party notices: legal / compliance
const LEGAL_FILE = /(^|[\\/])(LICEN[CS]E|NOTICE|COPYING|THIRD[-_]PARTY[^\\/]*)(\.[a-z]+)?$/i;
// Security policy, scanners' config, keys and certificates, threat models
const SECURITY_FILE = /(^|[\\/])(SECURITY\.md|\.snyk|\.gitleaks(\.toml)?|gitleaks\.toml|\.trivyignore|\.semgrep(\.ya?ml)?|semgrep\.ya?ml|dependabot\.ya?ml|\.secrets\.baseline)$|\.(pem|key|crt|cer|csr|p12|pfx|jks)$|(^|[\\/])[^\\/]*(threat-?model|pentest|security-(review|audit|report))[^\\/]*$/i;
// Instructions for the AI team itself (project conventions): the tech lead's
const AGENT_CONFIG = /(^|[\\/])(CLAUDE(\.local)?\.md|AGENTS\.md|\.cursorrules|copilot-instructions\.md)$|(^|[\\/])\.(claude|opencode|cursor)[\\/](agents|commands|skills|rules|prompts)[\\/]/i;
// Tool / editor settings (permissions, hooks, MCP config): DevOps
const TOOL_SETTINGS = /(^|[\\/])\.(claude|opencode|vscode|idea|husky)[\\/]|(^|[\\/])(opencode\.jsonc?|\.mcp\.json|\.claude\.json)$/i;
// API contracts (OpenAPI / Swagger / AsyncAPI / protobuf): API design
const API_CONTRACT = /(^|[\\/])[^\\/]*(openapi|swagger|asyncapi)[^\\/]*\.(ya?ml|json)$|\.proto$/i;
// Translations: the UI's strings
const LOCALE_FILE = /(^|[\\/])(locales?|i18n|lang|translations?|messages)[\\/]/i;
// Logs: reproducing an issue from them is support's (QA without it); a build/CI log is DevOps'
const LOG_FILE = /\.log(\.\d+)?$|(^|[\\/])logs?[\\/][^\\/]+$/i;
const OPS_LOG = /(build|ci|deploy|docker|install|setup|restart|update|npm-debug)/i;
const DOC_FILE = /\.(md|mdx|txt|rst|adoc|pdf|docx)$|(^|[\\/])docs?[\\/]|(^|[\\/])(README|CHANGELOG|CONTRIBUTING)[^\\/]*$/i;
// Kinds of documents, by name (on the file name, not the folders): who writes / reads them
const DOC_KINDS = [
  [/(design-?system|style-?guide|brand(ing)?|ui-?kit|wireframes?|mockups?|(^|[-_.])ux([-_.]|$))/i, 'ui-ux'],
  [/(^|[-_.])(architecture|design|adrs?|rfcs?|tech-?spec|technical-design|system-design)([-_.\d]|$)/i, 'architect'],
  [/(^|[-_.])(prd|roadmap|backlog|okrs?|release-plan|milestones?|sprints?|acceptance(-criteria)?|product-spec|scope)([-_.]|$)/i, 'pm'],
  [/(^|[-_.])(requirements?|user-stor(y|ies)|use-?cases?|business-rules?|process-flows?|glossary|analysis)([-_.]|$)/i, 'ba'],
  [/(^|[-_.])(test-?plans?|test-?cases?|test-strategy|qa|uat|bug-reports?)([-_.]|$)/i, 'qa'],
  [/(^|[-_.])(runbooks?|playbooks?|deploy(ment)?|operations|incidents?|postmortems?|on-?call|slos?|infra(structure)?)([-_.]|$)/i, 'devops'],
];
// …and by folder (docs/adr/…, docs/runbooks/…)
const DOC_FOLDERS = [
  [/(^|[\\/])(adrs?|architecture|rfcs?|design-docs?)[\\/]/i, 'architect'],
  [/(^|[\\/])(runbooks?|playbooks?|ops)[\\/]/i, 'devops'],
  [/(^|[\\/])(requirements|user-stories)[\\/]/i, 'ba'],
  [/(^|[\\/])(product|prd|roadmap)[\\/]/i, 'pm'],
];
const DB_FILE = /\.(sql|prisma|dbml|sqlite3?)$|(^|[\\/])(migrations?|seeders?|seeds|schema|drizzle)[\\/]|knexfile|ormconfig|alembic|drizzle\.config|(^|[\\/])schema\.(rb|ts|js)$/i;
// Dependencies, build and bundler configuration, repo plumbing, shell/batch scripts: DevOps
const BUILD_FILE = /(^|[\\/])(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|pnpm-workspace\.ya?ml|bun\.lockb?|composer\.(json|lock)|requirements[^\\/]*\.txt|pipfile(\.lock)?|poetry\.lock|pyproject\.toml|setup\.(py|cfg)|go\.(mod|sum)|cargo\.(toml|lock)|gemfile(\.lock)?|\.ruby-version|\.python-version|\.nvmrc|\.node-version|\.npmrc|\.yarnrc[^\\/]*|\.tool-versions|tsconfig[^\\/]*\.json|jsconfig\.json|(vite|webpack|rollup|esbuild|babel|turbo|nx|lerna|tsup|rspack|parcel|next|nuxt|astro|svelte|remix|quasar)\.config\.[a-z]+|angular\.json|\.babelrc|makefile|cmakelists\.txt|\.gitignore|\.gitattributes)$|\.(sh|bash|zsh|ps1|psm1|bat|cmd)$/i;
const OPS_FILE = /dockerfile|docker-compose|(^|[\\/])compose\.ya?ml$|\.dockerignore|\.tf$|\.tfvars$|\.hcl$|(^|[\\/])\.github[\\/]|\.gitlab-ci|jenkinsfile|azure-pipelines|bitbucket-pipelines|(^|[\\/])\.circleci[\\/]|\.drone\.yml|nginx|caddyfile|(^|[\\/])(k8s|kubernetes|helm|charts|infra|terraform|ansible|deploy|deployment)[\\/]|ecosystem\.config|(^|[\\/])\.env(\.|$)|(^|[\\/])(procfile|fly\.toml|vercel\.json|netlify\.toml|render\.ya?ml|app\.ya?ml|serverless\.ya?ml|railway\.json)$|\.service$|\.(ya?ml)$/i;
const STYLE_FILE = /\.(css|scss|sass|less|styl|pcss|svg)$|tailwind\.config|postcss\.config|(^|[\\/])(styles?|design|tokens|themes?)[\\/]/i;
// Images, fonts, icons and design sources: UI/UX
const ASSET_FILE = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|ai|sketch|fig|xd|woff2?|ttf|otf|eot)$|(^|[\\/])(icons?|images?|img|fonts?|illustrations?|sprites?)[\\/]/i;
const FRONTEND_FILE = /\.(tsx|jsx|vue|svelte|html?|astro|ejs|hbs|handlebars|pug|njk|twig|erb|liquid|mjml)$|\.blade\.php$|(^|[\\/])(components|pages|views|layouts|composables|hooks|stores?|public|assets|client|frontend|webapp|widgets?)[\\/]/i;

/** Who writes (or reads) a document, by its name and folder; null for a generic doc. */
function docKind(file) {
  const name = String(file).split(/[\\/]/).pop();
  for (const [re, role] of DOC_KINDS) if (re.test(name)) return role;
  for (const [re, role] of DOC_FOLDERS) if (re.test(file)) return role;
  return null;
}

/** Who owns a file, judged by its path. `reading` sends generic docs to the analyst instead of the writer. */
function fileRole(file, reading) {
  if (!file) return reading ? 'architect' : 'backend';
  const isDoc = DOC_FILE.test(file);
  if (TEST_CONFIG.test(file)) return 'qa';
  // A doc inside a "specs/" folder is a product spec, not a test (rspec's spec/ holds code, not .md)
  if ((TEST_FILE.test(file) && !(isDoc && !/(^|[\\/])(__tests__|tests?|e2e|test-support)[\\/]/i.test(file))) || TEST_CLASS.test(file)) return 'qa';
  if (LEGAL_FILE.test(file)) return 'compliance';
  if (signal('compliance', 'file')?.test(file)) return 'compliance'; // privacy policy, DPIA, consent docs (before DOC_FILE)
  if (SECURITY_FILE.test(file)) return 'security';
  if (AGENT_CONFIG.test(file)) return 'architect';
  if (TOOL_SETTINGS.test(file)) return 'devops';
  if (API_CONTRACT.test(file)) return 'architect';
  if (LINT_CONFIG.test(file)) return 'qa';
  if (LOG_FILE.test(file)) return OPS_LOG.test(file.split(/[\\/]/).pop()) ? 'devops' : reading ? 'support' : 'devops';
  if (/(^|[\\/])mkdocs\.ya?ml$|(^|[\\/])\.?vitepress[\\/]|docusaurus\.config/i.test(file)) return 'writer';
  if (isDoc) return docKind(file) ?? (reading ? 'ba' : 'writer');
  // Optional roles' files, only while on: *.dart / android/ / ios/ → mobile; *.ipynb / dbt/ / airflow → data.
  if (signal('mobile', 'file')?.test(file)) return 'mobile';
  if (signal('data', 'file')?.test(file)) return 'data';
  if (DB_FILE.test(file)) return 'dba';
  if (LOCALE_FILE.test(file)) return 'frontend';
  if (BUILD_FILE.test(file)) return 'devops';
  if (OPS_FILE.test(file)) return 'devops';
  if (ASSET_FILE.test(file)) return 'ui-ux';
  if (STYLE_FILE.test(file)) return 'ui-ux';
  if (FRONTEND_FILE.test(file)) return 'frontend';
  return 'backend';
}

// ---------- shell commands: who runs this, by what it does ----------

// A `null` pattern is an optional role's own one (catalog `signals.command`), skipped while that role is off.
// Ordered: first match wins.
const COMMAND_ROLES = [
  [/\b(npm audit|yarn audit|pnpm audit|composer audit|pip-audit|bundle audit|cargo audit|govulncheck|snyk|trivy|semgrep|gitleaks|trufflehog|detect-secrets|osv-scanner|bandit|safety check|dependency-check|grype|nmap|nikto|sqlmap|zap-baseline|openssl|ssh-keygen|gpg|mkcert|certutil)\b/i, 'security'],
  [/\b(test|tests|jest|vitest|pytest|playwright|cypress|mocha|jasmine|karma|ava|phpunit|pest|rspec|minitest|behave|cucumber|nextest|coverage|nyc|c8|stryker|k6|artillery|locust|jmeter|lighthouse|lint|eslint|stylelint|markdownlint|tsc|mypy|pyright|ruff check|flake8|pylint|phpstan|psalm|phpcs|rubocop|golangci-lint|go vet|cargo clippy|shellcheck|hadolint|prettier --check|prettier -c|biome check|vue-tsc|svelte-check)\b/i, 'qa'],
  [null, 'mobile'],
  [null, 'data'],
  [null, 'support'], // kubectl logs, journalctl… (before DevOps' kubectl / docker)
  [/\b(psql|mysql|mysqldump|mysqladmin|pg_dump|pg_restore|sqlite3|sqlcmd|mongosh?|mongodump|mongorestore|redis-cli|migrate|migration|prisma|sequelize|knex|alembic|flyway|liquibase|goose|drizzle-kit|db:seed|db:migrate|typeorm|makemigrations|dbshell|diesel)\b/i, 'dba'],
  [/\b(svgo|imagemin|squoosh|pa11y|axe|make-icons|favicon|figma)\b|scripts[\\/][^\s]*(icon|sprite|image|favicon|font|theme)[^\s]*\.(mjs|js|ts|py|sh)\b/i, 'ui-ux'],
  [/\b(typedoc|jsdoc|mkdocs|sphinx-build|docusaurus|vitepress|docsify|redoc-cli|widdershins)\b/i, 'writer'],
  [/\b(docker|docker-compose|podman|kubectl|helm|terraform|tofu|pulumi|ansible|deploy|ssh|scp|rsync|nginx|caddy|pm2|systemctl|vercel|netlify|fly|railway|heroku|gcloud|aws|az|wrangler|gh run|gh workflow|gh release|semantic-release|changeset|npm publish|npm version|setx)\b|\bgit (push|tag)\b|^(make|cmake)\b|\b(build|webpack|vite build|next build|nuxt build|mvn package|gradle build|tsup|esbuild|rollup)\b|scripts[\\/](restart|update|setup|deploy|install|release|backup)\.(mjs|js|sh|ps1)\b|\b(start-office|update|setup|restart|uninstall-autostart)\.(cmd|bat|ps1)\b|\b(claude|opencode)\s+(doctor|update|upgrade|install|mcp|plugin|auth|config|models|serve)\b/i, 'devops'],
  [/\b(vite|next dev|nuxt dev|ng serve|webpack serve|webpack-dev-server|storybook|astro dev|svelte-kit dev)\b/i, 'frontend'],
  [null, 'reviewer'],
  [/\bgit\s+(diff|log|blame|show|status|shortlog|reflog)\b|\bgh pr (view|list|status|review|diff|checks)\b/i, 'architect'],
  [/\bgh (issue|project)\b/i, 'pm'],
];

/** First role whose pattern matches `text`; a `null` pattern is the optional role's own `kind` pattern while it is on. */
function matchRole(table, kind, text) {
  for (const [own, role] of table) {
    const pattern = own ?? signal(role, kind);
    if (pattern?.test(text)) return role;
  }
  return null;
}

// Searching / listing (what the Grep and Glob tools do): the tech lead investigating
const SEARCH_VERBS = new Set(['grep', 'rg', 'ag', 'egrep', 'fgrep', 'findstr', 'select-string', 'sls', 'ls', 'dir', 'tree', 'find', 'fd', 'wc', 'awk', 'diff', 'cmp', 'stat', 'file', 'jq', 'yq', 'xxd', 'strings', 'get-childitem', 'gci', 'du']);
// Reading one file (what the Read tool does): judged by the file, like Read
const READ_VERBS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'type', 'get-content', 'gc', 'nl']);
// Machine / process / network housekeeping.
const OPS_VERBS = new Set([
  'ps', 'kill', 'pkill', 'killall', 'lsof', 'netstat', 'ss', 'top', 'htop', 'df', 'free', 'uptime', 'ping', 'nslookup',
  'dig', 'traceroute', 'tracert', 'ipconfig', 'ifconfig', 'tailscale', 'schtasks', 'sc', 'service', 'tasklist', 'taskkill',
  'get-process', 'stop-process', 'start-process', 'get-service', 'restart-service', 'get-nettcpconnection', 'test-netconnection',
  'netsh', 'new-netfirewallrule', 'get-netfirewallrule', 'chmod', 'chown', 'crontab', 'apt', 'apt-get', 'brew', 'winget', 'choco', 'scoop',
  'get-ciminstance', 'invoke-cimmethod', 'register-scheduledtask', 'get-scheduledtask',
]);
// Hitting a running app to see whether it answers correctly.
const HTTP_VERBS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);
const INSTALL = /^(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|uninstall|update|upgrade)\b|^(pip3?|uv|poetry)\s+(install|add|remove|uninstall)\b|^composer\s+(install|require|update|remove)\b|^(go\s+get|go\s+mod\s+tidy|cargo\s+add|gem\s+install|bundle(\s+install)?$)/i;
const SYNTAX_CHECK = /^(node\s+--check|php\s+-l|python3?\s+-m\s+py_compile|bash\s+-n)\b/i;
// Formatters that rewrite files: the code's owner tidying it (judged by the files given)
const FORMATTER = /^(prettier\s+(--write|-w)|black|isort|gofmt\s+-w|goimports|rustfmt|cargo\s+fmt|ruff\s+format|pint|php-cs-fixer\s+fix|eslint\s+.*--fix|biome\s+(format|check\s+--apply))\b/i;
// `npm run <script>` / `yarn <script>`: the script's name says what it does
const RUN_SCRIPT = /^(npm|pnpm|yarn|bun)\s+(run\s+)?([\w:.-]+)/i;
// Script files by what their name says (node scripts/x.mjs, python tools/y.py, bash z.sh…)
const SCRIPT_KINDS = [
  [/(restart|deploy|release|setup|install|update|upgrade|bootstrap|provision|backup|autostart|docker|ci)/i, 'devops'],
  [/(test|spec|e2e|smoke|bench|verify|check|probe|repro|screenshot|lint)/i, 'qa'],
  [/(migrat|seed|db|sql|schema)/i, 'dba'],
  [/(audit|scan|secret|vuln|cert)/i, 'security'],
  [/(icon|sprite|image|favicon|font|theme|palette|svg)/i, 'ui-ux'],
  [/(doc|readme|changelog)/i, 'writer'],
  [/(train|etl|ingest|embed|dataset|notebook|pipeline)/i, 'data'],
];
const INTERPRETERS = new Set(['node', 'deno', 'bun', 'tsx', 'ts-node', 'python', 'python3', 'py', 'php', 'ruby', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'perl']);
// Leading noise that is not the command itself: `S=/x;`, `OFFICE_PORT=1 node …`, `$p = …`, `cd x &&`, `do …`.
const SKIP_SEGMENT = /^(cd|pushd|popd|set-location|sl|echo|printf|write-host|write-output|export|set|source|\.|true|false|done|fi|esac|then|else|break|continue|exit|\{|\})(\s|$)|^\$?[A-Za-z_][\w]*\s*=/i;
const LEADING_NOISE = /^((sudo|time|nohup|npx|exec|env|do|then|&)\s+|timeout\s+\d+\w?\s+|[A-Za-z_]\w*=("[^"]*"|'[^']*'|\S*)\s+)+/i;
// Shells wrapping the real command: `cmd /c x`, `powershell -NoProfile -Command "x"`, `bash -c "x"`
const WRAPPER = /^(cmd(\.exe)?\s+\/[ck]|(powershell|pwsh)(\.exe)?(\s+-\w+)*\s+-(command|c)|(bash|sh|zsh)\s+-l?c)\s+/i;

/** Splits a shell line into its commands (`a && b | c; d`), dropping setup noise like `cd` and assignments. */
function commandSegments(command) {
  return String(command)
    .split(/&&|\|\||[;|\n]/)
    .map((s) => {
      let t = s.trim().replace(LEADING_NOISE, '');
      while (WRAPPER.test(t)) t = t.replace(WRAPPER, '').replace(/^["']|["']$/g, '').trim();
      return t.replace(/^["']|["']$/g, '');
    })
    .filter((s) => s && !SKIP_SEGMENT.test(s));
}

/** The file a command reads or writes: its last argument that looks like a path with an extension. */
const fileArgOf = (args) => [...args].reverse().map((a) => a.replace(/^["']|["']$/g, '').replace(/^-\w+=/, '')).find((a) => /[\w-]\.[A-Za-z0-9]+$/.test(a) && !/^-/.test(a)) ?? null;

/**
 * What a single command is: { kind, role }. kind: 'action' (an intent: test, build, deploy, migrate…), 'write'
 * (writes a file: judged by the file), 'read' (reads a file: judged by the file, like the Read tool), 'search'
 * (looks around, like Grep), 'generic' (plain development: git add/commit, a script without a telling name), or null.
 */
function segmentRole(raw) {
  // `/c/php83/php.exe -l x` → `php -l x`, so full program paths are judged like bare names.
  const [first, ...args] = raw.split(/\s+/);
  const verb = first.toLowerCase().replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
  const segment = [verb, ...args].join(' ');
  // `node --test x > run.log 2>&1`: the redirect only keeps the output; the command itself says what is done
  const WRITERS = ['echo', 'printf', 'cat', 'tee', 'set-content', 'add-content', 'out-file', 'write-output', 'sed', 'awk', 'jq'];
  if (!WRITERS.includes(verb) && /\d?>>?\s*\S/.test(segment)) {
    const bare = segment.replace(/\s*\d?>>?\s*(&\d|\S+)/g, '').trim();
    const inner = bare && bare !== segment ? segmentRole(bare) : null;
    if (inner) return inner;
  }
  // writing a file: `sed -i`, `tee f`, `> f`, Set-Content: whoever owns that file
  if ((verb === 'sed' && /\s-i\b/.test(segment)) || ['tee', 'set-content', 'add-content', 'out-file'].includes(verb) || /(^|\s)>>?\s*\S/.test(segment)) {
    const target = /(^|\s)>>?\s*(\S+)/.exec(segment)?.[2] ?? fileArgOf(args);
    if (target && !/^(\/dev\/null|nul|\$null|&\d)$/i.test(target)) return { kind: 'write', role: fileRole(target.replace(/["']/g, ''), false) };
  }
  if (READ_VERBS.has(verb) || (verb === 'sed' && /\s-n\b/.test(segment))) {
    const file = fileArgOf(args);
    return file ? { kind: 'read', role: fileRole(file, true), file } : { kind: 'search' };
  }
  if (SEARCH_VERBS.has(verb)) return { kind: 'search' };
  if (verb === 'git') {
    // Judge git by its subcommand only — a commit message mentioning "tests" is not running tests.
    const sub = segment.split(/\s+/).find((w, i) => i > 0 && !w.startsWith('-')) ?? '';
    if (/^(push|tag|pull|fetch)$/.test(sub)) return { kind: 'action', role: 'devops' };
    if (/^(diff|log|blame|show|status|shortlog|reflog)$/.test(sub)) return { kind: 'action', role: 'architect' };
    if (/^(ls-files|ls-tree|grep)$/.test(sub)) return { kind: 'search' };
    return { kind: 'generic', role: 'backend' }; // add, commit, checkout, branch, stash, merge…
  }
  if (verb === 'gh' && /^gh\s+pr\s+(create|merge|ready)\b/i.test(segment)) return { kind: 'action', role: 'devops' };
  if (INSTALL.test(segment)) return { kind: 'action', role: 'devops' }; // dependencies are DevOps' job, even `pip install pytest`
  if (FORMATTER.test(segment)) {
    const file = fileArgOf(args);
    return { kind: 'write', role: file ? fileRole(file, false) : 'backend' };
  }
  const run = RUN_SCRIPT.exec(segment);
  if (run && !/^(i|install|ci|add|remove|uninstall|update|upgrade|exec|dlx|x|create|init)$/i.test(run[3])) {
    const name = run[3];
    if (/^(test|e2e|coverage|lint|typecheck|type-check|check|verify)(:|$)/i.test(name)) return { kind: 'action', role: 'qa' };
    if (/^(build|bundle|compile|deploy|release|publish|docker)(:|$)/i.test(name)) return { kind: 'action', role: 'devops' };
    if (/^(migrate|db|seed)(:|$)/i.test(name)) return { kind: 'action', role: 'dba' };
    if (/^(docs?)(:|$)/i.test(name)) return { kind: 'action', role: 'writer' };
    if (/^(storybook)(:|$)/i.test(name)) return { kind: 'action', role: 'frontend' };
    if (/^(audit)(:|$)/i.test(name)) return { kind: 'action', role: 'security' };
  }
  const known = matchRole(COMMAND_ROLES, 'command', segment);
  if (known) return { kind: 'action', role: known };
  if (OPS_VERBS.has(verb)) return { kind: 'action', role: 'devops' };
  if (HTTP_VERBS.has(verb)) return { kind: 'action', role: /\s(-o|-O|--output|-OutFile)\b/.test(segment) ? 'devops' : 'qa' };
  if (SYNTAX_CHECK.test(segment)) return { kind: 'action', role: 'qa' };
  if (INTERPRETERS.has(verb)) {
    // a script: what its name says, else the owner of its file (tests/x.py → QA, server.js → Backend)
    const script = args.find((a) => /[\w-]\.(m?[jt]s|cjs|py|php|rb|sh|ps1|pl)$/i.test(a.replace(/["']/g, '')))?.replace(/["']/g, '');
    if (script) {
      const name = script.split(/[\\/]/).pop();
      for (const [re, role] of SCRIPT_KINDS) if (re.test(name)) return { kind: 'action', role: resolveScript(role) };
      const owner = fileRole(script, false);
      return owner === 'backend' ? { kind: 'generic', role: 'backend', subject: `script:${name.toLowerCase()}` } : { kind: 'action', role: owner };
    }
  }
  return null;
}
// A script named for an optional role's work (train, etl…) goes to that role only while it is on
const resolveScript = (role) => (role === 'data' && !team.active.has('data') ? 'backend' : role);

// `sleep 10`, `Start-Sleep`, `Wait-Process`, and the head of a polling loop (`for i in …; do`, `while …`, `until …`)
const WAIT = /^(sleep|start-sleep|wait-process|wait)\b|^(for|while|until)\s/i;
// A process-existence probe inside such a loop
const PID_CHECK = /get-process\s+-id\b|\bkill\s+-0\b|tasklist\s+\/fi\s+"?pid|\bps\s+-p\b/i;
// Words a test run's output is searched for
const TEST_RESULT = /\b(pass|passed|fail|failed|failing|tests?|coverage|ok|not ok)\b|✔|✖/i;

// The model's own one-line description of the command (Bash `description`): what it says it is doing. Used when
// the command itself tells nothing (an unknown script, a quick `node -e` check); the bubble shows the same text.
const DESC_ROLES = [
  [/\b(menunggu|tunggu|wait(ing)?)\b/i, 'claude'],
  [/\b(audit|keamanan|security|secrets?|rahasia|kerentanan|vulnerab\w*|cve|pentest)\b/i, 'security'],
  [/\b(test|tests|testing|tes|uji|menguji|pengujian|verifikasi|verify|validasi|validate|reproduksi|reproduce|screenshot|probe|smoke|e2e|lint|regresi|regression|coverage|benchmark)\b/i, 'qa'],
  [/\b(migrasi|migration|database|query|sql|seed|skema|schema)\b/i, 'dba'],
  [/\b(deploy|deployment|rilis|release|restart|merestart|rebuild|build|install|dependency|dependencies|docker|container|ci|pipeline|autostart|firewall|scheduler)\b/i, 'devops'],
  [null, 'mobile'],
  [/\b(android|ios|flutter|apk|emulator|simulator|expo)\b/i, 'mobile'],
  [/\b(etl|notebook|dataset|embedding|embeddings|analitik|analytics|machine learning|model ml)\b/i, 'data'],
  [/\b(insiden|incident|keluhan|triage|helpdesk|log error|log server)\b/i, 'support'],
  [/\b(dokumentasi|documentation|docs|readme|changelog|panduan)\b/i, 'writer'],
  [/\b(css|styling|tampilan|ikon|icon|icons|warna|layout|aksesibilitas|accessibility|desain ui)\b/i, 'ui-ux'],
  [/\b(review|meninjau|arsitektur|architecture|menelusuri|telusur|investigasi|investigate|mencari|memetakan|search)\b/i, 'architect'],
  [/\b(rencana|prioritas|priority|scope|backlog)\b/i, 'pm'],
  [/\b(kebutuhan|requirements?|riset|research|aturan bisnis|business rules?)\b/i, 'ba'],
];
const descRole = (description) => {
  const d = String(description ?? '');
  if (!d.trim()) return null;
  for (const [re, role] of DESC_ROLES) {
    if (!re) continue;
    if (re.test(d)) return role === 'data' || role === 'support' || role === 'mobile' ? (team.active.has(role) ? role : null) : role;
  }
  return null;
};

/**
 * Who would run this shell line, and whether it only reads. Precedence: an intent (test, build, deploy, migrate…)
 * beats writing a file, which beats reading one; then the model's own description; then plain development; then
 * looking around (the tech lead investigating; QA when it is tests or a test run's results); then waiting (the
 * Lead); else Backend. Within a kind, the first command of the chain decides.
 */
function classifyCommand(command = '', description = '') {
  let action = null;
  let write = null;
  let read = null;
  let generic = null;
  let searched = null;
  let waiting = false;
  let subject = null; // what a learned mapping is keyed on: the first command's script or program
  let genericScript = null;
  for (let segment of commandSegments(command)) {
    // `until curl …` / `while kill -0 …`: the loop waits, but its condition is a real check (judged below)
    const cond = /^(while|until)\s+(.+)$/i.exec(segment);
    if (cond) waiting = true;
    else if (WAIT.test(segment)) {
      waiting = true;
      continue;
    }
    if (cond) segment = cond[2].replace(/^[!\s]+/, '');
    // Waiting for something (a test run, a server): a loop's own "is it still running?" check belongs to the wait
    if (waiting && PID_CHECK.test(segment)) continue;
    subject ??= subjectOf(segment);
    const r = segmentRole(segment);
    if (!r) continue;
    if (r.kind === 'action') {
      action ??= r.role;
      break;
    }
    if (r.kind === 'write') write ??= r.role;
    else if (r.kind === 'read') read ??= r;
    else if (r.kind === 'generic') {
      generic ??= r.role;
      genericScript ??= r.subject ?? null;
    }
    else if (r.kind === 'search') searched ??= segment;
  }
  if (action) return { role: action, readOnly: false, subject };
  if (write) return { role: write, readOnly: false };
  // Reading a test run's log for its results (grep "pass|fail" run.log) is QA's work. Judged on the whole line:
  // a grep pattern like "tests|pass|fail" is split at its | by commandSegments.
  const testLog = (read || searched) && /\.log\b/i.test(command) && TEST_RESULT.test(command);
  if (testLog) return { role: 'qa', readOnly: true };
  if (read) return { role: read.role, readOnly: true };
  const said = descRole(description);
  if (said) return { role: said, readOnly: Boolean(searched) && !generic };
  if (generic) return { role: generic, readOnly: false, subject, unknown: genericScript };
  if (searched) {
    const readsTests = searched.split(/\s+/).some((arg) => TEST_FILE.test(arg.replace(/["']/g, '')));
    return { role: readsTests ? 'qa' : 'architect', readOnly: true };
  }
  if (waiting) return { role: 'claude', readOnly: true };
  return { role: 'backend', readOnly: false, subject, unknown: subject };
}

/** The key a learned mapping of this command is stored under: `script:<file>` for a script, else `cmd:<program>`. */
function subjectOf(segment) {
  const [first, ...args] = segment.split(/\s+/);
  const verb = first.toLowerCase().replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
  if (INTERPRETERS.has(verb)) {
    const script = args.map((a) => a.replace(/["']/g, '')).find((a) => /[\w-]\.(m?[jt]s|cjs|py|php|rb|sh|ps1|pl)$/i.test(a));
    return script ? `script:${script.split(/[\\/]/).pop().toLowerCase()}` : null;
  }
  return /^[\w][\w.+-]{0,40}$/.test(verb) ? `cmd:${verb}` : null;
}

const commandRole = (command, description) => classifyCommand(command, description).role;

// MCP server name (mcp__<server>__<tool>) → role. Browser automation is UI testing.
const MCP_ROLES = [
  [/chrome|browser|playwright|puppeteer|selenium/, 'qa'],
  [/postgres|mysql|sqlite|supabase|mongo|redis|bigquery|snowflake|database|\bdb\b|prisma|neon|planetscale|turso/, 'dba'],
  [/figma|canva|design|excalidraw|tldraw/, 'ui-ux'],
  [/docs|notion|confluence|drive|sheets|slides|word|docx|coda|gitbook/, 'writer'],
  [/gmail|outlook|calendar|slack|teams|discord|zoom|granola/, 'pm'], // meetings and messages: coordination
  [/snyk|sonar|semgrep|socket|gitguardian/, 'security'],
  [/sentry|datadog|grafana|newrelic|honeycomb|vercel|netlify|cloudflare|aws|gcp|azure|docker|kubernetes|k8s|render|railway|fly/, 'devops'],
  [/github|gitlab|bitbucket/, 'architect'], // refined by the tool's name: see vcsRole
  [/jira|linear|asana|trello|monday|clickup|shortcut|youtrack/, 'pm'],
  [/stripe|twilio|sendgrid|resend|mailgun|paypal|xendit|midtrans/, 'backend'],
  [/context7|search|research|pubmed|consensus|scholar|arxiv|exa|tavily|perplexity|brave|wikipedia/, 'ba'],
];

/** GitHub / GitLab tools by what they do: issues are the backlog, PRs and releases ship, reviews review. */
function vcsRole(name) {
  if (/review|comment_on_pr|pull_request_review/.test(name)) return team.active.has('reviewer') ? 'reviewer' : 'architect';
  if (/(create|merge|update)_pull_request|release|workflow|actions|deploy|push_files|create_branch|tag/.test(name)) return 'devops';
  if (/issue|milestone|project|label/.test(name)) return 'pm';
  return 'architect'; // reading code, commits, diffs
}

function mcpRole(tool) {
  const [, server = '', name = ''] = tool.toLowerCase().split('__');
  for (const role of ['support', 'data']) if (signal(role, 'mcp')?.test(server)) return role;
  for (const [pattern, role] of MCP_ROLES) {
    if (!pattern.test(server)) continue;
    return /github|gitlab|bitbucket/.test(server) ? vcsRole(name) : role;
  }
  return 'claude';
}

// Skill name → role (Skill tool: `skill`). Unknown skills stay with the Lead.
const SKILL_ROLES = [
  [/security|permission/i, 'security'],
  [/code-review|review|simplify/i, 'reviewer'],
  [/test|qa|verify|^run$/i, 'qa'],
  [/design|figma|canvas|frontend|theme|artifact|ui|ux/i, 'ui-ux'],
  [/^init$|agents?-md|claude-md/i, 'architect'],
  [/docx?|pptx?|xlsx?|pdf|docs|writ|readme|changelog|grant|report|voice|content/i, 'writer'],
  [/dataviz|data|chart|sql|analy/i, 'data'],
  [/deploy|release|schedule|loop|cron|config|keybinding|statusline|setup|workflow|plugin|skill-creator/i, 'devops'],
  [/plan|scope|prd|brainstorm|roadmap|campaign/i, 'pm'],
  [/research|search|explore|lookup|where-things-live/i, 'ba'],
  [/claude-api|api|backend/i, 'backend'],
];
const skillRole = (name) => {
  const n = String(name ?? '').split(':').pop();
  if (!n) return 'claude';
  for (const [re, role] of SKILL_ROLES) if (re.test(n)) return role === 'data' && !team.active.has('data') ? 'backend' : role;
  return 'claude';
};

/** Guess who in the office would do this tool call when no subagent is involved: an active role or the Lead. */
export function inferRole(tool, input = {}, ctx = {}) {
  const task = taskOf(tool, input);
  const own = learnedRole(task?.key, ctx);
  if (own) return resolve(own);
  const role = ownerOf(tool, input);
  if (task?.unknown) learned.unknown?.(task.key, task.hint, ctx?.projectPath);
  return resolve(role);
}

/** What a learned mapping can be keyed on for this call, and whether the rules knew it ({ key, hint, unknown }). */
function taskOf(tool, input) {
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.toLowerCase().split('__');
    return server ? { key: `mcp:${server}`, hint: name, unknown: mcpRole(tool) === 'claude' } : null;
  }
  if (tool === 'Skill') {
    const name = String(input.skill ?? input.name ?? '').toLowerCase().trim();
    return name ? { key: `skill:${name}`, hint: name, unknown: skillRole(name) === 'claude' } : null;
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const c = classifyCommand(input.command, input.description);
    return c.subject ? { key: c.subject, hint: c.subject.split(':')[1], unknown: c.unknown === c.subject } : null;
  }
  return null;
}

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
      return commandRole(input.command, input.description);
    case 'Artifact':
      return 'ui-ux'; // a published page / report is design work
    case 'Skill':
      return skillRole(input.skill ?? input.name);
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
