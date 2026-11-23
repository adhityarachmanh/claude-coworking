// ⚠ Papan "perlu tindakan": CI merah, model hilang, OpenCode berhenti, dan pilihan mode lama ikut terdaftar.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';
import { buildRouter } from '../src/routes/index.js';

test('attention: status project yang menghambat masuk daftar', async () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'att-data-')) });
  const project = hub.upsertProject(mkdtempSync(path.join(tmpdir(), 'att-proj-')), 'custom');
  hub.setStatus(project.id, { ci: { state: 'failure' }, modelStale: true, openCodeDown: true });
  hub.persisted.settings[project.id].modePendingChoice = true;
  const router = buildRouter();
  const route = router.routes.find((r) => r.pattern === '/api/attention');
  let status = 0;
  let text = '';
  const res = { writeHead: (s) => (status = s), end: (t) => (text = t ?? '') };
  await route.handler({ hub, ledger: null, taskQueue: null }, { headers: {} }, res, {}, {});
  const body = JSON.parse(text);
  assert.equal(status, 200);
  const kinds = body.items.map((i) => i.kind);
  for (const kind of ['ci', 'model', 'engine', 'mode']) assert.ok(kinds.includes(kind), kind);
  assert.ok(body.items.filter((i) => i.kind === 'ci').every((i) => i.project === project.id));
});
