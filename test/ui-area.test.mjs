// `npm run test:ui:area` (test-support/ui-area.mjs + ui-area-select.mjs) — source-string checks only, same pattern
// as test/installer-bootmode.test.mjs. No browser is started and no test of test/ui.test.mjs runs here: what this
// guards is that the area runner cannot silently turn into a full run, a no-run, or a run that drops a block.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { areasOf, escapeRegExp } from '../test-support/ui-area.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = readFileSync(path.join(APP, 'test-support', 'ui-area.mjs'), 'utf8');
const SELECT = readFileSync(path.join(APP, 'test-support', 'ui-area-select.mjs'), 'utf8');
const SUITE = readFileSync(path.join(APP, 'test', 'ui.test.mjs'), 'utf8');
const PKG = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8'));
const CI = readFileSync(path.join(APP, 'test-support', 'ci-tests.mjs'), 'utf8');

/** The top-level `describeArea(...)` calls: the blocks a filtered run can select. Template names keep their source. */
const blocks = () => [...SUITE.matchAll(/^ {0,2}describeArea\((['"`])(.+?)\1/gm)].map((m) => m[2]);

test('argv: one filter per argument, commas split, blanks dropped', () => {
  assert.deepEqual(areasOf(['settings: WhatsApp card']), ['settings: WhatsApp card']);
  assert.deepEqual(areasOf(['settings,compact', ' UI Ringkas ']), ['settings', 'compact', 'UI Ringkas']);
  assert.deepEqual(areasOf(['', '  ']), []);
});

test('--test-name-pattern gets a literal filter, never a regex', () => {
  // A block name may hold regex syntax (e.g. "settings: WhatsApp card"); it must not change what is selected.
  assert.equal(escapeRegExp('a.b (c) [d] $e'), 'a\\.b \\(c\\) \\[d\\] \\$e');
  assert.match(RUNNER, /'--test-name-pattern', escapeRegExp\(area\)/, 'pola nama memakai filter yang di-escape');
});

test('a filtered child also gets UI_ONLY, so unselected blocks never start their server/browser', () => {
  assert.match(RUNNER, /env: \{ \.\.\.process\.env, UI_ONLY: area,/, 'UI_ONLY diisi filter yang sama');
  assert.match(SELECT, /process\.env\.UI_ONLY/, 'describeArea membaca UI_ONLY');
  assert.match(SELECT, /if \(!uiSelected\(name\)\) return;/, 'blok yang tidak dipilih tidak didaftarkan sama sekali');
  assert.match(SUITE, /import \{ describeArea[^}]*\} from '\.\.\/test-support\/ui-area-select\.mjs';/);
});

test('without UI_ONLY every block runs exactly as before', () => {
  assert.match(SELECT, /return !wanted\.length \|\| wanted\.some\(/, 'tanpa filter → semua blok dipilih');
  assert.ok(!/UI_ONLY/.test(CI), 'ci-tests.mjs tidak pernah memasang UI_ONLY: test:ui tetap penuh');
  assert.equal(PKG.scripts['test:ui'], 'node test-support/ci-tests.mjs ui');
});

test('a filter that matches nothing is a failure, never a green run', () => {
  assert.match(RUNNER, /const ranSomething = \(out\) => !\/\^\\s\*\(\?:ℹ\|#\) tests 0\\b\/m\.test\(out\);/);
  assert.match(RUNNER, /empty\.push\(area\)/, 'nol test dicatat sebagai TANPA TEST');
  assert.match(RUNNER, /process\.exit\(failed\.length \|\| empty\.length \? 1 : 0\)/, 'keluar 1 bila ada yang gagal/kosong');
  assert.match(RUNNER, /if \(!areas\.length\)[\s\S]{0,200}process\.exit\(2\)/, 'tanpa argumen: pakai ulang, keluar 2');
  // A child that never exits (server stuck, browser gone) must be killed and reported, not waited on forever.
  assert.match(RUNNER, /UI_AREA_TIMEOUT_MS/, 'batas waktu bisa dinaikkan lewat env');
  assert.match(RUNNER, /timedOut = true;\s*child\.kill\(\);/, 'child yang lewat batas waktu dihentikan');
  assert.match(RUNNER, /if \(timedOut\) \{[\s\S]{0,300}failed\.push\(area\)/, 'lewat batas waktu = GAGAL');
  // A filter that matches no block used to start a server and a browser for zero tests and then hang on their
  // handles; the suite now fails a named test instead, which the runner reports as GAGAL in a couple of seconds.
  assert.match(SELECT, /export function checkUiSelection\(\)/, 'penjaga filter kosong ada di select');
  assert.match(SELECT, /selected > 0\) return;/, 'tanpa filter (atau ada blok terpilih) penjaga diam');
  assert.match(SELECT, /assert\.fail\(/, 'filter kosong menghasilkan kegagalan yang menyebut filternya');
  assert.match(SUITE, /\ncheckUiSelection\(\);\s*$/, 'suite memanggil penjaga sebagai pernyataan terakhir');
});

test('every block of the UI suite stays selectable (none was dropped while wiring describeArea)', () => {
  const names = blocks();
  assert.equal(names.length, 11, `blok describeArea: ${names.length} (5 blok × 2 viewport + CSP)`);
  // Every original block must still be declared through describeArea: no leftover `describe(` that a filter can't
  // see, and each substring documented in docs/uji-ui.md is really present in a block name.
  const DOCS = readFileSync(path.join(APP, 'docs', 'uji-ui.md'), 'utf8');
  for (const needle of ['UI ${vp.name}', 'Ringkas konteks', 'CSP', 'HP lewat WiFi', 'chat live', 'koneksi putus',
    'palet perintah', 'notifikasi', 'perintah tier', 'Semua project', 'Setelan PIN']) {
    assert.ok(names.some((n) => n.includes(needle)), `blok "${needle}" masih ada`);
  }
  for (const documented of ['UI mobile 390x844', 'UI desktop 1440x900', 'UI Ringkas konteks', 'CSP', 'UI HP lewat WiFi',
    'UI chat live', 'UI koneksi putus', 'UI palet perintah', 'UI notifikasi', 'UI perintah tier', 'Semua project', 'Setelan PIN']) {
    assert.ok(DOCS.includes(documented), `docs/uji-ui.md menyebut "${documented}"`);
  }
  assert.ok(!/^ {0,2}describe\(/m.test(SUITE), 'tidak ada describe(...) yang terlewat dari describeArea');
});
