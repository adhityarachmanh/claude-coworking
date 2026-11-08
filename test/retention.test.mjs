// Data retention (src/retention.js, UsageLedger.pruneBefore, Hub.pruneChatsBefore): validation, a dry-run preview,
// and the real cleanup — old rows/messages go, rows/messages without a timestamp and torn lines stay.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hub } from '../src/hub.js';
import { applyRetention, cleanRetentionDays, isRetentionDays, retentionOf, retentionPreview, setRetention } from '../src/retention.js';
import { UsageLedger } from '../src/usage.js';

const DAY = 86_400_000;
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-retention-'));
  dirs.push(dir);
  return dir;
}

const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
const jsonLines = (file) => lines(file).map((line) => JSON.parse(line));
/** JSON rows of a file, skipping a torn/hand-edited line (which retention must keep). */
const parsedLines = (file) =>
  lines(file).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

function ledgerAt(file) {
  return new UsageLedger({ file, account: () => null });
}

function usageRow(ts, extra = {}) {
  return { ts, account: { id: 'akun-a' }, project: 'toko', projectId: 'p1', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, ...extra };
}

test('retention: days are a whole number 0…3650, anything else means keep forever', () => {
  assert.equal(isRetentionDays(0), true);
  assert.equal(isRetentionDays(30), true);
  assert.equal(isRetentionDays(3650), true);
  assert.equal(isRetentionDays(3651), false);
  assert.equal(isRetentionDays(-1), false);
  assert.equal(isRetentionDays(1.5), false);
  assert.equal(isRetentionDays('30'), false);
  assert.equal(cleanRetentionDays(90), 90);
  assert.equal(cleanRetentionDays(0), 0);
  assert.equal(cleanRetentionDays(undefined), 0);
  assert.equal(cleanRetentionDays('90'), 0);
  assert.equal(cleanRetentionDays(4000), 0);
});

test('retention: setRetention validates, saves to state.json, and reads back', () => {
  const dataDir = path.join(tmp(), 'data');
  const hub = new Hub({ dataDir });
  assert.deepEqual(retentionOf(hub), { chatsDays: 0, usageDays: 0 }, 'missing setting = keep forever');

  assert.throws(() => setRetention(hub, { chatsDays: 4000 }), (err) => err.status === 400);
  assert.throws(() => setRetention(hub, { usageDays: '30' }), (err) => err.status === 400);
  assert.deepEqual(retentionOf(hub), { chatsDays: 0, usageDays: 0 }, 'a refused save changes nothing');

  assert.deepEqual(setRetention(hub, { chatsDays: 30, usageDays: 90 }), { chatsDays: 30, usageDays: 90 });
  assert.deepEqual(retentionOf(hub), { chatsDays: 30, usageDays: 90 });
  const state = JSON.parse(readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.retention, { chatsDays: 30, usageDays: 90 }, 'written to disk at once');

  // A patch only touches the fields it names.
  assert.deepEqual(setRetention(hub, { chatsDays: 0 }), { chatsDays: 0, usageDays: 90 });
});

test('retention: preview counts without writing; apply removes old messages/rows and keeps everything else', () => {
  const now = Date.now();
  const old = now - 40 * DAY;
  const dir = tmp();
  const dataDir = path.join(dir, 'data');
  const chats = path.join(dataDir, 'chats');
  mkdirSync(chats, { recursive: true });
  const chatFile = path.join(chats, 'lama.jsonl');
  writeFileSync(
    chatFile,
    [
      { id: 'm1', ts: old, project: 'lama', kind: 'assistant', text: 'pesan lama' },
      { id: 'm2', ts: now, project: 'lama', kind: 'assistant', text: 'pesan baru' },
      { id: 'm3', project: 'lama', kind: 'info', text: 'tanpa waktu' },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n') + '\n',
  );
  const usageFile = path.join(dataDir, 'usage.jsonl');
  mkdirSync(path.dirname(usageFile), { recursive: true });
  writeFileSync(usageFile, [`${JSON.stringify(usageRow(old))}`, `${JSON.stringify(usageRow(now))}`, `${JSON.stringify({ account: { id: 'akun-a' } })}`, 'bukan-json'].join('\n') + '\n');

  const hub = new Hub({ dataDir });
  hub.persisted.retention = { chatsDays: 30, usageDays: 30 };
  const ledger = ledgerAt(usageFile);
  const rt = hub.rt('lama'); // read at start: this is the same array the running chat uses
  const events = [];
  const broadcast = hub.broadcast;
  hub.broadcast = (type, data) => events.push({ type, data });

  const preview = retentionPreview(hub, ledger, now);
  assert.deepEqual(preview.chats, { messages: 1, projects: 1 });
  assert.deepEqual(preview.usage, { rows: 1, files: 1 });
  assert.equal(preview.cutoff.chats, now - 30 * DAY);
  assert.equal(preview.cutoff.usage, now - 30 * DAY);
  assert.equal(lines(chatFile).length, 3, 'preview wrote nothing to the chat file');
  assert.equal(lines(usageFile).length, 4, 'preview wrote nothing to the ledger');

  const result = applyRetention(hub, ledger, now);
  hub.broadcast = broadcast;
  assert.deepEqual(result, { chats: { removed: 1, projects: 1 }, usage: { removed: 1, files: 1 } });
  assert.deepEqual(jsonLines(chatFile).map((m) => m.id), ['m2', 'm3'], 'no-ts message kept');
  assert.deepEqual(rt.chat.map((m) => m.id), ['m2', 'm3'], 'the in-memory chat was synced');
  assert.deepEqual(events, [{ type: 'chat_prune', data: { project: 'lama', ids: ['m1'] } }], 'open pages drop exactly the pruned messages');

  const usageLines = lines(usageFile);
  assert.equal(usageLines.length, 3);
  assert.equal(usageLines.includes('bukan-json'), true, 'a torn line is never deleted');
  assert.equal(parsedLines(usageFile).some((r) => r.ts === undefined), true, 'a row without ts stays');
  const backups = readdirSync(dataDir).filter((name) => /^usage\.jsonl\.bak-retention-\d{8}$/.test(name));
  assert.equal(backups.length, 1, 'one backup per day');
});

test('retention: a setting of 0 deletes nothing', () => {
  const now = Date.now();
  const old = now - 400 * DAY;
  const dir = tmp();
  const dataDir = path.join(dir, 'data');
  const chats = path.join(dataDir, 'chats');
  mkdirSync(chats, { recursive: true });
  const chatFile = path.join(chats, 'tetap.jsonl');
  writeFileSync(chatFile, `${JSON.stringify({ id: 'm1', ts: old, project: 'tetap', kind: 'assistant', text: 'sangat lama' })}\n`);
  const usageFile = path.join(dataDir, 'usage.jsonl');
  mkdirSync(path.dirname(usageFile), { recursive: true });
  writeFileSync(usageFile, `${JSON.stringify(usageRow(old))}\n`);

  const hub = new Hub({ dataDir });
  hub.persisted.retention = { chatsDays: 0, usageDays: 0 };
  const ledger = ledgerAt(usageFile);

  assert.deepEqual(retentionPreview(hub, ledger, now), {
    chats: { messages: 0, projects: 0 },
    usage: { rows: 0, files: 0 },
    cutoff: { chats: 0, usage: 0 },
  });
  assert.deepEqual(applyRetention(hub, ledger, now), { chats: { removed: 0, projects: 0 }, usage: { removed: 0, files: 0 } });
  assert.equal(lines(chatFile).length, 1);
  assert.equal(lines(usageFile).length, 1);
  assert.equal(readdirSync(dataDir).some((name) => name.includes('.bak-retention-')), false, 'no backup is made when nothing is removed');
});

test('retention: a message appended just before the run (still pending) is flushed, kept, and never lost', () => {
  const now = Date.now();
  const old = now - 40 * DAY;
  const dir = tmp();
  const dataDir = path.join(dir, 'data');
  const chats = path.join(dataDir, 'chats');
  mkdirSync(chats, { recursive: true });
  const chatFile = path.join(chats, 'terbuka.jsonl');
  writeFileSync(chatFile, `${JSON.stringify({ id: 'm1', ts: old, project: 'terbuka', kind: 'assistant', text: 'lama' })}\n`);

  const hub = new Hub({ dataDir });
  // The project is open with a brand-new message that has not been written yet (the 800 ms save timer is pending).
  const freshId = hub.chat('terbuka', { kind: 'user', text: 'pesan baru belum ter-flush' });
  const rt = hub.rt('terbuka');

  const preview = retentionPreview(hub, ledgerAt(path.join(dataDir, 'usage.jsonl')), now, { chatsDays: 30, usageDays: 0 });
  assert.deepEqual(preview.chats, { messages: 1, projects: 1 }, 'the old message counts; the new one does not');

  assert.deepEqual(applyRetention(hub, ledgerAt(path.join(dataDir, 'usage.jsonl')), now, { chatsDays: 30, usageDays: 0 }).chats, { removed: 1, projects: 1 });
  assert.deepEqual(jsonLines(chatFile).map((m) => m.id), [freshId], 'pending append was flushed and the new message survived');
  assert.deepEqual(rt.chat.map((m) => m.id), [freshId], 'the open chat in memory is synced');
});

test('retention: an unreadable chat file is skipped, while another project is still pruned', () => {
  const now = Date.now();
  const old = now - 40 * DAY;
  const dir = tmp();
  const dataDir = path.join(dir, 'data');
  const chats = path.join(dataDir, 'chats');
  mkdirSync(chats, { recursive: true });
  const good = path.join(chats, 'baik.jsonl');
  writeFileSync(good, [JSON.stringify({ id: 'g1', ts: old, project: 'baik', kind: 'assistant', text: 'lama' }), JSON.stringify({ id: 'g2', ts: now, project: 'baik', kind: 'assistant', text: 'baru' })].join('\n') + '\n');
  // A directory named like a chat file: opening it as a file fails (EISDIR), so it must be left untouched.
  const broken = path.join(chats, 'rusak.jsonl');
  mkdirSync(broken, { recursive: true });
  writeFileSync(path.join(broken, 'isi.txt'), 'jangan disentuh');

  const hub = new Hub({ dataDir });
  const result = applyRetention(hub, ledgerAt(path.join(dataDir, 'usage.jsonl')), now, { chatsDays: 30, usageDays: 0 });
  assert.deepEqual(result.chats, { removed: 1, projects: 1 }, 'only the readable project lost a message');
  assert.deepEqual(jsonLines(good).map((m) => m.id), ['g2']);
  assert.equal(readFileSync(path.join(broken, 'isi.txt'), 'utf8'), 'jangan disentuh', 'the unreadable entry was never rewritten');
});

test('retention: ledger archives are pruned too, with one backup per file; no-ts and torn rows survive', () => {
  const now = Date.now();
  const old = now - 40 * DAY;
  const dir = tmp();
  const dataDir = path.join(dir, 'data');
  const usageFile = path.join(dataDir, 'usage.jsonl');
  const archiveDir = path.join(dataDir, 'usage-archive');
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(usageFile, [JSON.stringify(usageRow(old)), JSON.stringify(usageRow(now))].join('\n') + '\n');
  const archive = path.join(archiveDir, 'usage-20200101T000000.jsonl');
  writeFileSync(archive, [JSON.stringify(usageRow(old)), JSON.stringify(usageRow(now)), JSON.stringify({ account: { id: 'akun-a' } }), 'bukan-json'].join('\n') + '\n');
  // Safety copies prune themselves too: an old one goes, today's stays.
  const oldBackup = path.join(dataDir, 'usage.jsonl.bak-retention-20200101');
  const todayStamp = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  const recentBackup = path.join(dataDir, `usage.jsonl.bak-retention-${todayStamp}`);
  writeFileSync(oldBackup, 'lama\n');
  writeFileSync(recentBackup, 'baru\n');

  const hub = new Hub({ dataDir });
  const ledger = ledgerAt(usageFile);
  assert.deepEqual(retentionPreview(hub, ledger, now, { chatsDays: 0, usageDays: 30 }).usage, { rows: 2, files: 2 });
  assert.deepEqual(applyRetention(hub, ledger, now, { chatsDays: 0, usageDays: 30 }).usage, { removed: 2, files: 2 });

  assert.equal(parsedLines(usageFile).some((r) => r.ts === old), false, 'active file pruned');
  assert.equal(parsedLines(archive).some((r) => r.ts === old), false, 'archive pruned');
  assert.equal(lines(archive).includes('bukan-json'), true, 'torn archive line kept');
  assert.equal(parsedLines(archive).some((r) => r.ts === undefined), true, 'archive row without ts kept');
  assert.equal(lines(usageFile).length, 1, 'the recent row stays');
  assert.equal(readdirSync(dataDir).filter((name) => /^usage\.jsonl\.bak-retention-\d{8}$/.test(name)).length, 1);
  assert.equal(readdirSync(archiveDir).filter((name) => /\.bak-retention-\d{8}$/.test(name)).length, 1, 'each rewritten file has its own backup');
  assert.equal(existsSync(oldBackup), false, 'a safety copy older than 30 days is removed');
  assert.equal(existsSync(recentBackup), true, "today's safety copy stays");
});

test('retention: both engines’ chat files are pruned (data/chats and data/chats-opencode)', () => {
  const now = Date.now();
  const old = now - 40 * DAY;
  const dir = tmp();
  const dataDir = path.join(dir, 'data');
  const claudeChats = path.join(dataDir, 'chats');
  const opencodeChats = path.join(dataDir, 'chats-opencode');
  mkdirSync(claudeChats, { recursive: true });
  mkdirSync(opencodeChats, { recursive: true });
  const claudeFile = path.join(claudeChats, 'c1.jsonl');
  const opencodeFile = path.join(opencodeChats, 'o1.jsonl');
  writeFileSync(claudeFile, [JSON.stringify({ id: 'c-old', ts: old, project: 'c1', kind: 'assistant', text: 'lama' }), JSON.stringify({ id: 'c-new', ts: now, project: 'c1', kind: 'assistant', text: 'baru' })].join('\n') + '\n');
  writeFileSync(opencodeFile, [JSON.stringify({ id: 'o-old', ts: old, project: 'o1', kind: 'assistant', text: 'lama' }), JSON.stringify({ id: 'o-new', ts: now, project: 'o1', kind: 'assistant', text: 'baru' }), JSON.stringify({ id: 'o-no-ts', project: 'o1', kind: 'info', text: 'tanpa waktu' })].join('\n') + '\n');

  const hub = new Hub({ dataDir });
  const result = applyRetention(hub, ledgerAt(path.join(dataDir, 'usage.jsonl')), now, { chatsDays: 30, usageDays: 0 });
  assert.deepEqual(result.chats, { removed: 2, projects: 2 });
  assert.deepEqual(jsonLines(claudeFile).map((m) => m.id), ['c-new']);
  assert.deepEqual(jsonLines(opencodeFile).map((m) => m.id), ['o-new', 'o-no-ts']);
});

test('retention/config: malformed values in state.json fall back to the safe defaults (3 and keep-forever)', async () => {
  const { maxConcurrentOf } = await import('../src/concurrency.js');
  const dir = tmp();
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'state.json'),
    JSON.stringify({ maxConcurrent: '9', retention: { chatsDays: -1, usageDays: '30' }, settings: {}, engineSettings: {} }),
  );
  const hub = new Hub({ dataDir });
  assert.equal(maxConcurrentOf(hub), 3, 'a broken limit is never "unlimited"');
  assert.deepEqual(retentionOf(hub), { chatsDays: 0, usageDays: 0 }, 'a broken retention means keep forever');
});
