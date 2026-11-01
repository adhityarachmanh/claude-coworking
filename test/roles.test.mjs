import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeTool, inferRole, loadAgentDefinitions, screenFor, toRole } from '../src/roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('agent types map to office roles', () => {
  const cases = {
    pm: 'pm', Explore: 'ba', Plan: 'architect', 'general-purpose': 'freelancer', fork: 'freelancer', 'claude-code-guide': 'writer',
    'statusline-setup': 'devops', 'code-reviewer': 'architect', 'frontend-developer': 'frontend',
    'backend-developer': 'backend', 'test-runner': 'qa', 'db-migrator': 'dba', 'security-auditor': 'security',
    'api-docs-writer': 'writer', 'ui-designer': 'ui-ux',
  };
  for (const [agent, role] of Object.entries(cases)) assert.equal(toRole(agent), role, agent);
  assert.equal(toRole('debugger'), null);
  assert.equal(toRole(undefined), null);
});

test('edited files are attributed to the owning role', () => {
  const cases = {
    'tests/Feature/LoginTest.php': 'qa', 'src/auth.spec.ts': 'qa', 'pkg/auth_test.go': 'qa', [String.raw`C:\p\tests\a.ts`]: 'qa',
    'src/Latest.ts': 'backend', 'docker-compose.yml': 'devops', Dockerfile: 'devops', '.github/workflows/ci.yml': 'devops',
    'README.md': 'writer', 'docs/guide.md': 'writer', 'src/docker/helper.ts': 'backend', 'database/migrations/x.php': 'dba',
    'prisma/schema.prisma': 'dba', 'resources/views/login.blade.php': 'frontend', 'src/components/Button.tsx': 'frontend',
    'src/styles/app.scss': 'ui-ux', 'app/Http/Controllers/AuthController.php': 'backend',
  };
  for (const [file, role] of Object.entries(cases)) assert.equal(inferRole('Edit', { file_path: file }), role, file);
});

test('commands are attributed by intent', () => {
  const cases = {
    'npm audit': 'security', 'php artisan test': 'qa', 'docker compose up -d': 'devops', 'git diff': 'architect',
    'git push origin main': 'devops', 'npx prisma migrate dev': 'dba', 'npm run build': 'devops', 'npm install axios': 'devops',
    'node server.js': 'backend', 'php artisan make:controller X': 'backend',
  };
  for (const [command, role] of Object.entries(cases)) assert.equal(inferRole('Bash', { command }), role, command);
  assert.equal(inferRole('Read', { file_path: 'docs/spec.md' }), 'ba');
  assert.equal(inferRole('TodoWrite', {}), 'pm');
  assert.equal(inferRole('mcp__x__y', {}), 'claude');
});

// Shapes taken from real Claude Code transcripts: chains, setup noise, keywords inside search patterns.
test('shell lines are judged by what they actually run', () => {
  const cases = {
    'grep -n "test" src/app.js': 'architect', // keyword inside a search is not running tests
    'cd /c/p && sed -n 1,40p src/db/migrate.js': 'architect',
    'S=/tmp/x; grep -rn "migration" app': 'architect',
    'sed -n 1,80p test/server.test.mjs': 'qa', // reading tests
    'sed -i "s/a/b/" src/a.js': 'backend', // editing, not reading
    'cd x && npm test 2>&1 | tail -20': 'qa',
    'ls; npm run build': 'devops',
    'OFFICE_PORT=4399 node server.js': 'backend',
    'Get-NetTCPConnection -LocalPort 4317': 'devops',
    'schtasks /Run /TN "Claude Coworking"': 'devops',
    'curl -s http://localhost:4317/api/config': 'qa',
    'curl -L -o node.zip https://x/node.zip': 'devops',
    'node --check public/js/app.js': 'qa',
    'php -l app/Models/User.php': 'qa',
    'pip install pytest': 'devops',
    'git commit -m "add tests for docker deploy"': 'backend', // words in a commit message are not the action
    'git log --oneline -5': 'architect',
    'git ls-files src': 'architect',
    '/c/php83/php.exe -l app/Models/User.php': 'qa',
  };
  for (const [command, role] of Object.entries(cases)) assert.equal(inferRole('Bash', { command }), role, command);
  assert.equal(screenFor('Bash', { command: 'grep -rn foo src' }), 'search');
  assert.equal(screenFor('Bash', { command: 'curl -s localhost:1' }), 'tests');
});

test('MCP servers and Artifact go to the matching specialist', () => {
  const cases = {
    'mcp__claude-in-chrome__computer': 'qa', mcp__playwright__click: 'qa', mcp__postgres__query: 'dba',
    mcp__figma__get_file: 'ui-ux', mcp__claude_ai_Claude_Docs__update: 'writer', mcp__github__create_issue: 'architect',
    mcp__sentry__issues: 'devops', mcp__linear__create: 'pm', Artifact: 'ui-ux', AskUserQuestion: 'claude', Skill: 'claude',
  };
  for (const [tool, role] of Object.entries(cases)) assert.equal(inferRole(tool, {}), role, tool);
  assert.equal(screenFor('mcp__claude-in-chrome__navigate', {}), 'browser');
});

test('monitor screens and labels', () => {
  assert.equal(screenFor('Bash', { command: 'npm test' }), 'tests');
  assert.equal(screenFor('Edit', { file_path: 'db/migrations/1.sql' }), 'db');
  assert.equal(screenFor('Grep', {}), 'search');
  assert.equal(describeTool('Edit', { file_path: 'src/a/b.ts' }), 'Mengedit b.ts');
  assert.equal(describeTool('mcp__github__create_issue', {}), 'Pakai github › create_issue');
});

test('all 15 role agents load with a prompt (the 4 optional roles included)', () => {
  const agents = loadAgentDefinitions(path.join(ROOT, '.claude', 'agents'));
  assert.deepEqual(Object.keys(agents).sort(), ['architect', 'ba', 'backend', 'data', 'dba', 'devops', 'frontend', 'mobile', 'pm', 'qa', 'reviewer', 'security', 'support', 'ui-ux', 'writer']);
  for (const [name, def] of Object.entries(agents)) {
    assert.ok(def.description.length > 20, `${name} description`);
    assert.ok(def.prompt.length > 100, `${name} prompt`);
  }
  assert.deepEqual(agents.security.tools, ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch']);
});
