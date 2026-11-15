# UI Suite Split — Faster Development Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the browser (CDP) test suite runnable per *area* and in parallel, so a normal change waits minutes instead of half an hour, while running exactly the same tests.

**Architecture:** The single 10.584-line `test/ui.test.mjs` (12 top-level `describe` blocks, ~200 tests) is split into focused files under `test/ui/`, with the shared server/browser/helpers extracted into `test-support/ui-harness.mjs`. Hooks (`before`/`after`/`afterEach`) move into each new file so every file starts and stops its own server — self-contained, parallel-safe. `test-support/ci-tests.mjs` gains `ui:<area>`, `ui:changed` (maps changed source files to the areas that can regress) and a parallel `ui` mode. No test assertion changes.

**Tech Stack:** Node 22+ (`node:test`, global WebSocket), the project's dependency-free CDP client (`test-support/cdp.mjs`), `node:child_process` for parallelism.

**Spec:** `docs/superpowers/specs/2026-11-15-ui-suite-split.md` (created in Task 1 Step 1: the measurement baseline + area table below is the spec's content).

## Global Constraints

- **Do not commit, do not push, do not release** — all work stays in the working tree; version stays `1.0.33`.
- **Zero test loss:** before and after, the number of executed tests per area must match the baseline recorded in Task 1. A test that cannot run is a failure, not a skip.
- **No assertion changes** while moving code: this refactor only moves text. Fixes go in a separate change.
- Files move with their own helpers; nothing is "temporarily" duplicated between area files.
- UI files must keep importing `test-support/cdp.mjs` (that regex is how `isUi()` recognises them — `test-support/ci-tests.mjs:33`).
- Area files live in `test/ui/`; `ci-tests.mjs` and `isUi()` must find them (`test/ui/*.test.mjs`).
- Language of code comments and test names: follow the existing file (English comments, Indonesian user-facing strings).
- `npm run test:ui` must keep working unchanged for CI; a failing file is retried once and reported as FLAKY (existing behaviour).

## Review Focus

- **A test silently stops running** after the split (a `describe` left behind, a helper moved but a test still referencing the old name): the count check per area in Task 9 catches it.
- **Parallel runs colliding** on ports, temp data dirs, or `data/` (each area file must own its server, port and temp dir).
- **Flaky failures caused by parallelism** that the serial suite never showed (real timing assumptions, shared temp paths).
- **`ui:changed` selecting too narrow a set** — a shared file (`public/index.html`, `app.css`, `server.js`) must fall back to *all* areas rather than to none.
- **Hooks lost during the move** (`afterEach` in the original file is what cleans a temp project; losing it leaves state that makes later tests fail).

---

## Area table (the decision this plan pins)

| Area id | New file | Source lines in `test/ui.test.mjs` | What it covers |
|---|---|---|---|
| `core` | `test/ui/core.test.mjs` | 1226–7246 (loop `for (const vp of VIEWPORTS) { describe(\`UI ${vp.name}\`…) }`) | index/demo, every modal/a11y audit, contrast, settings sheet, report, sessions, phone card |
| `compact` | `test/ui/compact.test.mjs` | 7247–7616 | 🧹 Ringkas konteks |
| `security` | `test/ui/security.test.mjs` | 7617–7659 | CSP / printable report |
| `phone` | `test/ui/phone.test.mjs` | 7660–7802 | read-only phone over WiFi |
| `live` | `test/ui/live.test.mjs` | 7803–8010 | live chat bubbles + lost connection (server restart) |
| `palette` | `test/ui/palette.test.mjs` | 8011–8849 | Ctrl+P palette, search, export .md |
| `notify` | `test/ui/notify.test.mjs` | 8850–8900 | notification settings, voice input |
| `tiers` | `test/ui/tiers.test.mjs` | 8901–10130 | tier commands, focus mode |
| `dashboard` | `test/ui/dashboard.test.mjs` | 10131–10312 | 🗂 Semua project |
| `settings` | `test/ui/settings.test.mjs` | 10313–10583 | 📱 PIN ke HP + 🔐 Akses saat PC terkunci |

Shared lines: `1–1140` (imports, `VIEWPORTS`, `TRIGGERS`, `IGNORED_PROBLEMS`, server/browser lifecycle, in-page probes, helpers) → `test-support/ui-harness.mjs`; `1141–1225` (first test block) belongs to `core`.

---

### Task 1: Baseline measurement and area map

**Files:**
- Create: `docs/superpowers/specs/2026-11-15-ui-suite-split.md`
- Read: `test/ui.test.mjs`, `test-support/ci-tests.mjs`

**Interfaces:**
- Produces: the recorded baseline (per-area test counts and serial duration) that Task 9 compares against; the area table above, copied into the spec.

- [ ] **Step 1: Write the spec file** with: the problem (one 10k-line file → no parallelism, every change waits for everything), the area table (copy from above, with the real line numbers you verify), the constraint "zero test loss", and the target ("`ui:changed` for a settings-only change runs ≤ 2 area files and finishes in < 5 min on this laptop").

- [ ] **Step 2: Record the baseline** — run `node --test test/ui.test.mjs > %TEMP%\ui-baseline.log 2>&1` once (allow up to 40 minutes; do not stop it). Save in the spec:
  - `ℹ tests`, `ℹ pass`, `ℹ fail`, `ℹ skipped` totals;
  - per `describe` block counts, taken from `node -e` over the file: for each of the 12 `describe(` lines, count `test(` lines inside its block (the spec lists the numbers).
  - total wall-clock time.

- [ ] **Step 3: Verify the area table against the file** — for each row, confirm the line range starts at a `// ----------` marker (or the `for (const vp of VIEWPORTS)` loop for `core`) and ends at the last line before the next marker. Correct the table where the file disagrees; the file wins.

- [ ] **Step 4: Check the plan is honest about risk** — add to the spec a "Risiko" section: parallel runs could expose timing flakiness, and `live` restarts the server so it must not share a port with another area; mitigation = unique ports per area (Task 3).

---

### Task 2: Extract the shared harness

**Files:**
- Create: `test-support/ui-harness.mjs`
- Modify: `test/ui.test.mjs` (imports only)
- Test: `node --test test/ui.test.mjs` (still passes unchanged)

**Interfaces:**
- Consumes: nothing.
- Produces (all named exports, so area files import exactly these):
  - `export const VIEWPORTS`, `export const TRIGGERS`, `export const IGNORED_PROBLEMS`
  - `export const sleep`, `export const horizontalOverflow`, `export const contrastProblems`, `export const modalState`, `export const realProblems`
  - `export async function startOffice()` → `{ BASE, PORT, TMP, server, projectId }`; it starts the fake-Claude server on an **area-specific port** (`process.env.OFFICE_UI_PORT` or a free port chosen via `net`), with its own `TMP` data dir.
  - `export async function openBrowser()` → browser handle from `launchBrowser`, or `null` when `cdpUnavailableReason()` is non-null.
  - `export async function stopOffice(office)`, `export async function closeBrowser(browser)`
  - `export async function openApp(page, hash)`, `export async function ensureApp(page, hash)`, `export async function apiPost(base, path, body)`, `export async function addTempProject(base, name)`, `export function forgetTempProject(base, id)`
  - the page interaction helpers that take `page` as their first argument (`tap`, `tapMore`, `typeInPrompt`, `settle`, `checkModal`, `bannerText`, …), unchanged in behaviour.

- [ ] **Step 1: Move the module-level code** (lines 1–1140) into `test-support/ui-harness.mjs` verbatim, replacing the `before`/`after` lifecycle with the exported `startOffice()`/`stopOffice()` functions (the lifecycle hooks stay in the test files). Every helper that closed over the module-level `BASE`, `projectId`, `PORT`, `TMP` must take that value as a parameter instead — list the changes explicitly in a header comment.

- [ ] **Step 2: Make the port per-run** — `startOffice()` picks `OFFICE_UI_PORT` from the environment when set, else asks the OS for a free port (`net.createServer().listen(0)`), so two area files can run at the same time. No test hard-codes `4317`.

- [ ] **Step 3: Rewire `test/ui.test.mjs`** to import from the harness and keep its own `before`/`after`:

```js
import { after, before, describe, test } from 'node:test';
import { VIEWPORTS, startOffice, stopOffice, openBrowser, closeBrowser, openApp, ensureApp, realProblems, … } from '../test-support/ui-harness.mjs';

let office; let browser;
before(async () => { office = await startOffice(); browser = await openBrowser(); });
after(async () => { await closeBrowser(browser); await stopOffice(office); });
```

- [ ] **Step 4: Run the suite and compare counts** — `node --test test/ui.test.mjs` → `ℹ tests` equals the baseline. A different number means the move changed behaviour: fix before continuing.

- [ ] **Step 5: Run the lint** — `npm run lint` exit 0 (no unused imports left behind).

---

### Task 3: Split `core` (the big viewport loop) and prove the pattern

**Files:**
- Create: `test/ui/core.test.mjs`
- Modify: `test/ui.test.mjs` (remove the `for (const vp of VIEWPORTS)` block at 1226–7246 and the first test block at 1141–1225 moved into it)
- Test: `node --test test/ui/core.test.mjs`

**Interfaces:**
- Consumes: everything from `test-support/ui-harness.mjs`.
- Produces: the per-file skeleton every later area copies:

```js
let office; let browser;
before(async () => { office = await startOffice(); browser = await openBrowser(); });
after(async () => { await closeBrowser(browser); await stopOffice(office); });
```

and, inside each `describe`, the original `let page; before(async () => { page = await browser.newPage(); await page.setViewport(vp); }); after(async () => page?.close());` unchanged.

- [ ] **Step 1: Create `test/ui/core.test.mjs`** with the harness import, the skeleton above, and the block moved verbatim.

- [ ] **Step 2: Run it** — `node --test test/ui/core.test.mjs` → `ℹ tests` equals the baseline count for `core` (both viewports). Expect several minutes: this is the largest area.

- [ ] **Step 3: Run it twice** — the second run must give the same counts (no state leaking between runs through `TMP`).

- [ ] **Step 4: Trim `test/ui.test.mjs`** to whatever is left after Task 4–6 move the rest; until then it keeps the remaining blocks.

---

### Task 4: Move the independent feature areas

**Files:**
- Create: `test/ui/compact.test.mjs`, `test/ui/security.test.mjs`, `test/ui/phone.test.mjs`, `test/ui/dashboard.test.mjs`, `test/ui/settings.test.mjs`, `test/ui/notify.test.mjs`
- Modify: `test/ui.test.mjs` (delete the moved lines)

**Interfaces:**
- Consumes: the same skeleton as Task 3; any file-local helper (e.g. `stubWa`, `stubAutologon`, `WA_QR_PNG` for `settings`) moves with its area.
- Produces: six files, each runnable alone.

- [ ] **Step 1: Move one file at a time.** After each move, run it alone (`node --test test/ui/<area>.test.mjs`) and record the count. Order: `security` (2 tests, fastest feedback), `dashboard`, `notify`, `compact`, `phone`, `settings`.

- [ ] **Step 2: Keep file-local helpers local** — do not add them to the harness unless two areas import them; a second copy is cheaper to review than a shared helper with an area-specific name.

- [ ] **Step 3: Delete the moved lines from `test/ui.test.mjs`** in the same edit, so the file only ever shrinks.

---

### Task 5: Move `palette` and `tiers` (the two ~1000-line areas)

**Files:**
- Create: `test/ui/palette.test.mjs`, `test/ui/tiers.test.mjs`
- Modify: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `keyCombo` and other helpers currently defined between 8011 and 8904 — they move into `palette.test.mjs`; `tiers` keeps any helper it alone uses.
- Produces: two files, each runnable alone.

- [ ] **Step 1: Move `palette`** (8011–8849 incl. `keyCombo`) → run alone → count matches.

- [ ] **Step 2: Move `tiers`** (8901–10130) → run alone → count matches.

- [ ] **Step 3: Check cross-imports** — `grep -n "keyCombo" test/ui/*.test.mjs` must show it defined exactly once (in `palette.test.mjs`) unless a second area uses it; if so, move it to the harness instead.

---

### Task 6: Move `live` (server restart) and delete the original file

**Files:**
- Create: `test/ui/live.test.mjs`
- Delete: `test/ui.test.mjs` (when it is empty)

**Interfaces:**
- Consumes: `startOffice()`/`stopOffice()` — this area stops and restarts the server itself, so it calls `stopOffice(office)` then `startOffice()` again and must update its own `BASE`.
- Produces: the complete set of area files; no `test/ui.test.mjs` left.

- [ ] **Step 1: Move `live`** (7803–8010) and adapt the restart: instead of reaching into the old module-level `server`/`BASE`, call the harness's stop/start and keep the new `BASE`.

- [ ] **Step 2: Run it alone** — count matches; it must not be able to affect any other area (own port, own temp dir).

- [ ] **Step 3: Confirm `test/ui.test.mjs` no longer exists** and `git status` shows only additions/deletions, no rename of the whole file (that keeps the diff readable).

---

### Task 7: Teach the runner about areas and parallelism

**Files:**
- Modify: `test-support/ci-tests.mjs`
- Test: `node test-support/ci-tests.mjs ui:settings`, `… ui:changed`

**Interfaces:**
- Consumes: `test/ui/*.test.mjs`.
- Produces:
  - `isUi()` also matches `test/ui/` (`/test-support[/\\]cdp\.mjs/` on the file source stays the rule — area files import it).
  - `node test-support/ci-tests.mjs ui[:<area>|:<a,b>]` — unknown area → exit 2 with the list of valid areas.
  - `node test-support/ci-tests.mjs ui:changed [--base <ref>]` — maps `git diff --name-only <base>` (default `HEAD`) to areas: a changed file under `public/js/features/<x>.js` maps to the area owning that feature, `public/index.html`, `public/css/app.css`, `src/server.js`, `server.js` or any `src/**` map to **all** areas. Unknown file → all areas (never "none").
  - `npm run test:ui` runs **all areas in parallel**, `UI_WORKERS` (default 4) at a time, reuses the existing per-file timeout and single retry, and prints the same PASS/FLAKY/FAIL summary.

- [ ] **Step 1: Write the mapping as data** in `ci-tests.mjs`:

```js
const UI_AREAS = {
  core: ['core'],
  compact: ['compact'],
  security: ['security'],
  phone: ['phone'],
  live: ['live'],
  palette: ['palette'],
  notify: ['notify'],
  tiers: ['tiers'],
  dashboard: ['dashboard'],
  settings: ['settings'],
};
const UI_SHARED = [/^public\/index\.html$/, /^public\/css\//, /^public\/js\/core\//, /^public\/js\/office\//, /^src\//, /^server\.js$/];
const UI_FEATURE = { settings: ['settings'], compact: ['compact'], dashboard: ['dashboard'] };
```

- [ ] **Step 2: Implement `ui:changed`** — for each changed path: shared → all; `public/js/features/<name>.js` in `UI_FEATURE` → that area; otherwise all. Print the selected areas before running.

- [ ] **Step 3: Implement parallel `ui`** — a tiny pool (no dependencies): start up to `UI_WORKERS` `node --test` children, collect exit codes, keep the retry-once-for-failing-file behaviour. `UI_WORKERS=1` must reproduce the old serial behaviour exactly (same order, same summary).

- [ ] **Step 4: Run both modes** — `ui:settings` (fast) and `ui` with `UI_WORKERS=1` (full, serial, comparable to the baseline) and with `UI_WORKERS=4` (full, parallel). Parallel failures that do not reproduce serially are reported as BLOCKED-BY-PARALLELISM, not hidden: fix the shared state or lower the worker count.

- [ ] **Step 5: Update `package.json`** — add `"test:ui:fast": "node test-support/ci-tests.mjs ui:changed"` and `"test:ui:settings": "node test-support/ci-tests.mjs ui:settings"` (keeps the daily loop one command).

---

### Task 8: Documentation

**Files:**
- Modify: `README.md` (testing section), `test-support/ci-tests.mjs` header comment
- Create: `docs/uji-ui.md` (short: which area owns which screen, how to run one area, when to run all)

**Interfaces:**
- Consumes: Task 7 commands.
- Produces: documentation naming `test:ui:fast`, `test:ui`, and the area→screen table.

- [ ] **Step 1: Write `docs/uji-ui.md`** — the area table, `npm run test:ui:settings` for a fast check, `npm run test:ui` before a release, and a note that area files must not share ports/temp dirs.

- [ ] **Step 2: Point README's testing section at it** (one paragraph, no duplicated table).

---

### Task 9: Verification gate

**Files:**
- Modify: `docs/superpowers/specs/2026-11-15-ui-suite-split.md` (record the results)

- [ ] **Step 1: Zero test loss** — sum of `ℹ tests` over all area files (serial run) equals the baseline total; per-area counts equal Task 1 Step 2 numbers.

- [ ] **Step 2: Full suite, serial** — `UI_WORKERS=1 node test-support/ci-tests.mjs ui` → 0 gagal (flaky listed, not hidden).

- [ ] **Step 3: Full suite, parallel** — `UI_WORKERS=4 node test-support/ci-tests.mjs ui` → 0 gagal; record the wall-clock time and compare it to the baseline (target: at least 2× faster).

- [ ] **Step 4: The dev loop** — change one line in `public/js/features/settings.js` (do not keep the change), run `npm run test:ui:fast`, record that only `settings` ran and the time it took (target < 5 min).

- [ ] **Step 5: Other gates untouched** — `npm run test:fast` and `npm run test:smoke` still exit 0; `npm run lint` exit 0.

- [ ] **Step 6: Record everything in the spec** and, if any area had to be reordered or merged, update the area table to match reality.

---

## Risks and how this plan handles them

| Risk | Mitigation |
|---|---|
| A test never runs again | Task 9 Step 1 compares per-area counts with the baseline |
| Parallel runs collide on ports/temp | `startOffice()` allocates a free port and its own temp dir per file (Task 2 Step 2) |
| `live` restarts a server other areas use | Each file owns its server; `live` restarts only its own (Task 6) |
| Timing flakes surface only in parallel | Task 7 Step 4 requires reporting BLOCKED-BY-PARALLELISM and fixing shared state rather than retrying blindly |
| `ui:changed` picks too few areas | Shared files map to **all** areas; unknown files map to all (Task 7 Step 2) |
