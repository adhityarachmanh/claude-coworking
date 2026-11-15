// Run one named block of test/ui.test.mjs without executing the whole (slow) suite.
//   node test-support/ui-area.mjs "settings: WhatsApp card"   # npm run test:ui:area -- "settings: WhatsApp card"
//   node test-support/ui-area.mjs settings                    # every block whose name contains "settings"
//   node test-support/ui-area.mjs settings compact            # several blocks, one child run each
// Blocks are the top-level `describe(...)` calls of test/ui.test.mjs. `ui-area` never edits the suite: it starts one
// `node --test` child per filter, and in that child the suite's `describeArea` (test-support/ui-area-select.mjs)
// skips the blocks whose names do not contain the filter — their setup never runs.
//
// One child per filter on purpose: the suite's server, browser and page setup is shared, and one long-lived page per
// viewport is reused, so two unrelated blocks in the same process are slower than the same blocks one after another.
// A filtered run is the fastest way to check one area. No test is removed: `npm run test:ui` sets no filter and runs
// everything exactly as before.
//
// The runner prints one line when a child starts and a heartbeat every 30 s while it runs: the suite is silent for
// minutes at a time (server start, browser launch, a long block), and silence must not look like a hung command.
//
// A filter that matches nothing must never look green: the suite itself fails a named test for it (see below), and a
// child that still reports "tests 0" is printed as GAGAL too. A child that never exits is killed after
// UI_AREA_TIMEOUT_MS (default 30 minutes) and reported as GAGAL.
// A selected-but-empty filter is caught inside the suite (`checkUiSelection` at the end of test/ui.test.mjs), which
// fails a named test instead of letting the runner pass with zero tests: `--test-force-exit` would exit faster but
// Node 26 then runs out of memory on this file, so the guard is in the suite, not in the flags.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = path.join('test', 'ui.test.mjs');
const HEARTBEAT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/** The filters from argv: one per argument, each may hold commas. */
export const areasOf = (argv) => argv.flatMap((a) => String(a).split(',')).map((s) => s.trim()).filter(Boolean);

/** The `--test-name-pattern` value for one filter (regex-escaped, nothing else). */
export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every block name the suite registers, with `${vp.name}` expanded for each viewport, so a filter can be checked
 * before a child is started (a typo used to boot a server and a browser, then fail ~5 s later).
 */
export function blockNamesOf(source) {
  const viewports = [...String(source).matchAll(/\{\s*name:\s*'([^']+)'/g)].map((m) => m[1]);
  const names = [];
  for (const m of String(source).matchAll(/describeArea\(\s*(`([^`]*)`|'([^']*)'|"([^"]*)")/g)) {
    const raw = m[2] ?? m[3] ?? m[4] ?? '';
    if (!raw.includes('${')) {
      if (raw) names.push(raw);
      continue;
    }
    const template = raw.replace(/\$\{[^}]*\}/g, '\u0000');
    for (const vp of viewports) names.push(template.replace(/\u0000/g, vp));
  }
  return names;
}

/** True when any block name contains the filter (the same substring rule describeArea uses). */
export const filterMatches = (area, names) => names.some((name) => name.includes(area));

/** Run one filter in its own `node --test` child; resolves { area, status, out, timedOut }. */
function runArea(area) {
  const timeoutMs = Number(process.env.UI_AREA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-name-pattern', escapeRegExp(area), SUITE], {
      cwd: APP,
      windowsHide: true,
      // No colours: the report is parsed for the summary, and a TTY-less child may still emit escape codes.
      env: { ...process.env, UI_ONLY: area, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    const started = Date.now();
    const heartbeat = setInterval(() => {
      console.log(`ui-area: … ${JSON.stringify(area)} masih jalan (${Math.round((Date.now() - started) / 1000)} dtk)`);
    }, HEARTBEAT_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (status) => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      resolve({ area, status, out, timedOut });
    });
  });
}

/** True when the child actually ran at least one test (node prints "ℹ tests 0" / "# tests 0"). */
const ranSomething = (out) => !/^\s*(?:ℹ|#) tests 0\b/m.test(out);

/** The pass/fail lines of a child report, for the one-line summary. */
const summaryOf = (out) => (out.match(/^\s*(?:ℹ|#) (?:tests|pass|fail) \d+.*$/gm) ?? []).map((l) => l.trim()).join(', ');

async function main(argv) {
  const areas = areasOf(argv);
  if (!areas.length) {
    console.error('pakai: node test-support/ui-area.mjs "<nama blok>" [<nama blok>…]');
    console.error('contoh: node test-support/ui-area.mjs "settings: WhatsApp card"');
    process.exit(2);
  }
  const failed = [];
  const empty = [];
  const slow = [];
  const blocks = blockNamesOf(readFileSync(path.join(APP, SUITE), 'utf8'));
  for (const area of areas) {
    // A filter that matches no block is a typo: say so now instead of starting a server and a browser for nothing.
    if (!filterMatches(area, blocks)) {
      empty.push(area);
      console.log(`ui-area: GAGAL ${JSON.stringify(area)} — tidak ada blok yang cocok (0.0 dtk). Cek ejaan di docs/uji-ui.md.`);
      continue;
    }
    console.log(`ui-area: mulai ${JSON.stringify(area)}`);
    const started = Date.now();
    const { status, out, timedOut } = await runArea(area);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const summary = summaryOf(out);
    if (timedOut) {
      process.stdout.write(out.slice(-4000));
      failed.push(area);
      slow.push(area);
      console.log(`\nui-area: GAGAL ${JSON.stringify(area)} — melewati batas waktu (${seconds} dtk). Naikkan UI_AREA_TIMEOUT_MS bila blok ini memang lama.`);
    } else if (status !== 0) {
      process.stdout.write(out);
      failed.push(area);
      console.log(`\nui-area: GAGAL ${JSON.stringify(area)} (${seconds} dtk) ${summary}`);
    } else if (!ranSomething(out)) {
      empty.push(area);
      console.log(`ui-area: GAGAL ${JSON.stringify(area)} — tidak ada test yang cocok (${seconds} dtk). Cek ejaan nama blok.`);
    } else {
      console.log(`ui-area: lulus ${JSON.stringify(area)} (${seconds} dtk) ${summary}`);
    }
  }
  console.log(`\nui-area: ${areas.length - failed.length - empty.length} lulus, ${failed.length} gagal, ${empty.length} tanpa test`);
  for (const a of failed) console.log(`  GAGAL ${a}`);
  for (const a of empty) console.log(`  TANPA TEST ${a}`);
  process.exit(failed.length || empty.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
