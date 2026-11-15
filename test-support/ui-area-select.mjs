// `describeArea` for test/ui.test.mjs: run only the blocks UI_ONLY selects (set by test-support/ui-area.mjs).
//
// UI_ONLY holds a comma-separated list of substrings of `describe` names. A block whose name contains one of them
// runs in full; every other block is dropped (not skipped) so its hooks — server, browser, page — never run and the
// report shows only the tests that were asked for. Without UI_ONLY nothing changes: `npm run test:ui` runs all blocks.
//
// A filter that matches nothing would run zero tests and still exit 0, so the suite ends with `checkUiSelection()`:
// a typo fails a named test (which ui-area prints as GAGAL) instead of passing silently.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const filters = () =>
  (process.env.UI_ONLY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Counted as blocks register, so `checkUiSelection` can tell "filter matched nothing" from "no filter".
let selected = 0;

export function uiSelected(name) {
  const wanted = filters();
  return !wanted.length || wanted.some((f) => String(name).includes(f));
}

export function describeArea(name, options, fn) {
  if (!uiSelected(name)) return;
  selected += 1;
  return options?.skip ? describe(name, options, fn) : describe(name, fn);
}

/**
 * Called once at the end of the suite: a filter that matched no block must fail, not report "tests 0" as success.
 * Without UI_ONLY (a full run) this does nothing.
 */
export function checkUiSelection() {
  const wanted = filters();
  if (!wanted.length || selected > 0) return;
  test(`filter area ${JSON.stringify(wanted.join(', '))} cocok dengan blok mana pun`, () => {
    assert.fail(`UI_ONLY="${wanted.join(',')}" tidak cocok dengan nama blok mana pun di test/ui.test.mjs. Lihat daftar blok di docs/uji-ui.md.`);
  });
}
