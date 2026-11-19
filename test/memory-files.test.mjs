// 🧠 Memory files (src/memory-files.js): which instruction files each engine actually reads, and the OpenCode
// 2.3.1 CLAUDE.md fallback (#64474/#64533: OpenCode reads CLAUDE.md in any directory that has no AGENTS.md, and
// falls back to ~/.claude/CLAUDE.md when the global AGENTS.md is missing).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { memoryFiles, readMemory, writeMemory } from '../src/memory-files.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-memfiles-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const project = () => mkdtempSync(path.join(TMP, 'proj-'));
const home = () => mkdtempSync(path.join(TMP, 'home-'));

test('Claude Code memory: project, local (private), and user files; only the user file is user-scope', () => {
  const files = memoryFiles('claude', project(), home());
  assert.deepEqual(files.map((f) => f.key), ['project', 'local', 'user']);
  assert.deepEqual(files.map((f) => f.scope), ['project', 'project', 'user']);
});

test('OpenCode memory: AGENTS.md, plus the CLAUDE.md fallback OpenCode reads when no AGENTS.md exists (#64474)', () => {
  const p = project();
  // A fresh project (neither file) and a fresh home: OpenCode would read both CLAUDE.md fallbacks, so both are offered.
  let files = memoryFiles('opencode', p, home());
  assert.deepEqual(files.map((f) => f.key), ['project', 'project-claude', 'user', 'user-claude']);
  assert.deepEqual(files.map((f) => f.scope), ['project', 'project', 'user', 'user']);

  // A project AGENTS.md exists: it wins, and the project CLAUDE.md fallback drops out of the list.
  writeFileSync(path.join(p, 'AGENTS.md'), '# Aturan\n');
  files = memoryFiles('opencode', p, home());
  assert.deepEqual(files.map((f) => f.key), ['project', 'user', 'user-claude'], 'AGENTS.md present: project fallback gone');

  // ...but a CLAUDE.md already on disk stays visible, so it can still be edited (the hint explains precedence).
  writeFileSync(path.join(p, 'CLAUDE.md'), '# Lama\n');
  files = memoryFiles('opencode', p, home());
  assert.deepEqual(files.map((f) => f.key), ['project', 'project-claude', 'user', 'user-claude'], 'an existing CLAUDE.md stays editable');
});

test('OpenCode memory: the global CLAUDE.md fallback follows the same rule as the project one', () => {
  const p = project();
  const writeGlobal = (h, name, text) => {
    mkdirSync(path.dirname(path.join(h, name)), { recursive: true });
    writeFileSync(path.join(h, name), text);
  };
  // A global AGENTS.md exists: the global CLAUDE.md fallback drops out.
  let h = home();
  writeGlobal(h, '.config/opencode/AGENTS.md', '# Global\n');
  assert.deepEqual(memoryFiles('opencode', p, h).map((f) => f.key), ['project', 'project-claude', 'user'], 'global AGENTS.md present: no global fallback');
  // ...but an existing ~/.claude/CLAUDE.md stays visible (it may steer other tools too).
  h = home();
  writeGlobal(h, '.config/opencode/AGENTS.md', '# Global\n');
  writeGlobal(h, '.claude/CLAUDE.md', '# Claude\n');
  assert.deepEqual(memoryFiles('opencode', p, h).map((f) => f.key), ['project', 'project-claude', 'user', 'user-claude'], 'an existing global CLAUDE.md stays editable');
});

test('OpenCode memory: the CLAUDE.md fallback round-trips through read (missing = empty) and write (atomic)', () => {
  const p = project();
  const h = home();
  assert.equal(readMemory('opencode', p, 'project-claude', h).exists, false);
  const saved = writeMemory('opencode', p, 'project-claude', '# Aturan lama\n', 0, h);
  assert.equal(saved.key, 'project-claude');
  assert.equal(readFileSync(path.join(p, 'CLAUDE.md'), 'utf8'), '# Aturan lama\n');
});