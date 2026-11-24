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

test('attention: rekap mingguan yang belum dibaca tampil sampai ditandai dibaca', async () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'att-data-')) });
  hub.persisted.digest = { enabled: true, weekday: 1, time: '08:00', lastAt: 1_700_000_000_000, lastMarkdown: '# Rekap 7 hari', seenAt: null };
  const router = buildRouter();
  const route = router.routes.find((r) => r.pattern === '/api/attention');
  const call = async () => {
    let text = '';
    await route.handler({ hub, ledger: null, taskQueue: null }, { headers: {} }, { writeHead: () => {}, end: (t) => (text = t ?? '') }, {}, {});
    return JSON.parse(text);
  };
  const first = await call();
  const digest = first.items.find((i) => i.kind === 'digest');
  assert.ok(digest, 'rekap baru masuk papan');
  assert.match(digest.label, /Rekap mingguan siap/);
  assert.equal(digest.detail.includes('Pola kerja'), true);
  hub.markDigestSeen(1_700_000_000_001);
  const second = await call();
  assert.equal(second.items.some((i) => i.kind === 'digest'), false, 'sudah dibaca: hilang dari papan');
});
