// The mapping behind `npm run test:related` (test-support/related-tests.mjs). Pure functions only: the real run is
// verified by using the command, these tests pin the decisions that must never regress — no silent empty run, shared
// files widen the gate, and a UI block is proposed instead of the whole browser suite.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { areaNamesOf, changedFiles, choose, mentions, tokenOf, uiAreasFor } from '../test-support/related-tests.mjs';

const WA_TEST = { file: 'test/wa-link.test.mjs', source: "import { userJidOf } from '../src/wa-link.js';" };
const OTHER_TEST = { file: 'test/zip.test.mjs', source: "import { zip } from '../src/zip.js';" };
// Split on purpose: a test file whose source spells the CDP module path would be classified as a browser test by
// test-support/ci-tests.mjs (and pushed into the slow UI job) even though this file only maps strings.
const CDP_PATH = ['test-support', 'cdp.mjs'].join('/');
const UI_TEST = { file: 'test/ui.test.mjs', source: `import { launchBrowser } from '../${CDP_PATH}';` };
const UI_SOURCE = [
  "describeArea(`UI audit — ${vp.name}`, () => {",
  "  test('tombol simpan', () => {});",
  "});",
  "describeArea('UI Setelan PIN & akses terkunci', () => {",
  "  test('settings: autologon modal', () => {});",
  "});",
].join('\n');

const base = { tests: [WA_TEST, OTHER_TEST, UI_TEST], uiSourceFiles: [UI_TEST], uiSource: UI_SOURCE, fast: ['test/zip.test.mjs'] };

describe('tokenOf', () => {
  test('memakai nama file tanpa ekstensi', () => {
    assert.equal(tokenOf('src/wa-link.js'), 'wa-link');
    assert.equal(tokenOf('test/wa-link.test.mjs'), 'wa-link.test');
    assert.equal(tokenOf('public\\js\\features\\settings.js'), 'settings');
  });
});

describe('mentions', () => {
  test('mencocokkan kata utuh, bukan potongan', () => {
    assert.equal(mentions("import x from '../src/wa-link.js'", 'wa-link'), true);
    assert.equal(mentions('const waLinker = 1', 'wa-link'), false);
    assert.equal(mentions('wa-link', 'wa-link'), true);
  });

  test('aman untuk token dengan karakter regex', () => {
    assert.equal(mentions('a.b.c', 'a.b'), true);
    assert.equal(mentions('axb', 'a.b'), false);
  });
});

describe('areaNamesOf / uiAreasFor', () => {
  test('nama blok dibersihkan dari bagian template', () => {
    assert.deepEqual(areaNamesOf(UI_SOURCE), ['UI audit —', 'UI Setelan PIN & akses terkunci']);
  });

  test('token di dalam test memilih bloknya', () => {
    assert.deepEqual(uiAreasFor('autologon', UI_SOURCE), ['UI Setelan PIN & akses terkunci']);
  });

  test('token yang tidak ada tidak memilih apa pun', () => {
    assert.deepEqual(uiAreasFor('spotify', UI_SOURCE), []);
  });
});

describe('choose', () => {
  test('file src memilih test yang menyebutnya, bukan yang lain', () => {
    const plan = choose({ ...base, changed: ['src/wa-link.js'] });
    assert.equal(plan.mode, 'selected');
    assert.deepEqual(plan.run, ['test/wa-link.test.mjs']);
  });

  test('test yang berubah ikut dijalankan', () => {
    const plan = choose({ ...base, changed: ['test/zip.test.mjs'] });
    assert.equal(plan.mode, 'selected');
    assert.deepEqual(plan.run, ['test/zip.test.mjs']);
  });

  test('file bersama memperluas gerbang ke smoke', () => {
    const fakeCli = ['test-support', 'fake-claude.mjs'].join('/'); // not written literally: see CDP_PATH
    for (const shared of ['server.js', 'public/index.html', fakeCli, 'public/js/core/api.js']) {
      const plan = choose({ ...base, changed: [shared] });
      assert.equal(plan.mode, 'smoke', shared);
      assert.deepEqual(plan.run, ['smoke'], shared);
    }
  });

  test('tanpa test yang cocok tetap ada yang dijalankan (test:fast)', () => {
    const plan = choose({ ...base, changed: ['src/entah-apa.js'] });
    assert.equal(plan.mode, 'fast');
    assert.ok(plan.run.length > 0, 'tidak boleh kosong');
    assert.match(plan.reasons.join('\n'), /test:fast/);
    assert.deepEqual(plan.run, base.fast);
  });

  test('UI saja: test:fast tetap jalan dan blok UI diusulkan', () => {
    const plan = choose({ ...base, changed: ['public/js/features/autologon.js'] });
    assert.equal(plan.mode, 'fast');
    assert.deepEqual(plan.uiAreas, ['UI Setelan PIN & akses terkunci']);
    assert.ok(plan.run.length > 0);
  });

  test('dokumentasi saja tidak menjalankan apa pun', () => {
    const plan = choose({ ...base, changed: ['docs/FITUR.md', 'CHANGELOG.md'] });
    assert.equal(plan.mode, 'none');
    assert.deepEqual(plan.run, []);
  });

  test('campuran: file tanpa test + dokumentasi tetap menjalankan test:fast', () => {
    const plan = choose({ ...base, changed: ['docs/FITUR.md', 'src/entah-apa.js'] });
    assert.equal(plan.mode, 'fast');
    assert.deepEqual(plan.reasons.length > 0, true);
  });
});

describe('changedFiles', () => {
  test('membaca status porcelain, termasuk perubahan yang belum ditambahkan', () => {
    assert.deepEqual(changedFiles(' M src/wa-link.js\n?? AGENTS.md\nA  test/x.test.mjs\n'), ['src/wa-link.js', 'AGENTS.md', 'test/x.test.mjs']);
  });

  test('mengambil nama baru pada rename', () => {
    assert.deepEqual(changedFiles('R  src/lama.js -> src/baru.js'), ['src/baru.js']);
  });

  test('output kosong berarti tidak ada file berubah', () => {
    assert.deepEqual(changedFiles(''), []);
  });
});
