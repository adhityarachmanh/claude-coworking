// Proves every test in a file can run alone: runs the whole file once (to list the tests and get the
// full-run result), then runs each test by itself with
//   node --test --test-concurrency=1 --test-name-pattern="^<full name>$" <file>
// with a bounded per-test timeout, and prints a pass/fail table.
//
//   node test-support/run-each-ui-test.mjs test/ui.test.mjs test/queue-ui.test.mjs
//   node test-support/run-each-ui-test.mjs --timeout 120 --jobs 2 --filter "Semua project" test/ui.test.mjs
//   node test-support/run-each-ui-test.mjs --shuffle 3 test/ui.test.mjs   # plus 3 full runs in random order (seeds 1..3)
//   node test-support/run-each-ui-test.mjs --no-each test/ui.test.mjs     # full run (+ shuffles) only
//
// This module doubles as the node:test reporter of the child runs (default export): it prints one JSON line
// per finished test, with the full name (ancestors joined by spaces, as --test-name-pattern matches it).
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const APP = path.resolve(path.dirname(SELF), '..');
const MARK = '@@run-each@@';

/** node:test reporter: `@@run-each@@{"kind":"test","status":"pass","name":"Suite test"}` per test/suite. */
export default async function* reporter(source) {
  const stack = [];
  for await (const { type, data } of source) {
    if (type === 'test:start') {
      stack.length = data.nesting;
      stack.push(data.name);
    } else if (type === 'test:pass' || type === 'test:fail') {
      stack.length = data.nesting;
      stack.push(data.name);
      const kind = data.details?.type === 'suite' ? 'suite' : 'test';
      const status = data.skip !== undefined ? 'skip' : data.todo !== undefined ? 'todo' : type === 'test:pass' ? 'pass' : 'fail';
      const error = type === 'test:fail' ? String(data.details?.error?.cause?.message ?? data.details?.error?.message ?? '').split('\n')[0].slice(0, 200) : undefined;
      yield `${MARK}${JSON.stringify({ kind, status, name: stack.join(' '), nesting: data.nesting, error })}\n`;
    }
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Kills a process and everything it started (node --test → test file → server + browser). */
function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGKILL');
}

/** Runs `node --test` on one file (optionally one test); resolves { code, timedOut, results, ms, tail }. */
function runNodeTest(file, { pattern, timeoutMs, extra = [] }) {
  const args = ['--test', '--test-concurrency=1', `--test-reporter=${pathToFileURL(SELF).href}`, ...extra];
  if (pattern) args.push(`--test-name-pattern=${pattern}`);
  args.push(file);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: APP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const finish = (code) => {
      clearTimeout(timer);
      const results = out
        .split('\n')
        .filter((l) => l.startsWith(MARK))
        .map((l) => JSON.parse(l.slice(MARK.length)));
      const tail = `${out.split('\n').filter((l) => !l.startsWith(MARK)).join('\n')}\n${err}`.trim().split('\n').slice(-8).join('\n');
      resolve({ code, timedOut, results, ms: Date.now() - started, tail });
    };
    child.on('exit', finish);
    child.on('error', () => finish(-1));
  });
}

function parseArgs(argv) {
  const opts = { timeoutS: 120, jobs: 1, filter: null, files: [], fullTimeoutS: 900, shuffle: 0, each: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timeout') opts.timeoutS = Number(argv[++i]);
    else if (a === '--full-timeout') opts.fullTimeoutS = Number(argv[++i]);
    else if (a === '--jobs') opts.jobs = Math.max(1, Number(argv[++i]));
    else if (a === '--filter') opts.filter = new RegExp(argv[++i]);
    else if (a === '--shuffle') opts.shuffle = Math.max(0, Number(argv[++i]));
    else if (a === '--no-each') opts.each = false;
    else opts.files.push(a);
  }
  if (!opts.files.length) opts.files = ['test/ui.test.mjs', 'test/queue-ui.test.mjs'];
  return opts;
}

/** Runs `fn` over `items` with at most `jobs` in flight; keeps the input order in the result. */
async function pool(items, jobs, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let allOk = true;
  for (const file of opts.files) {
    console.log(`\n=== ${file}: run penuh ===`);
    const full = await runNodeTest(file, { timeoutMs: opts.fullTimeoutS * 1000 });
    const leaves = full.results.filter((r) => r.kind === 'test');
    const fullFails = leaves.filter((r) => r.status === 'fail');
    console.log(`run penuh: ${full.timedOut ? 'TIMEOUT' : `exit ${full.code}`}, ${leaves.length} test, ${fullFails.length} gagal, ${(full.ms / 1000).toFixed(0)} dtk`);
    for (const f of fullFails) console.log(`  GAGAL (penuh): ${f.name} — ${f.error}`);
    if (full.code !== 0 || full.timedOut) allOk = false;

    // Any order: node:test shuffles suites and the tests inside them (--test-randomize), seeds 1..N (reproducible).
    for (let seed = 1; seed <= opts.shuffle; seed++) {
      const r = await runNodeTest(file, { timeoutMs: opts.fullTimeoutS * 1000, extra: ['--test-randomize', `--test-random-seed=${seed}`] });
      const fails = r.results.filter((x) => x.kind === 'test' && x.status === 'fail');
      console.log(`run acak seed ${seed}: ${r.timedOut ? 'TIMEOUT' : `exit ${r.code}`}, ${r.results.filter((x) => x.kind === 'test').length} test, ${fails.length} gagal, ${(r.ms / 1000).toFixed(0)} dtk`);
      for (const f of fails) console.log(`  GAGAL (seed ${seed}): ${f.name} — ${f.error}`);
      if (r.code !== 0 || r.timedOut) allOk = false;
    }
    if (!opts.each) continue;
    if (!leaves.length) {
      console.log(full.tail);
      continue;
    }

    // Unique names only: a duplicate full name cannot be selected alone by a pattern.
    const counts = new Map();
    for (const l of leaves) counts.set(l.name, (counts.get(l.name) ?? 0) + 1);
    const targets = [...counts.keys()].filter((n) => !opts.filter || opts.filter.test(n));
    for (const [n, c] of counts) if (c > 1) console.log(`  PERINGATAN: nama ganda (${c}x), tak bisa dijalankan sendiri: ${n}`);

    console.log(`\n=== ${file}: ${targets.length} test, masing-masing sendiri (timeout ${opts.timeoutS} dtk, jobs ${opts.jobs}) ===`);
    const rows = await pool(targets, opts.jobs, async (name) => {
      const r = await runNodeTest(file, { pattern: `^${escapeRe(name)}$`, timeoutMs: opts.timeoutS * 1000 });
      const own = r.results.filter((x) => x.kind === 'test');
      const ran = own.length;
      const failed = own.filter((x) => x.status === 'fail');
      const status = r.timedOut ? 'TIMEOUT' : ran === 0 ? 'TIDAK-JALAN' : r.code === 0 && !failed.length ? (own.every((x) => x.status === 'skip') ? 'SKIP' : 'LULUS') : 'GAGAL';
      const line = `${status.padEnd(11)} ${(r.ms / 1000).toFixed(0).padStart(4)}s  ${name}`;
      console.log(line);
      if (status !== 'LULUS' && status !== 'SKIP') {
        for (const f of failed) console.log(`            ↳ ${f.error}`);
        if (!failed.length) console.log(r.tail.replace(/^/gm, '            | '));
      }
      return { name, status };
    });
    const bad = rows.filter((r) => r.status !== 'LULUS' && r.status !== 'SKIP');
    console.log(`\n${file}: ${rows.length - bad.length}/${rows.length} lulus sendiri${bad.length ? `; gagal: ${bad.length}` : ''}`);
    if (bad.length) allOk = false;
  }
  process.exitCode = allOk ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) await main();
