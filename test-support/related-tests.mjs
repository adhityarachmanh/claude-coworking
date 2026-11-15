// "Which test files touch what I just changed?" — the fast inner loop of this repo.
//
//   npm run test:related -- src/wa-link.js public/js/features/settings.js
//   npm run test:related                      # the files git says are changed (staged, unstaged, untracked)
//   npm run test:related -- --ui src/wa-link.js   # also run the UI block that mentions the token
//
// It never runs zero tests silently. If nothing can be matched it falls back to `test:fast`, and files shared by many
// features (server.js, public/index.html, public/js/core/**, test-support/**) add `test:smoke` on top of whatever else
// was selected. Browser tests are the slowest part of the suite, so they are not started implicitly: the command that
// runs the block mentioning the changed file is printed instead (add --ui to run it here); a change to a browser test
// file itself points at `npm run test:ui`.
//
// The mapping is deliberately simple and conservative: a test is related when its source mentions the changed file's
// path, its file name, or its base name as a word. No import analysis, so a rename cannot hide a test — and a token
// matched by nothing falls back to the wider gate instead of reporting success.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropIsolationEnv, isSlowFile, isUiFile } from './test-files.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Files whose change can affect anything: they add the integration gate on top of the selected tests.
const SHARED = [
  /^server\.js$/,
  /^package\.json$/,
  /^eslint\.config\.js$/,
  /^public\/index\.html$/,
  /^public\/css\//,
  /^public\/js\/app\.js$/,
  /^public\/js\/core\//,
  /^test-support\//,
];

// Files no test reads: they are packaging metadata, so a change here needs no test run. `docs/` is intentionally NOT
// listed — test/ui-area.test.mjs reads docs/uji-ui.md, and .github/ + installer/ are read by ci-workflows and
// installer-bootmode/firewall-check tests.
const NO_TESTS = [/^CHANGELOG\.md$/, /^README\.md$/, /^AGENTS\.md$/];

// Words too common to prove a relation on their own (every test file mentions "test"): a match needs the file name.
const GENERIC = new Set([
  'test', 'index', 'main', 'app', 'util', 'utils', 'types', 'core', 'api', 'data', 'config', 'server', 'client',
  'shared', 'common', 'model', 'models', 'state', 'dom', 'format', 'style', 'styles',
]);

/** `tokenOf('src/wa-link.js')` → 'wa-link' — the word a test or UI block uses to refer to it. */
export function tokenOf(file) {
  const base = path.basename(String(file).replace(/\\/g, '/'));
  return base.replace(/\.(mjs|cjs|js|jsx|ts|json|html|css|md|iss|yml|yaml)$/i, '');
}

/** True when `source` mentions `token` as a whole word (so "wa-link" does not match "wa-linker"). */
export function mentions(source, token) {
  if (!token) return false;
  return new RegExp(`(^|[^\\w-])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`, 'm').test(source);
}

/** True when a test source refers to the changed file: by full path, by file name, or by a distinctive base name. */
export function mentionsFile(source, file, token = tokenOf(file)) {
  const rel = String(file).replace(/\\/g, '/');
  const name = path.basename(rel);
  if (source.includes(rel)) return true; // 'installer/Adhitron.iss', 'docs/uji-ui.md'
  if (GENERIC.has(token) || token.length < 3) {
    // A generic name ("api.js", "test.yml") proves nothing on its own: the directory must appear too, so
    // "import './api.js'" in an unrelated test does not claim src/api.js.
    const dir = path.basename(path.dirname(rel));
    return dir.length >= 3 && source.includes(name) && source.includes(dir);
  }
  if (source.includes(name)) return true; // 'Adhitron.iss', 'release.yml'
  return mentions(source, token);
}

/** A block name with the template parts and trailing separators removed: "UI audit — ${vp.name}" → "UI audit". */
const cleanAreaName = (raw) =>
  String(raw)
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/\s*[—–-]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The top-level `describeArea` names in a UI suite file, with the template parts removed. */
export function areaNamesOf(source) {
  return [...source.matchAll(/describeArea\(\s*(`([^`]*)`|'([^']*)'|"([^"]*)")/g)]
    .map((m) => cleanAreaName(m[2] ?? m[3] ?? m[4] ?? ''))
    .filter(Boolean);
}

/** The UI blocks whose text mentions `token` — the areas worth running for this change. */
export function uiAreasFor(token, source) {
  const wanted = [];
  // Split on the block starts so each chunk holds one describe and everything inside it (including test names).
  const starts = [...source.matchAll(/describeArea\(\s*(`([^`]*)`|'([^']*)'|"([^"]*)")/g)];
  for (const [i, m] of starts.entries()) {
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
    if (!mentions(source.slice(m.index, end), token)) continue;
    const name = cleanAreaName(m[2] ?? m[3] ?? m[4] ?? '');
    // A name that is only "UI" (or empty) after the template is stripped matches every block: say nothing rather
    // than suggest a run of the whole browser suite.
    if (name.length < 5) continue;
    if (!wanted.includes(name)) wanted.push(name);
  }
  return wanted;
}

/**
 * Decides what to run.
 * @param {{ changed: string[], tests: {file: string, source: string}[], uiSource?: string, fast?: string[],
 *   uiSourceFiles?: {file: string, source: string}[] }} input
 * @returns {{ files: string[], smoke: boolean, areas: string[], uiSuite: boolean, mode: string, reasons: string[] }}
 */
export function choose({ changed, tests, uiSource = '', fast = [], uiSourceFiles = [] }) {
  const reasons = [];
  const areas = [];
  const files = new Set();
  let smoke = false;
  let uiSuite = false;
  let considered = 0;

  for (const file of changed) {
    const rel = String(file).replace(/\\/g, '/');
    if (NO_TESTS.some((re) => re.test(rel))) {
      reasons.push(`${rel}: dokumen, tidak ada test yang membacanya`);
      continue;
    }
    considered += 1;
    if (SHARED.some((re) => re.test(rel))) {
      smoke = true;
      reasons.push(`${rel}: file bersama, ikut test:smoke`);
      continue;
    }
    const isTest = /\.test\.(mjs|js)$/i.test(rel);
    if (isTest) {
      const test = tests.find((t) => t.file === rel);
      if (test && isUiFile(test.source)) {
        uiSuite = true;
        reasons.push(`${rel}: suite browser, jalankan npm run test:ui`);
        continue;
      }
      files.add(rel);
      reasons.push(`${rel}: file test yang berubah`);
      continue;
    }
    const token = tokenOf(rel);
    for (const t of tests) {
      if (files.has(t.file)) continue;
      if (isUiFile(t.source)) continue; // slow: proposed as an area instead of run here
      if (mentionsFile(t.source, rel, token)) {
        files.add(t.file);
        reasons.push(`${rel}: disebut di ${t.file}`);
      }
    }
    if (!GENERIC.has(token) && token.length >= 3 && uiSourceFiles.some((f) => isUiFile(f.source))) {
      for (const area of uiAreasFor(token, uiSource)) {
        if (!areas.includes(area)) {
          areas.push(area);
          reasons.push(`${rel}: blok UI "${area}"`);
        }
      }
    }
  }

  if (!considered) return { files: [], smoke: false, areas, uiSuite, mode: 'none', reasons };
  if (smoke) {
    reasons.push('gerbang: test:smoke + test yang terpilih');
    return { files: [...files].sort(), smoke: true, areas, uiSuite, mode: files.size ? 'smoke+selected' : 'smoke', reasons };
  }
  if (files.size) return { files: [...files].sort(), smoke: false, areas, uiSuite, mode: 'selected', reasons };
  if (uiSuite) {
    reasons.push('hanya suite browser yang berubah; test:fast tetap dijalankan');
    return { files: fast, smoke: false, areas, uiSuite, mode: 'fast', reasons };
  }
  if (!areas.length) reasons.push('tidak ada test yang cocok, memakai test:fast');
  else reasons.push('hanya blok UI yang cocok, jadi test:fast ikut dijalankan');
  return { files: fast, smoke: false, areas, uiSuite, mode: 'fast', reasons };
}

/** The repo-relative files git reports as changed (staged, unstaged, and untracked). */
export function changedFiles(porcelain) {
  return String(porcelain)
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .flatMap((line) => (line.includes(' -> ') ? [line.split(' -> ')[1]] : [line]))
    .map((line) => line.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

const TIMEOUT_MS = 30 * 60_000;

const read = (rel) => readFileSync(path.join(APP, rel), 'utf8');

function main(argv) {
  const withUi = argv.includes('--ui');
  const args = argv.filter((a) => !a.startsWith('-'));
  const unknown = argv.filter((a) => a.startsWith('-') && !['--ui', '--help', '-h'].includes(a));
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('pakai: npm run test:related -- [--ui] [<file>…]');
    console.log('  tanpa <file>: memakai hasil `git status`; --ui ikut menjalankan blok test:ui:area yang terkait');
    return 0;
  }
  if (unknown.length) {
    console.error(`test:related: argumen tidak dikenal: ${unknown.join(' ')} (lihat --help)`);
    return 2;
  }

  const changed = args.length
    ? args.map((f) => path.relative(APP, path.resolve(APP, f)).replace(/\\/g, '/'))
    : changedFiles(spawnSync('git', ['status', '--porcelain'], { cwd: APP, encoding: 'utf8' }).stdout ?? '').filter(
        (f) => !f.startsWith('.superpowers/') && !f.startsWith('data/') && !f.startsWith('dist/') && !f.startsWith('node_modules/'),
      );

  if (!changed.length) {
    console.log('test:related: tidak ada file yang berubah (git bersih) — tidak ada yang dijalankan.');
    return 0;
  }
  console.log(`test:related: ${changed.length} file berubah`);

  const tests = readdirSync(path.join(APP, 'test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => ({ file: `test/${f}`, source: read(`test/${f}`) }));
  const uiSourceFiles = tests.filter((t) => isUiFile(t.source));
  const uiSource = uiSourceFiles.map((f) => f.source).join('\n');
  const fast = tests
    .filter((t) => !isUiFile(t.source) && !isSlowFile(t.source))
    .map((t) => t.file);

  const plan = choose({ changed, tests, uiSource, uiSourceFiles, fast });
  for (const reason of plan.reasons) console.log(`  ${reason}`);

  // Same isolation as `npm run test:*`: the office app may have left OFFICE_* pointing at the installed copy.
  const env = dropIsolationEnv({ ...process.env });
  const runNodeTests = (list) =>
    spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...list], { cwd: APP, stdio: 'inherit', env, timeout: TIMEOUT_MS }).status ?? 1;

  let status = 0;
  if (plan.smoke) {
    console.log('\ntest:related: test:smoke');
    const smoke = spawnSync(process.execPath, ['test-support/ci-tests.mjs', 'smoke'], { cwd: APP, stdio: 'inherit', env, timeout: TIMEOUT_MS });
    status = smoke.status ?? 1;
  }
  if (plan.files.length) {
    const label = plan.mode === 'smoke+selected' ? 'test terkait setelah smoke' : `menjalankan ${plan.files.length} file`;
    console.log(`\ntest:related: ${label}`);
    const code = runNodeTests(plan.files);
    if (code) status = code;
  } else if (!plan.smoke && plan.mode === 'none') {
    console.log('\ntest:related: tidak ada test yang perlu dijalankan.');
  }

  if (plan.areas.length) {
    const joined = plan.areas.map((a) => JSON.stringify(a)).join(' ');
    if (withUi) {
      console.log('\ntest:related: menjalankan blok UI');
      const ui = spawnSync(process.execPath, ['test-support/ui-area.mjs', ...plan.areas], { cwd: APP, stdio: 'inherit', env, timeout: TIMEOUT_MS });
      if (ui.status) status = ui.status;
    } else {
      console.log('\ntest:related: blok UI yang menyentuh perubahan ini (lambat, jalankan terpisah):');
      console.log(`  npm run test:ui:area -- ${joined}`);
    }
  }
  if (plan.uiSuite) console.log('\ntest:related: suite browser berubah → jalankan `npm run test:ui` sebelum rilis.');
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
