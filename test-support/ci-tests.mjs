// CI test runner (.github/workflows/test.yml), cross-platform:
//   node test-support/ci-tests.mjs unit   → every test file that needs no browser, in one `node --test` run
//   node test-support/ci-tests.mjs ui     → the browser (CDP) test files one by one, each with a time limit; a file
//                                           that fails is run once more: passing then is reported as FLAKY (named in
//                                           the summary, so it is fixed, not hidden), failing twice fails the job
// A UI file is one that imports test-support/cdp.mjs. Exit code: 0 when everything passed (flaky included).
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
const isUi = (f) => /test-support\/cdp\.mjs/.test(readFileSync(path.join(APP, f), 'utf8'));

const run = (list, timeout) =>
  spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...list], { cwd: APP, stdio: 'inherit', timeout, env: process.env });

if (mode === 'unit') {
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
  console.error('pakai: node test-support/ci-tests.mjs unit|ui');
  process.exit(2);
}
