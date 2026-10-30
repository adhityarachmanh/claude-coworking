import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeTool, inferRole, loadAgentDefinitions, screenFor, toRole } from '../src/roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('agent types map to office roles', () => {
  const cases = {
    pm: 'pm', Explore: 'ba', Plan: 'pm', 'general-purpose': 'backend', 'claude-code-guide': 'writer',
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
    'git push origin main': 'devops', 'npx prisma migrate dev': 'dba', 'npm run build': 'devops', 'npm install axios': 'backend',
  };
  for (const [command, role] of Object.entries(cases)) assert.equal(inferRole('Bash', { command }), role, command);
  assert.equal(inferRole('Read', { file_path: 'docs/spec.md' }), 'ba');
  assert.equal(inferRole('TodoWrite', {}), 'pm');
  assert.equal(inferRole('mcp__x__y', {}), 'claude');
});

test('monitor screens and labels', () => {
  assert.equal(screenFor('Bash', { command: 'npm test' }), 'tests');
  assert.equal(screenFor('Edit', { file_path: 'db/migrations/1.sql' }), 'db');
  assert.equal(screenFor('Grep', {}), 'search');
  assert.equal(describeTool('Edit', { file_path: 'src/a/b.ts' }), 'Mengedit b.ts');
  assert.equal(describeTool('mcp__github__create_issue', {}), 'Pakai github › create_issue');
});

test('all 11 role agents load with a prompt', () => {
  const agents = loadAgentDefinitions(path.join(ROOT, '.claude', 'agents'));
  assert.deepEqual(Object.keys(agents).sort(), ['architect', 'ba', 'backend', 'dba', 'devops', 'frontend', 'pm', 'qa', 'security', 'ui-ux', 'writer']);
  for (const [name, def] of Object.entries(agents)) {
    assert.ok(def.description.length > 20, `${name} description`);
    assert.ok(def.prompt.length > 100, `${name} prompt`);
  }
  assert.deepEqual(agents.security.tools, ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch']);
});
