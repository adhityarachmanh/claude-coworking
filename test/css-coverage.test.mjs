// 🧱 Every hyphenated class a feature puts in markup must have a rule in app.css. The "Grup proyek" dialog shipped
// with no CSS at all (grp-card, grp-member, groups-members …) and looked broken on every screen; this guard would
// have caught it. Classes listed below are deliberate exceptions: state hooks (`active`, `live`, `ok`), elements
// styled by id or by a parent rule, or layout handled entirely by their container.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(APP, 'public');

/** Hooks with no rules of their own today. Add a line only when the class really needs no style. */
const ALLOWED = new Set([
  'account-card', // #account-modal .modal-card styles it
  'att-icon', 'att-row', // attachment row: the parent .attachments styles it
  'audit-section', // plain section inside Akun (border comes from .acct-section)
  'auto-pair', // phone pairing note: .muted carries it
  'ba-weekday', // inside .backup-days grid
  'backup-password-label', // label text only
  'bm-time', // a <time> in a bookmark row
  'budget-scope', // span inside a label
  'checklist-card', // card body inside #checklist-modal
  'cl-mark', // one-character mark inside a checklist row
  'cli-badge', // small badge in the approval card
  'dash-stop', 'dash-work', // dashboard counters styled by their container
  'export-tools-opt', // checkbox row in the export dialog
  'health-activity', // list body inside .health-*
  'mcp-add', 'mcp-local', 'mcp-remote', // MCP dialog rows styled by their containers
  'model-search-ctl', // the picker's search row (the input inside is styled)
  'oc-go', 'oc-go-plan', 'oc-usage', // OpenCode Go quota/usage blocks (inner .acct-title etc.)
  'pal-close', // palette close button (styled as .icon-btn)
  'pal-group', // palette group wrapper
  'queue-add', 'queue-all-pin', // buttons that reuse .ghost/.icon
  'report-provider-daily', // list inside the provider section
  'ro-banner', // body.read-only #ro-banner styles it by id
  'routine-edit', 'routine-run', 'routine-list', // routine rows (container + buttons)
  'rp-row', // remote-power settings row
  'run-more', // "show more" line inside the activity run
  's-restore', // session restore button (reuses .ghost)
  'sheet-body', // phone sheet body (the sheet lays it out)
  'sl-chip', // statusline chips: the inner sl-* elements carry the look
  'sp-album', 'sp-device', 'sp-tr-list', // Spotify dialog blocks styled by their parent
  'unfold-pill', // #btn-unfold (mode baca) is styled by id
]);

const files = [path.join(PUBLIC, 'index.html')];
for (const dir of ['js/features', 'js/core', 'js/office', 'js/ui']) {
  for (const file of readdirSync(path.join(PUBLIC, dir))) if (file.endsWith('.js')) files.push(path.join(PUBLIC, dir, file));
}

test('every hyphenated class in the markup has a rule in app.css (or is a documented hook)', () => {
  const css = readFileSync(path.join(PUBLIC, 'css/app.css'), 'utf8');
  const defined = new Set([...css.matchAll(/\.(-?[a-z_][\w-]*)/g)].map((m) => m[1]));
  const orphans = new Map();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/class="([^"]+)"/g)) {
      if (match[1].includes('${')) continue; // dynamic: the runtime names are checked by the UI tests
      for (const token of match[1].split(/\s+/).filter(Boolean)) {
        if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(token) || defined.has(token) || ALLOWED.has(token)) continue;
        if (!orphans.has(token)) orphans.set(token, new Set());
        orphans.get(token).add(path.relative(PUBLIC, file));
      }
    }
  }
  const missing = [...orphans].map(([cls, where]) => `${cls} (${[...where].join(', ')})`).sort();
  assert.deepEqual(missing, [], `kelas tanpa CSS:\n  ${missing.join('\n  ')}`);
});
