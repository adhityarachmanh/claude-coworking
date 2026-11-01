import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeTool, inferRole, loadAgentDefinitions, screenFor, toRole, setActiveRoles } from '../src/roles.js';
import { CLASSIC_TEAM } from '../src/role-catalog.js';

// These cases pin the classic 12-role mapping; the four optional roles are covered in team.test.mjs.
setActiveRoles(CLASSIC_TEAM);

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

test('all 16 role agents load with a prompt (the 5 optional roles included)', () => {
  const agents = loadAgentDefinitions(path.join(ROOT, '.claude', 'agents'));
  assert.deepEqual(Object.keys(agents).sort(), ['architect', 'ba', 'backend', 'compliance', 'data', 'dba', 'devops', 'frontend', 'mobile', 'pm', 'qa', 'reviewer', 'security', 'support', 'ui-ux', 'writer']);
  for (const [name, def] of Object.entries(agents)) {
    assert.ok(def.description.length > 20, `${name} description`);
    assert.ok(def.prompt.length > 100, `${name} prompt`);
  }
  assert.deepEqual(agents.security.tools, ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch']);
});

test('shell lines are described as what the person is doing, not the raw command', () => {
  const label = (command, description) => describeTool('Bash', { command, description });
  // Claude Code's own description wins (capitalised, bounded).
  assert.equal(label('npm test', 'run full test suite'), 'Run full test suite');
  assert.equal(label('x', 'Menjalankan test checkout'), 'Menjalankan test checkout');
  assert.equal(describeTool('PowerShell', { command: 'Get-Process', description: '' }), 'Mengecek proses');
  // Without one: a phrase for common commands, judged across the chain by priority.
  const cases = {
    "python - <<'EOF'\np='test/ui.test.mjs'": 'Menjalankan skrip kecil',
    'cd /c/x && npm test 2>&1 | tail -8': 'Menjalankan test',
    'node --test --test-isolation=none test/team.test.mjs': 'Menjalankan test',
    'git status --short; git log --oneline -3': 'Mengecek perubahan di git',
    'git add -A && git commit -q -m "fix tests"': 'Membuat commit',
    'GIT_TERMINAL_PROMPT=0 timeout 60 git push origin main': 'Push ke repository',
    'sed -n 1,40p src/roles.js': 'Membaca roles.js',
    'grep -rn "foo" src': 'Mencari di kode',
    '"C:/nvm/node.exe" scripts/restart.mjs': 'Menjalankan restart.mjs',
    'npx --yes eslint@9.39.5 .': 'Mengecek kualitas kode (lint)',
    'npm install zod': 'Memasang dependency',
    'docker compose up -d': 'Mengurus container',
    "cat > /tmp/newtest.txt <<'JSEOF'\ntest('x')": 'Menulis newtest.txt',
    'wc -l notes.txt': 'Menghitung baris notes.txt',
  };
  for (const [command, expected] of Object.entries(cases)) assert.equal(label(command), expected, command);
  // Unknown commands name the program only: arguments, paths and secrets never reach the bubble.
  assert.equal(label('some-weird-tool --flag --token=abc123'), 'Menjalankan some-weird-tool');
  assert.equal(label('"C:/Tools/My App/run.exe" --password hunter2'), 'Menjalankan run');
  assert.equal(label(''), 'Menjalankan perintah');
  for (const c of ['deploy-secret --key=SECRET123', `unknown-cmd ${'x'.repeat(200)}`]) assert.doesNotMatch(label(c), /SECRET123|xxxx|--/);
});

test('stored shell rows from before the human labels are relabelled from their own input when loaded', async () => {
  const { relabelShellRows } = await import('../src/hub.js');
  const chats = {
    p1: [
      { kind: 'tool', tool: 'Bash', text: "$ cat > /tmp/fix11.mjs <<'EOF' import { readFileSync…", input: { command: "cat > /tmp/fix11.mjs <<'EOF'\nimport x" } },
      { kind: 'tool', tool: 'Bash', text: '$ timeout 300 node --test …', input: { command: 'timeout 300 node --test x', description: 'Menjalankan test server' } },
      { kind: 'tool', tool: 'Read', text: 'Membaca a.js', input: { file_path: 'a.js' } },
      { kind: 'text', text: '$ not a tool row' },
    ],
  };
  assert.equal(relabelShellRows(chats), 2);
  assert.deepEqual(chats.p1.map((m) => m.text), ['Menulis fix11.mjs', 'Menjalankan test server', 'Membaca a.js', '$ not a tool row']);
  assert.equal(relabelShellRows(chats), 0, 'idempotent');
  assert.equal(relabelShellRows(null), 0);
});
