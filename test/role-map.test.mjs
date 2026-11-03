// The full task → role map (docs/role-mapping.md) for the classic team. Optional roles: team.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASSIC_TEAM, DEFAULT_ENABLED } from '../src/role-catalog.js';
import { inferRole, setActiveRoles, toRole } from '../src/roles.js';

setActiveRoles(CLASSIC_TEAM);

const check = (cases, run, label) => {
  for (const [input, role] of Object.entries(cases)) assert.equal(run(input), role, `${label} ${input}`);
};

test('role map: edited files', () => {
  check({
    'jest.config.js': 'qa', 'test/fixtures/user.json': 'qa', '__mocks__/fs.js': 'qa', '.eslintrc.json': 'qa', 'biome.json': 'qa',
    LICENSE: 'security', 'THIRD_PARTY_NOTICES.txt': 'security', // compliance is off in the classic team 'SECURITY.md': 'security', 'certs/server.pem': 'security',
    '.github/dependabot.yml': 'security', 'CLAUDE.md': 'architect', '.claude/agents/qa.md': 'architect',
    '.claude/settings.json': 'devops', 'openapi.yaml': 'architect', 'api/user.proto': 'architect',
    'docs/adr/0001-db.md': 'architect', 'docs/architecture.md': 'architect', 'docs/prd-checkout.md': 'pm', 'ROADMAP.md': 'pm',
    'docs/requirements.md': 'ba', 'docs/user-stories.md': 'ba', 'docs/test-plan.md': 'qa', 'docs/runbook.md': 'devops',
    'docs/design-system.md': 'ui-ux', 'README.md': 'writer', 'docs/guide.md': 'writer', 'mkdocs.yml': 'writer',
    'package.json': 'devops', 'pnpm-lock.yaml': 'devops', 'tsconfig.json': 'devops', 'vite.config.ts': 'devops', Makefile: 'devops',
    '.gitignore': 'devops', 'scripts/setup.sh': 'devops', 'update.cmd': 'devops', 'fly.toml': 'devops', 'k8s/deploy.yaml': 'devops',
    'public/img/logo.png': 'ui-ux', 'assets/fonts/Inter.woff2': 'ui-ux', 'src/icons/x.svg': 'ui-ux',
    'locales/id.json': 'frontend', 'views/index.ejs': 'frontend', 'templates/mail.mjml': 'frontend', 'src/client/app.js': 'frontend',
    'db/app.sqlite': 'dba', 'drizzle/0001.sql': 'dba', 'src/routes/user.js': 'backend', 'server.js': 'backend',
    'logs/app.log': 'devops',
  }, (file_path) => inferRole('Edit', { file_path }), 'edit');
});

test('role map: read files (reading a generic doc is analysis; an app log is reproducing an issue)', () => {
  check({
    'docs/notes.md': 'ba', 'logs/app.log': 'qa', 'build.log': 'devops', 'src/a.js': 'backend', 'docs/adr/1.md': 'architect',
  }, (file_path) => inferRole('Read', { file_path }), 'read');
});

test('role map: shell commands', () => {
  check({
    // wrappers never hide the real command
    'timeout 600 npm test': 'qa', 'cmd /c npm run build': 'devops', 'powershell -NoProfile -Command "npm test"': 'qa', 'bash -c "pytest -q"': 'qa',
    'node --test test/a.test.mjs > /tmp/run.log 2>&1': 'qa',
    // reading a file is judged like Read
    'cat docs/runbook.md': 'devops', 'head -20 src/components/A.tsx': 'frontend', 'tail -50 logs/build.log': 'devops',
    'grep -E "pass|fail" /tmp/run.log': 'qa', 'ls src': 'architect', 'rg "TODO" src': 'architect',
    // QA: tests, coverage, load, lint, typecheck, probing a running app
    'npx vitest run': 'qa', 'go test ./...': 'qa', 'cargo test': 'qa', 'npm run coverage': 'qa', 'k6 run load.js': 'qa',
    'npx lighthouse http://localhost:3000': 'qa', 'npx eslint src': 'qa', 'npx tsc --noEmit': 'qa', 'mypy app': 'qa', 'npm run typecheck': 'qa',
    'curl -s localhost:4317/health': 'qa', 'node --check src/a.js': 'qa', 'node scripts/smoke.mjs': 'qa',
    // security
    'pip-audit': 'security', 'gitleaks detect': 'security', 'openssl req -new -x509': 'security', 'ssh-keygen -t ed25519': 'security', 'npm run audit': 'security',
    // dba
    'pg_dump app > app.sql': 'dba', 'npx drizzle-kit generate': 'dba', 'php artisan migrate': 'dba', 'python manage.py makemigrations': 'dba',
    'node scripts/seed.mjs': 'dba', 'npm run db:migrate': 'dba',
    // devops
    'docker build -t app .': 'devops', 'git pull --ff-only': 'devops', 'git tag v1.2.0': 'devops', 'gh release create v1': 'devops',
    'gh pr create --fill': 'devops', 'npm publish': 'devops', 'claude doctor': 'devops', 'opencode models': 'devops',
    'node scripts/restart.mjs': 'devops', 'make build': 'devops', 'pip install -r requirements.txt': 'devops',
    // frontend / backend
    'npx vite': 'frontend', 'npm run storybook': 'frontend', 'npx next dev': 'frontend', 'node server.js': 'backend',
    'git commit -m "fix tests"': 'backend', 'php artisan make:controller X': 'backend',
    // ui-ux, writer
    'npx svgo -f icons': 'ui-ux', 'node scripts/make-icons.mjs': 'ui-ux', 'npx typedoc': 'writer', 'mkdocs build': 'writer',
    // formatters: whoever owns the file
    'npx prettier --write src/styles/app.css': 'ui-ux', 'black app/models.py': 'backend',
    // architect / pm
    'git log --oneline -5': 'architect', 'gh pr view 3': 'architect', 'gh pr review 12': 'architect', 'gh issue list': 'pm',
    // waiting is the Lead's
    'sleep 30': 'claude', 'Start-Sleep -Seconds 5': 'claude',
  }, (command) => inferRole('Bash', { command }), 'bash');
});

test('role map: the Bash description decides only when the command says nothing', () => {
  assert.equal(inferRole('Bash', { command: 'node -e "console.log(1)"', description: 'Verifikasi hasil parsing' }), 'qa');
  assert.equal(inferRole('Bash', { command: 'node x.mjs', description: 'Restart server' }), 'devops');
  assert.equal(inferRole('Bash', { command: 'npm test', description: 'Restart server' }), 'qa');
});

test('role map: MCP tools', () => {
  check({
    mcp__github__create_pull_request: 'devops', mcp__github__create_issue: 'pm', mcp__github__get_file_contents: 'architect',
    mcp__github__create_pull_request_review: 'architect', mcp__slack__post_message: 'pm', mcp__gmail__send: 'pm',
    mcp__notion__create_page: 'writer', mcp__snyk__scan: 'security', mcp__stripe__create_customer: 'backend',
    mcp__context7__get_docs: 'ba', mcp__playwright__click: 'qa', mcp__supabase__execute_sql: 'dba', mcp__sentry__issues: 'devops',
    mcp__linear__create_issue: 'pm', mcp__unknown__x: 'claude',
  }, (tool) => inferRole(tool, {}), 'mcp');
});

test('role map: skills', () => {
  check({
    'security-review': 'security', 'code-review': 'architect', simplify: 'architect', run: 'qa', docx: 'writer', pdf: 'writer',
    'update-config': 'devops', schedule: 'devops', init: 'architect', 'claude-api': 'backend', dataviz: 'backend', whatever: 'claude',
  }, (skill) => inferRole('Skill', { skill }), 'skill');
});

test('role map: agent types', () => {
  check({
    general: 'freelancer', 'code-explorer': 'ba', 'accessibility-auditor': 'ui-ux', 'api-designer': 'architect',
    'nextjs-developer': 'frontend', 'tailwind-expert': 'frontend', 'postgres-pro': 'dba', 'kubernetes-specialist': 'devops',
    'terraform-engineer': 'devops', 'performance-engineer': 'qa', 'error-debugger': 'qa', 'payment-integration': 'backend',
    copywriter: 'writer', translator: 'writer', 'devsecops-engineer': 'security', 'requirements-analyst': 'ba',
  }, toRole, 'agent');
});

test('role map: optional roles take their work while on', () => {
  setActiveRoles(DEFAULT_ENABLED);
  try {
    assert.equal(inferRole('Read', { file_path: 'logs/app.log' }), 'support');
    assert.equal(inferRole('Skill', { skill: 'code-review' }), 'reviewer');
    assert.equal(inferRole('Skill', { skill: 'dataviz' }), 'data');
    assert.equal(inferRole('mcp__github__create_pull_request_review', {}), 'reviewer');
    assert.equal(inferRole('Edit', { file_path: 'LICENSE' }), 'compliance');
  } finally {
    setActiveRoles(CLASSIC_TEAM);
  }
});
