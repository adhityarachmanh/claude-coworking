// 🧪 When `test:fast` fails in CI, rerun each fast file alone and emit a GitHub annotation for every file that
// fails. Annotations are public on the check run, so the failing file is visible even without the (authenticated)
// job log. Local use: node test-support/ci-fast-files.mjs [--verbose]
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

const files = readdirSync(path.join(APP, 'test'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join('test', f));
const source = (f) => readFileSync(path.join(APP, f), 'utf8');
const isUi = (f) => /test-support\/cdp\.mjs/.test(source(f));
const isSlow = (f) => !isUi(f) && /node:child_process|test-support\/(fake-|cdp|run-each)|from '\.\.\/src\/server\.js'/.test(source(f));
const fast = files.filter((f) => !isUi(f) && !isSlow(f));

const failed = [];
for (const file of fast) {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', file], { cwd: APP, encoding: 'utf8', timeout: 120_000 });
  if (result.status === 0) continue;
  failed.push(file);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const lines = output.split(/\r?\n/);
  const detail = lines.filter((line) => /^(not ok|✖|AssertionError|Error:)/.test(line.trim())).slice(0, 8).join(' | ');
  // ::error file=…,title=…::message — shown on the check run without opening the log.
  console.log(`::error file=${file},title=Test cepat gagal::${file}${detail ? ` — ${detail}` : ''}`);
  if (verbose) console.log(output);
}

if (!failed.length) {
  console.log(`Semua ${fast.length} file test cepat lulus saat dijalankan sendiri-sendiri.`);
  process.exit(0);
}
console.error(`${failed.length} file gagal: ${failed.join(', ')}`);
process.exit(1);
