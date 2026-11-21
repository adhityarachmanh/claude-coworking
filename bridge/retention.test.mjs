// bridge/retention.test.mjs — retensi terjadwal Chat Web (kepatuhan): sesi kedaluwarsa dibersihkan,
// jejak tool_run lebih tua dari batas dibuang, yang baru tetap. Memakai repo memory (cepat, tanpa DB).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeMemoryRepo } from './src/repo-memory.mjs';
import { sweepChatRetention, TOOL_RUN_KEEP_MS } from './src/retention.mjs';

test('sweep retensi: sesi kedaluwarsa hilang, sesi aktif tetap', async () => {
  const repo = makeMemoryRepo();
  const u = await repo.createUser({ email: 'a@b.co', passwordHash: 'scrypt$a$b' });
  await repo.createSession({ tokenHash: 'old', userId: u.id, expiresAt: '2000-01-01T00:00:00.000Z' });
  await repo.createSession({ tokenHash: 'new', userId: u.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  await sweepChatRetention(repo);
  assert.equal(await repo.getSession('old'), null, 'sesi kedaluwarsa dibersihkan');
  assert.ok(await repo.getSession('new'), 'sesi aktif tidak tersentuh');
});

test('sweep retensi: tool run lebih tua dari batas dibuang, yang baru tetap', async () => {
  const repo = makeMemoryRepo();
  const u = await repo.createUser({ email: 'a@b.co', passwordHash: 'scrypt$a$b' });
  const c = await repo.createConversation(u.id, {});
  const now = Date.now();
  // Sisipkan baris lama & baru langsung ke state (created_at dikendalikan test).
  repo._state.toolRuns.push(
    { id: 'old', conversation_id: c.id, tool: 'web_search', created_at: new Date(now - TOOL_RUN_KEEP_MS - 1000).toISOString() },
    { id: 'new', conversation_id: c.id, tool: 'web_search', created_at: new Date(now).toISOString() },
  );
  await sweepChatRetention(repo, now);
  assert.equal(await repo.countToolRuns(u.id, c.id), 1, 'hanya tool run baru yang tersisa');
});

test('sweep retensi: repo tanpa metode (mis. env jembatan) tidak melempar', async () => {
  assert.deepEqual(await sweepChatRetention({}), { ok: false });
  assert.deepEqual(await sweepChatRetention(null), { ok: false });
});