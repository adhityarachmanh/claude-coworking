import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSecretPath, languageOf } from '../src/file-view.js';

test('likely secrets: .env*, keys, id_*, credentials and key folders; examples and public keys are not', () => {
  const secret = ['.env', '.env.local', '.env.production', 'app/.ENV', 'certs/server.pem', 'tls.key', 'store.p12', 'id_rsa', 'id_ed25519', '.ssh/config', '.aws/config', 'credentials', 'credentials.json', 'gcp-credentials.json', '.npmrc', '.netrc', '.git-credentials', 'secrets.yaml', 'config\\secrets.json', 'service-account-prod.json'];
  const plain = ['.env.example', '.env.sample', '.env.template', 'id_rsa.pub', 'src/env.ts', 'README.md', 'src/keyboard.js', 'docs/credentials.md', 'environment.yml', 'src/identity.js'];
  for (const p of secret) assert.ok(isSecretPath(p), p);
  for (const p of plain) assert.ok(!isSecretPath(p), p);
});

test('language from the file name', () => {
  const cases = { 'a.js': 'js', 'b.MJS': 'js', 'c.tsx': 'ts', 'Dockerfile': 'dockerfile', '.env.local': 'env', 'x.py': 'py', 'run.ps1': 'ps1', 'q.sql': 'sql', 'conf.yml': 'yaml', 'LICENSE': 'text', 'notes.weird': 'text', Makefile: 'sh' };
  for (const [name, lang] of Object.entries(cases)) assert.equal(languageOf(name), lang, name);
});

test('a bare file name from Claude\'s prose is found below the project (once), never outside it', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { resolveProjectFile } = await import('../src/file-view.js');
  const root = mkdtempSync(path.join(tmpdir(), 'office-find-'));
  try {
    for (const f of ['test/server.test.mjs', 'src/a/util.js', 'lib/util.js', 'node_modules/pkg/hidden.js', 'README.md']) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), 'x');
    }
    assert.equal((await resolveProjectFile(root, 'server.test.mjs')).rel, 'test/server.test.mjs', 'unique name → that file');
    assert.equal((await resolveProjectFile(root, 'README.md')).rel, 'README.md', 'an exact path still wins');
    await assert.rejects(resolveProjectFile(root, 'util.js'), (e) => e.status === 404 && /beberapa file bernama util\.js: (src\/a\/util\.js|lib\/util\.js), (src\/a\/util\.js|lib\/util\.js)/.test(e.message));
    await assert.rejects(resolveProjectFile(root, 'hidden.js'), (e) => e.status === 404, 'node_modules is not searched');
    await assert.rejects(resolveProjectFile(root, 'missing/server.test.mjs'), (e) => e.status === 404, 'only bare names are looked up');
    await assert.rejects(resolveProjectFile(root, '../server.test.mjs'), (e) => e.status === 403);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file outside the project needs allowOutside, an absolute path under temp/user folders, and is never a secret shortcut', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { readProjectFile } = await import('../src/file-view.js');
  const root = mkdtempSync(path.join(tmpdir(), 'office-fv-project-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'office-fv-outside-'));
  try {
    const file = path.join(outside, 'catatan.txt');
    writeFileSync(file, 'di luar project\n');
    await assert.rejects(readProjectFile(root, file), (err) => err.status === 403, 'without the confirmation flag');
    const read = await readProjectFile(root, file, { allowOutside: true });
    assert.equal(read.content, 'di luar project\n');
    assert.equal(read.path, file.split(path.sep).join('/'));
    await assert.rejects(readProjectFile(root, '../catatan.txt', { allowOutside: true }), (err) => err.status === 403, 'still needs the full path');
    writeFileSync(path.join(outside, '.env'), 'RAHASIA');
    await assert.rejects(readProjectFile(root, path.join(outside, '.env'), { allowOutside: true }), (err) => err.status === 403 && /rahasia/i.test(err.message), 'secret gate still applies');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('👁 images come back whole as base64 for the preview; over the size limit refused; text files unchanged', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { readProjectFile, MAX_IMAGE_BYTES } = await import('../src/file-view.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'office-fv-img-'));
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8DwHwyBNANDAwMDAwA7HwP9N2RJbQAAAABJRU5ErkJggg==', 'base64');
    writeFileSync(path.join(dir, 'pixel.png'), png);
    const r = await readProjectFile(dir, 'pixel.png');
    assert.equal(r.language, 'image');
    assert.equal(r.content, null);
    assert.equal(r.image.mime, 'image/png');
    assert.deepEqual(Buffer.from(r.image.data, 'base64'), png);
    writeFileSync(path.join(dir, 'big.jpg'), Buffer.alloc(MAX_IMAGE_BYTES + 1, 1));
    await assert.rejects(readProjectFile(dir, 'big.jpg'), (err) => err.status === 413);
    writeFileSync(path.join(dir, 'notes.md'), '# Judul\n');
    assert.equal((await readProjectFile(dir, 'notes.md')).content, '# Judul\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
