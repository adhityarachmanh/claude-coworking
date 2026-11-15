// "Which test files touch what I just changed?" — the fast inner loop of this repo.
//
//   npm run test:related -- src/wa-link.js public/js/features/settings.js
//   npm run test:related                      # the files git says are changed (staged, unstaged, untracked)
//   npm run test:related -- --ui src/wa-link.js   # also run the UI block that mentions the token
//
// It never runs zero tests silently. If nothing can be matched it falls back to `test:fast`, and files shared by many
// features (server.js, public/index.html, public/js/core/**, test-support/**) widen the gate to `test:smoke`.
// Browser tests are the slowest part of the suite, so they are not started implicitly: the command that runs the
// block which mentions the changed file is printed instead (add --ui to run it here).
//
// The mapping is deliberately simple and conservative: a test file is "related" when its name or its source mentions
// the changed file's base name (the token). No heuristics based on imports, so a rename never hides a test by
// accident — a token matched by nothing falls back to the wider gate instead of reporting success.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Files whose change can affect anything: their selection is the whole quick gate, not a handful of files.
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

// Files that no test exercises directly (docs, CI, build scripts): a change here needs no test run.
const NO_TESTS = [/^docs\//, /^\.github\//, /^desktop\//, /^installer\//, /^CHANGELOG\.md$/, /^README\.md$/, /^AGENTS\.md$/];

const UI_FILE = /test-support\/cdp\.mjs/;

/** `tokenOf('src/wa-link.js')` → 'wa-link' — the word a test or UI block uses to refer to it. */
export function tokenOf(file) {
  const base = path.basename(String(file).replace(/\\/g, '/'));
  return base.replace(/\.(mjs|cjs|js|jsx|ts|json|html|css|md)$/i, '');
}

/** True when a test should see the changed file's token, either by file name or by its source. */
export function mentions(source, token) {
  if (!token) return false;
  return new RegExp(`(^|[^\\w-])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`, 'm').test(source);
}

/** The top-level `describeArea` names in a UI suite file, with the template parts removed. */
export function areaNamesOf(source) {
  const names = [];
  const re = /describeArea\(\s*(`([^`]*)`|'([^']*)'|"([^"]*)")/g;
  for (const m of source.matchAll(re)) {
    const name = (m[2] ?? m[3] ?? m[4] ?? '').replace(/\$\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
    if (name) names.push(name);
  }
  return names;
}

/** The UI blocks whose text mentions `token` — the areas worth running for this change. */
export function uiAreasFor(token, source) {
  const wanted = [];
  // Split on the block starts so each chunk holds one describe and everything inside it (including test names).
  const starts = [...source.matchAll(/describeArea\(\s*(`([^`]*)`|'([^']*)'|"([^"]*)")/g)];
  for (const [i, m] of starts.entries()) {
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
    const body = source.slice(m.index, end);
    if (!mentions(body, token)) continue;
    const name = (m[2] ?? m[3] ?? m[4] ?? '').replace(/\$\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
    if (name && !wanted.includes(name)) wanted.push(name);
  }
  return wanted;
}

/**
 * Decides what to run.
 * @param {{ changed: string[], tests: {file: string, source: string}[], uiSource: string, fast: string[] }} input
 *   changed: repo-relative paths · tests: every test file with its source · uiSource: the text of the UI suite files
 *   (for area names) · fast: the files `test:fast` would run, used as the fallback.
 * @returns {{ run: string[], mode: 'selected'|'fast'|'smoke'|'none', uiAreas: string[], reasons: string[] }}
 */
export function choose({ changed, tests, uiSource = '', fast = [], uiSourceFiles = [] }) {
  const reasons = [];
  const uiAreas = [];
  const run = new Set();
  let shared = false;
  let considered = 0;

  for (const file of changed) {
    const rel = String(file).replace(/\\/g, '/');
    if (NO_TESTS.some((re) => re.test(rel))) {
      reasons.push(`${rel}: dokumentasi/CI, tidak ada test yang perlu dijalankan`);
      continue;
    }
    considered += 1;
    if (SHARED.some((re) => re.test(rel))) {
      shared = true;
      reasons.push(`${rel}: file bersama, gerbang diperluas`);
      continue;
    }
    if (/\.test\.(mjs|js)$/i.test(rel)) {
      run.add(rel);
      reasons.push(`${rel}: file test yang berubah`);
      continue;
    }
    const token = tokenOf(rel);
    const own = tests.find((t) => t.file.replace(/^test\//, '').replace(/\.test\.mjs$/, '') === token);
    if (own) {
      run.add(own.file);
      reasons.push(`${rel}: nama test sama`);
    }
    for (const t of tests) {
      if (run.has(t.file)) continue;
      if (UI_FILE.test(t.source)) continue; // slow: proposed as an area instead of run here
      if (mentions(t.source, token)) {
        run.add(t.file);
        reasons.push(`${rel}: disebut di ${t.file}`);
      }
    }
    if (uiSourceFiles.some((f) => UI_FILE.test(f.source))) {
      for (const area of uiAreasFor(token, uiSource)) {
        if (!uiAreas.includes(area)) {
          uiAreas.push(area);
          reasons.push(`${rel}: blok UI "${area}"`);
        }
      }
    }
  }

  if (shared) return { run: ['smoke'], mode: 'smoke', uiAreas, reasons };
  if (!considered) return { run: [], mode: 'none', uiAreas, reasons };
  if (!run.size && !uiAreas.length) {
    reasons.push('tidak ada test yang cocok, memakai test:fast');
    return { run: fast, mode: 'fast', uiAreas, reasons };
  }
  if (!run.size) reasons.push('hanya blok UI yang cocok, jadi test:fast ikut dijalankan');
  return { run: run.size ? [...run].sort() : fast, mode: run.size ? 'selected' : 'fast', uiAreas, reasons };
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

const read = (rel) => readFileSync(path.join(APP, rel), 'utf8');

function main(argv) {
  const withUi = argv.includes('--ui');
  const given = argv.filter((a) => a !== '--ui');
  const changed = given.length
    ? given.map((f) => path.relative(APP, path.resolve(APP, f)).replace(/\\/g, '/'))
    : changedFiles(spawnSync('git', ['status', '--porcelain'], { cwd: APP, encoding: 'utf8' }).stdout ?? '').filter(
        (f) => !f.startsWith('.superpowers/') && !f.startsWith('data/') && !f.startsWith('dist/'),
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
  const uiSourceFiles = tests.filter((t) => UI_FILE.test(t.source)).map((t) => ({ file: t.file, source: t.source }));
  const uiSource = uiSourceFiles.map((f) => f.source).join('\n');
  const fast = tests.filter((t) => !UI_FILE.test(t.source) && !/node:child_process|test-support\/(fake-|cdp|run-each)|from '\.\.\/src\/server\.js'/.test(t.source)).map((t) => t.file);

  const plan = choose({ changed, tests, uiSource, uiSourceFiles, fast });
  for (const reason of plan.reasons) console.log(`  ${reason}`);

  let status = 0;
  if (plan.mode === 'none') {
    console.log('test:related: tidak ada test yang perlu dijalankan.');
  } else if (plan.mode === 'smoke') {
    status = spawnSync(process.execPath, ['test-support/ci-tests.mjs', 'smoke'], { cwd: APP, stdio: 'inherit' }).status ?? 1;
  } else {
    console.log(`test:related: menjalankan ${plan.run.length} file`);
    status = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...plan.run], { cwd: APP, stdio: 'inherit' }).status ?? 1;
  }

  if (plan.uiAreas.length) {
    const args = plan.uiAreas.map((a) => JSON.stringify(a)).join(' ');
    if (withUi) {
      console.log('\ntest:related: menjalankan blok UI');
      const ui = spawnSync(process.execPath, ['test-support/ui-area.mjs', ...plan.uiAreas], { cwd: APP, stdio: 'inherit' });
      if (ui.status) status = ui.status;
    } else {
      console.log(`\ntest:related: blok UI yang menyentuh perubahan ini (lambat, jalankan terpisah):`);
      console.log(`  npm run test:ui:area -- ${args}`);
    }
  }
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
