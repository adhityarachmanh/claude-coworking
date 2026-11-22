// 🧩 Skills (src/skills.js): the SKILL.md files each engine reads, without a terminal. Pure rules only: front
// matter parsing, id validation, and where each engine looks for skills (Claude Code: .claude/skills; OpenCode
// 2.3.2: .opencode/skills plus the .claude/skills and .agents/skills compatibility roots, global and per project).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deleteSkill, listSkills, parseSkillFrontmatter, readSkill, saveSkill, SkillError, skillRoots, validSkillId } from '../src/skills.js';

test('validSkillId: huruf kecil/angka/minus, 1–64 char', () => {
  assert.equal(validSkillId('git-release'), true);
  assert.equal(validSkillId('a'.repeat(64)), true);
  assert.equal(validSkillId('a'.repeat(65)), false);
  assert.equal(validSkillId('Git'), false);
  assert.equal(validSkillId('../evil'), false);
  assert.equal(validSkillId('a/b'), false);
  assert.equal(validSkillId('-x'), false);
  assert.equal(validSkillId(''), false);
});

test('parseSkillFrontmatter: key:value sederhana + body; tanpa frontmatter = meta kosong', () => {
  const { meta, body } = parseSkillFrontmatter('---\nname: Git Release\ndescription: "Buat rilis"\n---\n\nLangkah…\n');
  assert.equal(meta.name, 'Git Release');
  assert.equal(meta.description, 'Buat rilis');
  assert.match(body, /Langkah/);
  assert.deepEqual(parseSkillFrontmatter('# Tanpa frontmatter').meta, {});
});

test('skillRoots: Claude & OpenCode, project + user, precedence naik', () => {
  const claude = skillRoots({ engine: 'claude', projectPath: 'C:/p', home: 'C:/h' }).map((r) => r.dir.replace(/\\/g, '/'));
  assert.ok(claude.some((d) => d.endsWith('p/.claude/skills')), 'project .claude/skills');
  assert.ok(claude.some((d) => d.endsWith('h/.claude/skills')), 'user ~/.claude/skills');
  const oc = skillRoots({ engine: 'opencode', projectPath: 'C:/p', home: 'C:/h' }).map((r) => r.dir.replace(/\\/g, '/'));
  assert.ok(oc.some((d) => d.endsWith('p/.opencode/skills')));
  assert.ok(oc.some((d) => d.endsWith('h/.config/opencode/skills')));
  assert.ok(oc.some((d) => d.endsWith('p/.claude/skills')), 'kompat .claude/skills');
});

test('listSkills: id dari nama direktori, description dibaca, file pendukung ditandai', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dir = path.join(project, '.claude', 'skills', 'git-release');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Git Release\ndescription: Buat rilis\n---\n\nisi\n');
  writeFileSync(path.join(dir, 'notes.md'), 'x');
  const list = listSkills({ engine: 'claude', projectPath: project, home });
  const found = list.find((s) => s.id === 'git-release');
  assert.ok(found);
  assert.equal(found.description, 'Buat rilis');
  assert.equal(found.scope, 'project');
  assert.equal(found.hasSupport, true);
});

test('listSkills: SKILL.md tanpa description tetap muncul dengan penanda, tidak menggagalkan daftar', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dir = path.join(project, '.claude', 'skills', 'broken');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '# tanpa frontmatter\n');
  const found = listSkills({ engine: 'claude', projectPath: project, home }).find((s) => s.id === 'broken');
  assert.ok(found);
  assert.equal(found.description, '');
});

test('saveSkill: menulis SKILL.md + backup file lama', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const dir = path.join(project, '.claude', 'skills', 'git-release');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Old\ndescription: old\n---\n\nlama\n');
  const loaded = readSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'git-release' });
  const r = saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'git-release', name: 'Git Release', description: 'Buat rilis', content: 'Langkah baru\n', dataDir, baseMtime: loaded.mtime });
  assert.equal(r.backedUp, true);
  const written = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(written, /name: Git Release/);
  assert.match(written, /Langkah baru/);
  assert.ok(existsSync(path.join(dataDir, 'skills-backups')), 'backup dibuat');
});

test('saveSkill: id tak sah ditolak tanpa menyentuh fs', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  assert.throws(() => saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: '../evil', name: 'x', description: 'y', content: 'z', dataDir }), (e) => e instanceof SkillError && e.status === 400);
});

test('saveSkill: file berubah sejak dibuka → 409', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const dir = path.join(project, '.claude', 'skills', 'x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');
  const loaded = readSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'x' });
  assert.throws(() => saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'x', name: 'x', description: 'y', content: 'z', dataDir, baseMtime: loaded.mtime - 5000 }), (e) => e instanceof SkillError && e.status === 409);
});

test('deleteSkill: menghapus direktori skill, membackup bila ada', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const dir = path.join(project, '.claude', 'skills', 'gone');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: gone\ndescription: y\n---\n');
  const r = deleteSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'gone', dataDir });
  assert.equal(r.ok, true);
  assert.equal(existsSync(dir), false);
});
