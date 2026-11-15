// The mapping behind `npm run test:related` (test-support/related-tests.mjs). Pure functions only: the real run is
// verified by using the command, these tests pin the decisions that must never regress — no silent empty run, shared
// files add the integration gate, and a browser suite/block is proposed instead of started implicitly.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { areaNamesOf, changedFiles, choose, mentions, mentionsFile, tokenOf, uiAreasFor } from '../test-support/related-tests.mjs';

// Split on purpose: a test file whose source spells the CDP module path would be classified as a browser test by
// test-support/ci-tests.mjs (and pushed into the slow UI job) even though this file only maps strings.
const CDP_PATH = ['test-support', 'cdp.mjs'].join('/');
const WA_TEST = { file: 'test/wa-link.test.mjs', source: "import { userJidOf } from '../src/wa-link.js';" };
const ZIP_TEST = { file: 'test/zip.test.mjs', source: "import { zip } from '../src/zip.js';" };
const UI_TEST = { file: 'test/ui.test.mjs', source: `import { launchBrowser } from '../${CDP_PATH}';` };
// The real suite files that read repo files outside test/ — the reason docs/, .github/ and installer/ are not
// "no tests needed".
const CI_TEST = { file: 'test/ci-workflows.test.mjs', source: "const read = (name) => readFileSync(path.join(APP, '.github', 'workflows', name)); read('release.yml');" };
const INSTALLER_TEST = { file: 'test/installer-bootmode.test.mjs', source: "const ISS = readFileSync(path.join(APP, 'installer', 'Adhitron.iss'), 'utf8');" };
const UI_AREA_TEST = { file: 'test/ui-area.test.mjs', source: "const DOCS = readFileSync(path.join(APP, 'docs', 'uji-ui.md'), 'utf8');" };
const UI_SOURCE = [
  "describeArea(`UI audit — ${vp.name}`, () => {",
  "  test('tombol simpan', () => {});",
  "});",
  "describeArea('UI Setelan PIN & akses terkunci', () => {",
  "  test('settings: autologon modal', () => {});",
  "});",
].join('\n');

const base = {
  tests: [WA_TEST, ZIP_TEST, CI_TEST, INSTALLER_TEST, UI_AREA_TEST, UI_TEST],
  uiSourceFiles: [UI_TEST],
  uiSource: UI_SOURCE,
  fast: ['test/zip.test.mjs'],
};

describe('tokenOf', () => {
  test('memakai nama file tanpa ekstensi', () => {
    assert.equal(tokenOf('src/wa-link.js'), 'wa-link');
    assert.equal(tokenOf('test/wa-link.test.mjs'), 'wa-link.test');
    assert.equal(tokenOf('public\\js\\features\\settings.js'), 'settings');
    assert.equal(tokenOf('.github/workflows/release.yml'), 'release');
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

describe('mentionsFile', () => {
  test('nama file bersamaan ekstensinya cukup untuk file non-generik', () => {
    assert.equal(mentionsFile(CI_TEST.source, '.github/workflows/release.yml'), true);
    assert.equal(mentionsFile(INSTALLER_TEST.source, 'installer/Adhitron.iss'), true);
    assert.equal(mentionsFile(UI_AREA_TEST.source, 'docs/uji-ui.md'), true);
  });

  test('kata terlalu umum tidak boleh mencocokkan sendiri', () => {
    assert.equal(mentionsFile("import { api } from './api.js'", 'src/api.js'), false);
    assert.equal(mentionsFile("const t = 'test'", 'tools/test.mjs'), false);
  });

  test('jalur lengkap juga dikenali', () => {
    assert.equal(mentionsFile("readFileSync('public/js/core/api.js')", 'public/js/core/api.js'), true);
  });
});

describe('areaNamesOf / uiAreasFor', () => {
  test('nama blok dibersihkan dari bagian template dan pemisah', () => {
    assert.deepEqual(areaNamesOf(UI_SOURCE), ['UI audit', 'UI Setelan PIN & akses terkunci']);
  });

  test('token di dalam test memilih bloknya', () => {
    assert.deepEqual(uiAreasFor('autologon', UI_SOURCE), ['UI Setelan PIN & akses terkunci']);
  });

  test('token umum memilih audit utama dengan nama yang bisa dipakai', () => {
    assert.deepEqual(uiAreasFor('tombol', UI_SOURCE), ['UI audit']);
  });

  test('token yang tidak ada tidak memilih apa pun', () => {
    assert.deepEqual(uiAreasFor('spotify', UI_SOURCE), []);
  });
});

describe('choose', () => {
  test('file src memilih test yang menyebutnya, bukan yang lain', () => {
    const plan = choose({ ...base, changed: ['src/wa-link.js'] });
    assert.equal(plan.mode, 'selected');
    assert.deepEqual(plan.files, ['test/wa-link.test.mjs']);
    assert.equal(plan.smoke, false);
  });

  test('test yang berubah ikut dijalankan', () => {
    const plan = choose({ ...base, changed: ['test/zip.test.mjs'] });
    assert.equal(plan.mode, 'selected');
    assert.deepEqual(plan.files, ['test/zip.test.mjs']);
  });

  test('file bersama menambah smoke TANPA membuang test terpilih', () => {
    for (const shared of ['server.js', 'public/index.html', 'public/js/core/api.js', ['test-support', 'fake-claude.mjs'].join('/')]) {
      const plan = choose({ ...base, changed: [shared] });
      assert.equal(plan.smoke, true, shared);
      const withSource = choose({ ...base, changed: [shared, 'src/wa-link.js'] });
      assert.equal(withSource.smoke, true, shared);
      assert.deepEqual(withSource.files, ['test/wa-link.test.mjs'], shared);
      assert.equal(withSource.mode, 'smoke+selected', shared);
    }
  });

  test('file di luar test/ yang dibaca sebuah test tidak dianggap "tanpa test"', () => {
    const cases = [
      ['.github/workflows/release.yml', 'test/ci-workflows.test.mjs'],
      ['installer/Adhitron.iss', 'test/installer-bootmode.test.mjs'],
      ['docs/uji-ui.md', 'test/ui-area.test.mjs'],
    ];
    for (const [changed, expected] of cases) {
      const plan = choose({ ...base, changed: [changed] });
      assert.equal(plan.mode, 'selected', changed);
      assert.ok(plan.files.includes(expected), `${changed} → ${expected} (dapat: ${plan.files.join(', ')})`);
    }
  });

  test('tanpa test yang cocok tetap ada yang dijalankan (test:fast)', () => {
    const plan = choose({ ...base, changed: ['src/entah-apa.js'] });
    assert.equal(plan.mode, 'fast');
    assert.ok(plan.files.length > 0, 'tidak boleh kosong');
    assert.match(plan.reasons.join('\n'), /test:fast/);
    assert.deepEqual(plan.files, base.fast);
  });

  test('UI saja: test:fast tetap jalan dan blok UI diusulkan', () => {
    const plan = choose({ ...base, changed: ['public/js/features/autologon.js'] });
    assert.equal(plan.mode, 'fast');
    assert.deepEqual(plan.areas, ['UI Setelan PIN & akses terkunci']);
    assert.ok(plan.files.length > 0);
  });

  test('suite browser yang berubah tidak dijalankan implisit, tapi ditandai', () => {
    const plan = choose({ ...base, changed: ['test/ui.test.mjs'] });
    assert.equal(plan.uiSuite, true);
    assert.deepEqual(plan.files, base.fast, 'test:fast sebagai pengganti, bukan seluruh suite browser');
    assert.match(plan.reasons.join('\n'), /npm run test:ui/);
  });

  test('dokumentasi yang tidak dibaca test tidak menjalankan apa pun', () => {
    const plan = choose({ ...base, changed: ['CHANGELOG.md', 'README.md', 'AGENTS.md'] });
    assert.equal(plan.mode, 'none');
    assert.deepEqual(plan.files, []);
  });

  test('docs/ tidak dilewati otomatis: yang tidak dibaca test jatuh ke test:fast', () => {
    const plan = choose({ ...base, changed: ['docs/FITUR.md'] });
    assert.equal(plan.mode, 'fast');
    assert.ok(plan.files.length > 0);
  });

  test('campuran: file tanpa test + dokumentasi tetap menjalankan test:fast', () => {
    const plan = choose({ ...base, changed: ['CHANGELOG.md', 'src/entah-apa.js'] });
    assert.equal(plan.mode, 'fast');
    assert.ok(plan.reasons.length > 0);
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
