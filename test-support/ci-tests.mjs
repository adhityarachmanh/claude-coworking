// Test runner, cross-platform:
//   node test-support/ci-tests.mjs fast   → pure-logic files only (no browser, no server/process): the daily check
//   node test-support/ci-tests.mjs smoke  → the integration files that must not regress before a release: real
//                                           server, approvals, queue/concurrency, backup, and the CLI bridge
//   node test-support/ci-tests.mjs unit   → every test file that needs no browser, in one `node --test` run
//   node test-support/ci-tests.mjs ui     → the browser (CDP) test files one by one, each with a time limit; a file
//                                           that fails is run once more: passing then is reported as FLAKY (named in
//                                           the summary, so it is fixed, not hidden), failing twice fails the job
// A UI file is one that imports test-support/cdp.mjs. A slow file starts a server or spawns a process. Exit code: 0
// when everything passed (flaky included).
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const FILE_TIMEOUT_MS = Number(process.env.CI_UI_FILE_TIMEOUT_MS ?? 15 * 60_000);

const files = readdirSync(path.join(APP, 'test'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join('test', f));
const source = (f) => readFileSync(path.join(APP, f), 'utf8');
const isUi = (f) => /test-support\/cdp\.mjs/.test(source(f));
// A file that spawns a server/process (or imports the fakes) is the slow half of the suite on purpose: it tests the
// real server, ports, and CLI lifecycle. Everything else is pure logic and safe to run on every save.
const isSlow = (f) => !isUi(f) && /node:child_process|test-support\/(fake-|cdp|run-each)|from '\.\.\/src\/server\.js'/.test(source(f));

const run = (list, timeout) =>
  spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...list], { cwd: APP, stdio: 'inherit', timeout, env: process.env });

// The release-critical half of the slow suite, kept small enough to run on every push (~1–2 min).
// Add a file here only when a regression in it would make a release unsafe, not merely inconvenient.
const SMOKE = [
  'server.test.mjs',
  'cli-bridge.test.mjs',
  'queue.test.mjs',
  'concurrency-flow.test.mjs',
  'engine-per-project.test.mjs',
  'backup.test.mjs',
  'backup-schedule.test.mjs',
];

if (mode === 'fast') {
  const fast = files.filter((f) => !isUi(f) && !isSlow(f));
  console.log(`fast: ${fast.length} file (tanpa browser dan tanpa server)`);
  process.exit(run(fast).status ?? 1);
} else if (mode === 'smoke') {
  const missing = SMOKE.filter((f) => !files.includes(path.join('test', f)));
  if (missing.length) {
    console.error(`smoke: file tidak ditemukan: ${missing.join(', ')}`);
    process.exit(2);
  }
  console.log(`smoke: ${SMOKE.length} file integrasi`);
  const result = { passed: [], flaky: [], failed: [] };
  for (const f of SMOKE) {
    console.log(`\n=== test/${f}`);
    // A failed file gets one retry, the same as the UI runner: a genuine regression fails twice, a timing flake is
    // named instead of silently blocking every PR. The longest file is ~1 min, so 2 min is already generous.
    if (run([path.join('test', f)], 2 * 60_000).status === 0) {
      result.passed.push(f);
      continue;
    }
    console.log(`\n=== test/${f} gagal: diulang sekali`);
    (run([path.join('test', f)], 2 * 60_000).status === 0 ? result.flaky : result.failed).push(f);
  }
  console.log(`\nsmoke: ${result.passed.length} lulus, ${result.flaky.length} flaky (lulus saat diulang), ${result.failed.length} gagal`);
  for (const f of result.flaky) console.log(`  FLAKY test/${f}`);
  for (const f of result.failed) console.log(`  GAGAL test/${f}`);
  if (process.env.GITHUB_STEP_SUMMARY && result.flaky.length + result.failed.length) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Smoke integrasi\n\n${result.flaky.map((f) => `- ⚠ flaky: \`test/${f}\``).join('\n')}\n${result.failed.map((f) => `- ❌ gagal: \`test/${f}\``).join('\n')}\n`);
  }
  process.exit(result.failed.length ? 1 : 0);
} else if (mode === 'unit') {
  const unit = files.filter((f) => !isUi(f));
  console.log(`unit: ${unit.length} file`);
  process.exit(run(unit).status ?? 1);
} else if (mode === 'ui') {
  const ui = files.filter(isUi);
  const result = { passed: [], flaky: [], failed: [] };
  for (const f of ui) {
    console.log(`\n=== ${f}`);
    if (run([f], FILE_TIMEOUT_MS).status === 0) {
      result.passed.push(f);
      continue;
    }
    console.log(`\n=== ${f} gagal: diulang sekali`);
    (run([f], FILE_TIMEOUT_MS).status === 0 ? result.flaky : result.failed).push(f);
  }
  console.log(`\nUI: ${result.passed.length} lulus, ${result.flaky.length} flaky (lulus saat diulang), ${result.failed.length} gagal`);
  for (const f of result.flaky) console.log(`  FLAKY ${f}`);
  for (const f of result.failed) console.log(`  GAGAL ${f}`);
  if (process.env.GITHUB_STEP_SUMMARY && result.flaky.length + result.failed.length) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Test UI\n\n${result.flaky.map((f) => `- ⚠ flaky: \`${f}\``).join('\n')}\n${result.failed.map((f) => `- ❌ gagal: \`${f}\``).join('\n')}\n`);
  }
  process.exit(result.failed.length ? 1 : 0);
} else {
  console.error('pakai: node test-support/ci-tests.mjs fast|smoke|unit|ui');
  process.exit(2);
}
