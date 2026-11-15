// `describeArea` for test/ui.test.mjs: run only the blocks UI_ONLY selects (set by test-support/ui-area.mjs).
//
// UI_ONLY holds a comma-separated list of substrings of `describe` names. A block whose name contains one of them
// runs in full; every other block is dropped (not skipped) so its hooks — server, browser, page — never run and the
// report shows only the tests that were asked for. Without UI_ONLY nothing changes: `npm run test:ui` runs all blocks.
//
// A filter that matches nothing would run zero tests and still exit 0, so ui-area runs the child with the same
// filter as `--test-name-pattern`; node then reports "tests 0" for a typo, which ui-area prints as GAGAL.
import { describe } from 'node:test';

const filters = () =>
  (process.env.UI_ONLY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function uiSelected(name) {
  const wanted = filters();
  return !wanted.length || wanted.some((f) => String(name).includes(f));
}

export function describeArea(name, options, fn) {
  if (!uiSelected(name)) return;
  return options?.skip ? describe(name, options, fn) : describe(name, fn);
}
