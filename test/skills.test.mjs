// 🧩 Skills (src/skills.js): the SKILL.md files each engine reads, without a terminal. Pure rules only: front
// matter parsing, id validation, and where each engine looks for skills (Claude Code: .claude/skills; OpenCode
// 2.3.2: .opencode/skills plus the .claude/skills and .agents/skills compatibility roots, global and per project).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deleteSkill, listSkills, parseSkillFrontmatter, readSkill, saveSkill, SkillError, skillDir, skillRoots, validSkillId } from '../src/skills.js';

test('validSkillId: huruf kecil/angka/minus, 1–64 char', () => {
  assert.equal(validSkillId('git-release'), true);
  assert.equal(validSkillId('a'.repeat(64)), true);
  assert.equal(validSkillId('a'.repeat(65)), false);
  assert.equal(validSkillId('Git'), false);
  assert.equal(validSkillId('../evil'), false);
  assert.equal(validSkillId('a/b'), false);
  assert.equal(validSkillId('-x'), false);
  // Windows device names are refused (a folder named "con" is unusable).
  for (const name of ['con', 'prn', 'aux', 'nul', 'com1', 'lpt9']) assert.equal(validSkillId(name), false, name);
  assert.equal(validSkillId(''), false);
});

test('parseSkillFrontmatter: key:value sederhana + body; tanpa frontmatter = meta kosong', () => {
  const { meta, body } = parseSkillFrontmatter('---\nname: Git Release\ndescription: "Buat rilis"\n---\n\nLangkah…\n');
  assert.equal(meta.name, 'Git Release');
  assert.equal(meta.description, 'Buat rilis');
  assert.match(body, /Langkah/);
  assert.deepEqual(parseSkillFrontmatter('# Tanpa frontmatter').meta, {});
});

test('parseSkillFrontmatter: description blok YAML (>- dan |) terbaca sebagai teks', () => {
  const folded = parseSkillFrontmatter('---\nname: Neon\ndescription: >-\n  Skill untuk Neon\n  auth dan data.\n---\n\nIsi\n');
  assert.equal(folded.meta.description, 'Skill untuk Neon auth dan data.');
  const literal = parseSkillFrontmatter('---\nname: X\ndescription: |\n  Baris satu\n  baris dua\n---\nIsi\n');
  assert.equal(literal.meta.description, 'Baris satu\nbaris dua');
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

test('read→save round-trip: body tidak menggandakan frontmatter, meta asing tetap utuh di file', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const dir = path.join(project, '.claude', 'skills', 'git-release');
  mkdirSync(dir, { recursive: true });
  const original = '---\nname: Git Release\ndescription: Buat rilis\nlicense: MIT\n---\n\nLangkah A\nLangkah B\n';
  writeFileSync(path.join(dir, 'SKILL.md'), original);
  const r = readSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'git-release' });
  assert.equal(r.content, 'Langkah A\nLangkah B\n', 'content adalah body, tanpa frontmatter');
  saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'git-release', name: 'Git Release', description: 'Buat rilis', content: r.content, dataDir, baseMtime: r.mtime });
  const written = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.equal((written.match(/^---$/gm) || []).length, 2, 'tepat satu blok frontmatter');
  assert.equal(written, original, 'simpan tanpa perubahan menghasilkan file yang sama (meta asing dipertahankan)');
});

test('rename: baseMtime file lama dipakai, direktori lama dihapus + SKILL.md-nya dibackup', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const oldDir = path.join(project, '.claude', 'skills', 'old');
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(path.join(oldDir, 'SKILL.md'), '---\nname: Old\ndescription: x\n---\n\nbody\n');
  writeFileSync(path.join(oldDir, 'helper.md'), 'support\n');
  const loaded = readSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'old' });
  const r = saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'new', previous: 'old', name: 'New', description: 'y', content: 'isi baru\n', dataDir, baseMtime: loaded.mtime });
  assert.equal(r.backedUp, true, 'SKILL.md lama dibackup');
  assert.ok(!existsSync(oldDir), 'direktori lama hilang');
  const backups = readdirSync(path.join(dataDir, 'skills-backups'), { recursive: true }).filter((f) => String(f).endsWith('SKILL.md'));
  assert.equal(backups.length, 1, 'satu backup dari file lama');
  assert.match(readFileSync(path.join(project, '.claude', 'skills', 'new', 'SKILL.md'), 'utf8'), /isi baru/);
});

test('rename lintas scope: previousSource dipakai untuk menemukan file lama', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const oldDir = path.join(project, '.claude', 'skills', 'move-me');
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(path.join(oldDir, 'SKILL.md'), '---\nname: M\ndescription: x\n---\n\nbody\n');
  const loaded = readSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'move-me' });
  const r = saveSkill({ engine: 'claude', projectPath: project, home, scope: 'user', source: '~/.claude/skills (semua project)', id: 'move-me', previous: 'move-me', previousScope: 'project', previousSource: '.claude/skills (project)', name: 'M', description: 'x', content: 'body\n', dataDir, baseMtime: loaded.mtime });
  assert.equal(r.backedUp, true);
  assert.ok(!existsSync(oldDir), 'folder project lama hilang');
  assert.ok(existsSync(path.join(home, '.claude', 'skills', 'move-me', 'SKILL.md')), 'skill pindah ke folder user');
});

test('saveSkill: previous tak sah ditolak 400, tidak membuat direktori yatim', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  assert.throws(() => saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'x', previous: '../evil', name: 'x', description: 'y', content: 'z', dataDir }), (e) => e instanceof SkillError && e.status === 400);
});

test('saveSkill: symlink direktori skill ditolak (tidak menulis keluar root)', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'out-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
  const link = path.join(project, '.claude', 'skills', 'link');
  try {
    symlinkSync(outside, link, 'junction');
  } catch {
    return t.skip('no privilege for symlinks here: nothing to assert');
  }
  // Some Windows setups create the junction but Node cannot traverse it (UNKNOWN on stat/realpath); the guard still
  // matters where junctions do work, so skip instead of failing the suite on such a machine.
  if (!existsSync(link)) return t.skip('junction is not readable in this environment');
  assert.throws(() => saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'link', name: 'x', description: 'y', content: 'ESCAPED\n', dataDir }), (e) => e instanceof SkillError && e.status === 409);
  assert.ok(!existsSync(path.join(outside, 'SKILL.md')), 'tidak ada file yang ditulis di luar root');
});

test('saveSkill: hasil akhir (dengan frontmatter) melewati 256 KB ditolak, jadi file tetap bisa dibuka', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  assert.throws(() => saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'big', name: 'x'.repeat(200), description: 'y'.repeat(200), content: 'a'.repeat(262_100), dataDir }), (e) => e instanceof SkillError && e.status === 413);
});

test('skillDir: pasangan scope+source yang tidak cocok ditolak 400', () => {
  assert.throws(() => skillDir({ engine: 'claude', projectPath: 'C:/p', home: 'C:/h', scope: 'user', source: '.claude/skills (project)', id: 'x' }), (e) => e instanceof SkillError && e.status === 400);
});

test('symlink pada root skill ditolak: save & delete tidak menyentuh apa pun di luar project', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'out-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  mkdirSync(path.join(outside, 'victim'), { recursive: true });
  writeFileSync(path.join(outside, 'victim', 'precious.txt'), 'x');
  mkdirSync(path.join(project, '.claude'), { recursive: true });
  const link = path.join(project, '.claude', 'skills');
  try {
    symlinkSync(outside, link, 'junction');
  } catch {
    return t.skip('no privilege for symlinks here: nothing to assert');
  }
  // Some Windows setups create the junction but Node cannot traverse it (UNKNOWN on stat/realpath); the guard still
  // matters where junctions do work, so skip instead of failing the suite on such a machine.
  if (!existsSync(link)) return t.skip('junction is not readable in this environment');
  const args = { engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)' };
  assert.throws(() => saveSkill({ ...args, id: 'baru', name: 'x', description: 'y', content: 'z', dataDir }), (e) => e instanceof SkillError && e.status === 409);
  assert.ok(!existsSync(path.join(outside, 'baru', 'SKILL.md')), 'tidak ada folder yang dibuat di luar project');
  assert.throws(() => deleteSkill({ ...args, id: 'victim', dataDir }), (e) => e instanceof SkillError && e.status === 409);
  assert.ok(existsSync(path.join(outside, 'victim', 'precious.txt')), 'isi folder luar tidak terhapus');
  assert.equal(listSkills({ engine: 'claude', projectPath: project, home }).length, 0, 'tidak ada skill dari luar yang terdaftar');
});

test('backup: SKILL.md berupa symlink tidak disalin ke folder data app', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const secret = path.join(mkdtempSync(path.join(tmpdir(), 'sec-')), 'id_rsa');
  writeFileSync(secret, 'RAHASIA');
  const dir = path.join(project, '.claude', 'skills', 'linked');
  mkdirSync(dir, { recursive: true });
  try {
    symlinkSync(secret, path.join(dir, 'SKILL.md'), 'file');
  } catch {
    return; // no privilege for symlinks here: nothing to assert
  }
  const r = deleteSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'linked', dataDir });
  assert.equal(r.backedUp, false, 'symlink tidak dibackup');
  const backups = existsSync(path.join(dataDir, 'skills-backups')) ? readdirSync(path.join(dataDir, 'skills-backups'), { recursive: true }) : [];
  assert.ok(!backups.some((f) => String(f).includes('linked')), 'tidak ada salinan rahasia di folder data app');
});

test('listSkills: root ber-precedence lebih tinggi menang, dan skill nyata tidak tersembunyi oleh root tertolak', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const write = (dir, text) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), text);
  };
  // Same id in two OpenCode roots: .opencode/skills is the higher-precedence one and must win.
  write(path.join(project, '.claude', 'skills', 'dup'), '---\nname: dup\ndescription: kompat\n---\n\nx\n');
  write(path.join(project, '.opencode', 'skills', 'dup'), '---\nname: dup\ndescription: aktif\n---\n\nx\n');
  const oc = listSkills({ engine: 'opencode', projectPath: project, home });
  assert.equal(oc.filter((s) => s.id === 'dup').length, 1, 'satu baris per id');
  assert.equal(oc.find((s) => s.id === 'dup').source, '.opencode/skills (project)', 'root ber-precedence lebih tinggi menang');
  // A refused root (junction) must not shadow a real skill of the same id in another root.
  const outside = mkdtempSync(path.join(tmpdir(), 'out-'));
  write(path.join(outside, 'real'), '---\nname: real\ndescription: luar\n---\n\nx\n');
  const proj2 = mkdtempSync(path.join(tmpdir(), 'p2-'));
  write(path.join(proj2, '.opencode', 'skills', 'real'), '---\nname: real\ndescription: dalam\n---\n\nx\n');
  mkdirSync(path.join(proj2, '.claude'), { recursive: true });
  try {
    symlinkSync(outside, path.join(proj2, '.claude', 'skills'), 'junction');
  } catch {
    return; // no privilege for symlinks here
  }
  const oc2 = listSkills({ engine: 'opencode', projectPath: proj2, home });
  assert.equal(oc2.filter((s) => s.id === 'real').length, 1, 'skill nyata tetap terdaftar');
  assert.equal(oc2.find((s) => s.id === 'real').description, 'dalam');
});

test('saveSkill: folder skill berupa symlink (menunjuk di dalam project) tetap ditolak', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  mkdirSync(path.join(project, 'src', 'config'), { recursive: true });
  mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
  const link = path.join(project, '.claude', 'skills', 'x');
  try {
    symlinkSync(path.join(project, 'src', 'config'), link, 'junction');
  } catch {
    return t.skip('no privilege for symlinks here');
  }
  // Some Windows setups create the junction but Node cannot traverse it (UNKNOWN on stat/realpath). The guard still
  // matters where junctions do work, so skip instead of failing the suite on such a machine (same guard as the
  // OpenCode config junction test).
  if (!existsSync(link)) return t.skip('junction is not readable in this environment');
  const args = { engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'x' };
  assert.throws(() => saveSkill({ ...args, name: 'x', description: 'y', content: 'OVERWRITE\n', dataDir }), (e) => e instanceof SkillError && e.status === 409);
  assert.ok(!existsSync(path.join(project, 'src', 'config', 'SKILL.md')), 'tidak menulis lewat symlink di dalam project');
});

test('frontmatter: list YAML & key ber-slash dipertahankan apa adanya saat simpan', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const dir = path.join(project, '.claude', 'skills', 'rich');
  mkdirSync(dir, { recursive: true });
  const original = '---\nname: Rich\ndescription: kaya\nallowed-tools:\n  - Read\n  - Grep\nmetadata.opencode/autoinvoke: false\n---\n\nbody\n';
  writeFileSync(path.join(dir, 'SKILL.md'), original);
  const r = readSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'rich' });
  saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'rich', name: 'Rich', description: 'kaya', content: r.content, dataDir, baseMtime: r.mtime });
  assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), original, 'frontmatter asli utuh');
});

test('rename: berkas pendukung ikut pindah ke folder baru', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const oldDir = path.join(project, '.claude', 'skills', 'with-files');
  mkdirSync(path.join(oldDir, 'scripts'), { recursive: true });
  writeFileSync(path.join(oldDir, 'SKILL.md'), '---\nname: W\ndescription: x\n---\n\nbody\n');
  writeFileSync(path.join(oldDir, 'scripts', 'run.mjs'), 'console.log(1);\n');
  const loaded = readSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'with-files' });
  saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'with-files-2', previous: 'with-files', name: 'W', description: 'x', content: 'body\n', dataDir, baseMtime: loaded.mtime });
  assert.ok(existsSync(path.join(project, '.claude', 'skills', 'with-files-2', 'scripts', 'run.mjs')), 'berkas pendukung ikut');
  assert.ok(!existsSync(oldDir), 'folder lama hilang');
});

test('backup: hanya MAX_BACKUPS salinan terakhir yang disimpan per skill', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const dir = path.join(project, '.claude', 'skills', 'many');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: many\ndescription: y\n---\n\nisi\n');
  const args = { engine: 'claude', projectPath: project, home, scope: 'project', source: '.claude/skills (project)', id: 'many', name: 'many', description: 'y', content: 'isi\n', dataDir };
  for (let i = 0; i < 25; i++) saveSkill({ ...args, baseMtime: readSkill(args).mtime });
  const folder = path.join(dataDir, 'skills-backups', path.basename(project));
  const count = readdirSync(folder).filter((f) => f.endsWith('SKILL.md')).length;
  assert.ok(count <= 20, `maks 20 backup, dapat ${count}`);
});
