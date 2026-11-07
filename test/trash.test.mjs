// 🗑 Retensi trash: transcripts deleted from Riwayat sesi stay in <data>/trash/<project>/ for a while, then go.
// A throwaway folder only: nothing here touches real sessions.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { purgeTrash, TRASH_RETENTION_DAYS } from '../src/session-admin.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-trash-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.now();
const SID = (n) => `0000000${n}-aaaa-4bbb-8ccc-000000000000`;
const put = (dir, name, stamp, { sub = false } = {}) => {
  const file = path.join(dir, `${name}-${stamp}.jsonl`);
  writeFileSync(file, '{}\n');
  if (sub) mkdirSync(path.join(dir, `${name}-${stamp}`), { recursive: true });
  return file;
};

test('default retention is 30 days', () => {
  assert.equal(TRASH_RETENTION_DAYS, 30);
});

test('purge: only transcripts older than the window go, with their subagent folder', () => {
  const dataDir = path.join(TMP, 'd1');
  const dir = path.join(dataDir, 'trash', 'project-a');
  mkdirSync(dir, { recursive: true });
  const old = put(dir, SID(1), NOW - 40 * DAY, { sub: true });
  const fresh = put(dir, SID(2), NOW - 5 * DAY, { sub: true });
  const stray = path.join(dir, 'catatan.txt');
  writeFileSync(stray, 'bukan sesi');

  const result = purgeTrash({ dataDir, now: NOW });
  assert.deepEqual(result, { removed: 1 });
  assert.equal(existsSync(old), false, 'transkrip lama dihapus');
  assert.equal(existsSync(path.join(dir, `${SID(1)}-${NOW - 40 * DAY}`)), false, 'subagent ikut');
  assert.equal(existsSync(fresh), true, 'yang masih baru tetap ada');
  assert.equal(existsSync(path.join(dir, `${SID(2)}-${NOW - 5 * DAY}`)), true);
  assert.equal(existsSync(stray), true, 'file asing tidak disentuh');
});

test('purge: an emptied project folder is removed; 0 days keeps everything', () => {
  const dataDir = path.join(TMP, 'd2');
  const dir = path.join(dataDir, 'trash', 'project-b');
  mkdirSync(dir, { recursive: true });
  put(dir, SID(3), NOW - 60 * DAY);
  assert.deepEqual(purgeTrash({ dataDir, now: NOW, days: 0 }), { removed: 0 });
  assert.equal(existsSync(dir), true);
  assert.deepEqual(purgeTrash({ dataDir, now: NOW }), { removed: 1 });
  assert.equal(existsSync(dir), false, 'folder project kosong ikut dibersihkan');

  const other = path.join(TMP, 'd3', 'trash', 'project-c');
  mkdirSync(other, { recursive: true });
  const kept = put(other, SID(4), NOW - 60 * DAY);
  assert.deepEqual(purgeTrash({ dataDir: path.join(TMP, 'd3'), now: NOW, days: -1 }), { removed: 0 });
  assert.equal(existsSync(kept), true);
});

test('purge: no trash folder at all is not an error', () => {
  assert.deepEqual(purgeTrash({ dataDir: path.join(TMP, 'empty'), now: NOW }), { removed: 0 });
});

test('list and restore ignore files that are not trashed transcripts', () => {
  const dataDir = path.join(TMP, 'd4');
  const dir = path.join(dataDir, 'trash', 'project-d');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'notes.jsonl'), '{}\n');
  assert.deepEqual(readdirSync(dir), ['notes.jsonl']);
});
