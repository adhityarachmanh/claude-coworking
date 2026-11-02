// Chat history in data/chats/<projectId>.jsonl (src/chat-store.js, notes in src/hub.js): appends and patch
// records, compaction, a torn last line, the one-time move out of state.json (idempotent, crash-safe), forget,
// and backups carrying the chats both ways (files in office/chats/, or inside an older backup's state.json).
import assert from 'node:assert/strict';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { restoreBackup, writeBackup } from '../src/backup.js';
import { ChatStore, isChatId, replayChat } from '../src/chat-store.js';
import { Hub } from '../src/hub.js';
import { ZipError, ZipWriter } from '../src/zip.js';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-chats-'));
  dirs.push(dir);
  return dir;
};
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
const chatFile = (dir, id) => path.join(dir, 'chats', `${id}.jsonl`);
const readState = (dir) => JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
const baks = (dir) => readdirSync(dir).filter((n) => n.startsWith('state.json.bak-chats'));
/** Runs fn with console.error captured. */
function quiet(fn) {
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return errors;
}
const msg = (n, extra = {}) => ({ id: `m${n}`, ts: 1_700_000_000_000 + n, project: 'p1', kind: 'assistant', text: `pesan ${n}`, ...extra });

test('store: appends, merged patches with _unset, replay gives the chat back', () => {
  const dir = tmp();
  const store = new ChatStore(dir, { limit: 10 });
  const chat = [msg(1), msg(2, { streaming: true })];
  for (const m of chat) store.append('p1', m);
  store.flush(() => chat);
  assert.equal(lines(path.join(dir, 'p1.jsonl')).length, 2);

  // A message still pending carries its own changes; a written one gets one merged patch per flush.
  chat.push(msg(3));
  store.append('p1', chat[2]);
  store.patch('p1', 'm3', { text: 'diabaikan, ikut append' });
  chat[2].text = 'baru';
  Object.assign(chat[1], { text: 'a' });
  store.patch('p1', 'm2', { text: 'a' });
  Object.assign(chat[1], { text: 'ab', streaming: undefined });
  store.patch('p1', 'm2', { text: 'ab', streaming: undefined });
  store.flush(() => chat);
  const recs = lines(path.join(dir, 'p1.jsonl')).map((l) => JSON.parse(l));
  assert.equal(recs.length, 4, 'one line for the new message, one patch for m2');
  assert.deepEqual(recs[3], { _patch: 'm2', text: 'ab', _unset: ['streaming'] });
  const back = new ChatStore(dir, { limit: 10 }).load('p1');
  assert.deepEqual(back, JSON.parse(JSON.stringify(chat)));
  assert.equal(back[1].streaming, undefined);
  assert.equal(back[2].text, 'baru');
});

test('store: compacts past compactAt records, keeps only the newest `limit` messages', () => {
  const dir = tmp();
  const store = new ChatStore(dir, { limit: 5, compactAt: 10 });
  const chat = [];
  for (let n = 1; n <= 23; n++) {
    chat.push(msg(n));
    if (chat.length > 5) chat.shift();
    store.append('p1', chat.at(-1));
    store.patch('p1', chat[0].id, { seen: n }); // patch traffic counts too
    store.flush(() => chat);
    assert.ok(lines(path.join(dir, 'p1.jsonl')).length <= 10, 'never more than compactAt records');
  }
  const back = new ChatStore(dir, { limit: 5 }).load('p1');
  assert.deepEqual(back.map((m) => m.id), ['m19', 'm20', 'm21', 'm22', 'm23']);
  assert.ok(!existsSync(path.join(dir, 'p1.jsonl.tmp')), 'no temp file left');
});

test('store: a torn last line (crash mid-append) is skipped, and the file is rewritten before the next append', () => {
  const dir = tmp();
  const file = path.join(dir, 'p1.jsonl');
  writeFileSync(file, `${JSON.stringify(msg(1))}\n${JSON.stringify(msg(2))}\n{"_patch":"m2","text":"setengah`);
  const store = new ChatStore(dir);
  const chat = store.load('p1');
  assert.deepEqual(chat.map((m) => m.text), ['pesan 1', 'pesan 2'], 'torn patch ignored, history intact');
  chat.push(msg(3));
  store.append('p1', chat[2]);
  store.flush(() => chat);
  const recs = lines(file);
  assert.equal(recs.length, 3);
  for (const l of recs) JSON.parse(l); // every line parses: nothing glued onto the torn one
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
  assert.deepEqual(replayChat(readFileSync(file, 'utf8')).messages.map((m) => m.id), ['m1', 'm2', 'm3']);
});

test('hub: messages and updates go to data/chats, state.json holds no chats, ids continue after a restart', () => {
  const dir = tmp();
  const hub = new Hub({ dataDir: dir });
  const a = hub.chat('p1', { kind: 'assistant', text: '', streaming: true });
  hub.chat('p2', { kind: 'user', text: 'halo p2' });
  hub.save();
  for (const t of ['h', 'ha', 'hal', 'halo']) hub.updateChat('p1', a, { text: t, streaming: true });
  hub.updateChat('p1', a, { streaming: false });
  hub.save();
  assert.equal(readState(dir).chats, undefined);
  assert.equal(lines(chatFile(dir, 'p1')).length, 2, 'the streamed updates of one flush are one patch line');
  hub.save(); // nothing changed: nothing appended
  assert.equal(lines(chatFile(dir, 'p1')).length, 2);

  const again = new Hub({ dataDir: dir });
  assert.deepEqual(again.snapshot().chats, {}, 'projects that are not listed are not shown');
  assert.equal(again.rt('p1').chat[0].text, 'halo');
  assert.equal(again.rt('p1').chat[0].streaming, false);
  assert.equal(again.rt('p2').chat[0].text, 'halo p2');
  const next = again.chat('p1', { kind: 'user', text: 'lagi' });
  assert.ok(Number(next.slice(1)) > Number(a.slice(1)), 'ids continue after the stored ones');
});

test('hub: a long chat stays bounded on disk and loads its last 250 messages', () => {
  const dir = tmp();
  const hub = new Hub({ dataDir: dir });
  for (let i = 0; i < 700; i++) {
    hub.chat('p1', { kind: 'assistant', text: `#${i}` });
    if (i % 37 === 0) hub.save();
  }
  hub.save();
  assert.ok(lines(chatFile(dir, 'p1')).length <= 500, 'compacted at 2 × CHAT_LIMIT');
  const chat = new Hub({ dataDir: dir }).rt('p1').chat;
  assert.equal(chat.length, 250);
  assert.equal(chat.at(-1).text, '#699');
  assert.equal(chat[0].text, '#450');
});

test('migration: chats move out of state.json once (safety copy kept 7 days), ids and labels kept', () => {
  const dir = tmp();
  const shell = { id: 'm5', ts: 1_700_000_000_005, project: 'p1', kind: 'tool', tool: 'Bash', input: { command: 'ls', description: 'Daftar file' }, text: '$ ls' };
  const legacy = { p1: [msg(1), msg(2), shell], p2: [msg(9, { project: 'p2' })], demo: [msg(4)] };
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ favorites: ['p1'], chats: legacy }));

  const hub = new Hub({ dataDir: dir });
  const state = readState(dir);
  assert.equal(state.chats, undefined, 'chats dropped from state.json');
  assert.deepEqual(state.favorites, ['p1'], 'the rest of the state kept');
  assert.equal(baks(dir).length, 1, 'safety copy');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, baks(dir)[0]), 'utf8')).chats.p1.length, 3);
  assert.deepEqual(replayChat(readFileSync(chatFile(dir, 'p1'), 'utf8')).messages.map((m) => m.id), ['m1', 'm2', 'm5']);
  assert.ok(!existsSync(chatFile(dir, 'demo')), 'the demo chat is never stored');
  assert.notEqual(hub.rt('p1').chat[2].text, '$ ls', 'old shell rows relabelled');
  assert.equal(hub.chat('p1', { kind: 'user', text: 'x' }), 'm10', 'ids continue across all files');
  hub.save();
  const relabelled = hub.rt('p1').chat[2].text;

  const second = new Hub({ dataDir: dir });
  assert.equal(baks(dir).length, 1, 'safety copy still there at the next start');
  assert.deepEqual(second.rt('p1').chat.map((m) => m.id), ['m1', 'm2', 'm5', 'm10']);
  assert.equal(second.rt('p1').chat[2].text, relabelled, 'the relabel was written to the file');
  assert.equal(second.rt('p2').chat[0].text, 'pesan 9');
});

test('migration: a crash between the JSONL and state.json steps (or an older app run in between) loses nothing', () => {
  const dir = tmp();
  // The JSONL of an earlier (interrupted) migration, plus one message added later by this app...
  mkdirSync(path.join(dir, 'chats'));
  writeFileSync(chatFile(dir, 'p1'), `${[msg(1), msg(2), msg(3, { text: 'versi file' })].map((m) => JSON.stringify(m)).join('\n')}\n`);
  // ...and a state.json that still (or again) has chats, with one message the file does not have.
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ chats: { p1: [msg(1), msg(2), msg(3, { text: 'versi lama' }), msg(4)] } }));
  const hub = new Hub({ dataDir: dir });
  const chat = hub.rt('p1').chat;
  assert.deepEqual(chat.map((m) => m.id), ['m1', 'm2', 'm3', 'm4'], 'union by id, no duplicates, in id order');
  assert.equal(chat[2].text, 'versi file', 'the file (newer) wins for the same id');
  assert.equal(readState(dir).chats, undefined);
  // Idempotent: starting again over the same files changes nothing.
  const before = readFileSync(chatFile(dir, 'p1'), 'utf8');
  new Hub({ dataDir: dir }).save();
  assert.equal(readFileSync(chatFile(dir, 'p1'), 'utf8'), before);
});

test('migration: when the chat files cannot be written, state.json keeps the chats (retried next start)', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'chats'), 'bukan folder'); // data/chats can't be created
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ chats: { p1: [msg(1)] } }));
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    const hub = new Hub({ dataDir: dir });
    hub.save();
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((e) => /Memindahkan riwayat chat/.test(e)));
  assert.deepEqual(readState(dir).chats, { p1: [msg(1)] }, 'nothing lost');
  rmSync(path.join(dir, 'chats'));
  const ok = new Hub({ dataDir: dir });
  assert.equal(readState(dir).chats, undefined);
  assert.equal(ok.rt('p1').chat[0].text, 'pesan 1');
});

test('forgetting a project removes its chat file', () => {
  const dir = tmp();
  const folder = path.join(dir, 'proj');
  mkdirSync(folder);
  const hub = new Hub({ dataDir: dir });
  const { id } = hub.addCustomProject(folder);
  hub.chat(id, { kind: 'user', text: 'halo' });
  hub.save();
  assert.ok(existsSync(chatFile(dir, id)));
  assert.equal(hub.forgetProject(id), true);
  assert.ok(!existsSync(chatFile(dir, id)));
  assert.equal(new Hub({ dataDir: dir }).rt(id).chat.length, 0);
});

// ---------- backups ----------

async function exportFrom(hub, dir) {
  const file = path.join(dir, `backup-${Math.random().toString(36).slice(2)}.zip`);
  const out = createWriteStream(file);
  const empty = path.join(dir, 'no-claude');
  hub.save();
  await writeBackup(out, { state: hub.exportState(), chatsDir: hub.chatStore.dir, homeDir: dir, locations: { projectsDir: path.join(empty, 'projects'), claudeDir: empty } });
  await new Promise((r) => out.end(r));
  return file;
}

async function craft(dir, entries) {
  const file = path.join(dir, `crafted-${Math.random().toString(36).slice(2)}.zip`);
  const out = createWriteStream(file);
  const zip = new ZipWriter(out);
  await zip.add('manifest.json', Buffer.from(JSON.stringify({ format: 'adhit-office-backup', version: 1, homeDir: dir, platform: process.platform, projects: [] })));
  for (const [name, data] of entries) await zip.add(name, Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)));
  await zip.finish();
  await new Promise((r) => out.end(r));
  return file;
}

const restoreInto = (dir, file) => {
  const root = path.join(dir, 'restore-claude');
  return restoreBackup(file, { locations: { projectsDir: path.join(root, 'projects'), claudeDir: root }, homeDir: dir });
};

test('backup round trip: chats travel as office/chats/*.jsonl and merge by message (idempotent)', async () => {
  const dirA = tmp();
  const a = new Hub({ dataDir: dirA });
  a.chat('p1', { kind: 'user', text: 'dari A', uuid: 'u-1', sessionId: 's-1' });
  const pending = a.chat('p1', { kind: 'approval', text: 'Izinkan?', approvalId: 'x', status: 'pending' });
  a.chat('p1', { kind: 'assistant', text: 'masih jalan', streaming: true });
  a.updateChat('p1', pending, { text: 'Izinkan? (diperbarui)' });
  const file = await exportFrom(a, dirA);
  assert.equal(readState(dirA).chats, undefined);

  const restored = await restoreInto(dirA, file);
  assert.equal(restored.state.chats, undefined, 'the state.json in the backup has no chats any more');
  assert.equal(restored.chats.p1.length, 3);

  const dirB = tmp();
  const b = new Hub({ dataDir: dirB });
  const own = b.chat('q1', { kind: 'user', text: 'punya B' });
  const idMap = new Map([['p1', 'q1']]);
  assert.equal(b.mergeProjectData(restored.state, idMap, restored.chats).chats, 3);
  const chat = b.rt('q1').chat;
  assert.equal(chat.length, 4);
  assert.ok(chat.some((m) => m.id === own && m.text === 'punya B'), 'local history kept');
  const fromA = chat.filter((m) => m.origId);
  assert.deepEqual(fromA.map((m) => m.text), ['dari A', 'Izinkan? (diperbarui)', 'masih jalan']);
  assert.ok(fromA.every((m) => m.project === 'q1' && Number(m.id.slice(1)) > Number(own.slice(1))), 'new ids on this machine');
  assert.equal(fromA[1].status, 'cancelled', 'a pending approval comes back inert');
  assert.equal(fromA[2].streaming, undefined);
  assert.ok(fromA.every((m) => m.imported === true && !('uuid' in m) && !('sessionId' in m) && !('taskId' in m)), 'marked imported, no links into A\'s sessions');
  assert.equal(new Set(chat.map((m) => m.id)).size, 4);

  // Importing the same backup again adds nothing; the merge is on disk after a save.
  assert.equal(b.mergeProjectData(restored.state, idMap, restored.chats).chats, 0);
  b.save();
  assert.equal(new Hub({ dataDir: dirB }).rt('q1').chat.length, 4);
  // A backup of B taken back to A: A's own messages are recognised by their original id + time.
  const back = await restoreInto(dirB, await exportFrom(b, dirB));
  assert.equal(a.mergeProjectData(back.state, new Map([['q1', 'p1']]), back.chats).chats, 1, 'only "punya B" is new to A');
});

test('backup from before data/chats (chats inside state.json) still imports', async () => {
  const dir = tmp();
  const file = await craft(dir, [['office/state.json', { favorites: [], chats: { old1: [msg(1, { project: 'old1' }), msg(2, { project: 'old1' }), { junk: true }] } }]]);
  const restored = await restoreInto(dir, file);
  assert.deepEqual(restored.chats, {});
  const hub = new Hub({ dataDir: dir });
  assert.equal(hub.mergeProjectData(restored.state, new Map([['old1', 'p9']]), restored.chats).chats, 2, 'malformed entries skipped');
  assert.deepEqual(hub.rt('p9').chat.map((m) => m.text), ['pesan 1', 'pesan 2']);
  assert.equal(hub.mergeProjectData(restored.state, new Map(), restored.chats).chats, 0, 'unknown projects dropped');
  hub.save();
  assert.equal(readState(dir).chats, undefined);
  assert.equal(lines(chatFile(dir, 'p9')).length, 2);
});

test('backup: chat entries outside office/chats/<id>.jsonl are refused before anything is written', async () => {
  const dir = tmp();
  for (const name of ['office/chats/sub/x.jsonl', 'office/chats/a.b.jsonl', 'office/chats/x.json', 'office/chats/../../evil.jsonl']) {
    await assert.rejects(restoreInto(dir, await craft(dir, [[name, `${JSON.stringify(msg(1))}\n`]])), ZipError, name);
  }
  // A torn last line inside a backup's chat file is skipped like on disk.
  const ok = await restoreInto(dir, await craft(dir, [['office/chats/p1.jsonl', `${JSON.stringify(msg(1))}\n{"id":"m2","te`]]));
  assert.deepEqual(ok.chats.p1.map((m) => m.id), ['m1']);
});

// ---------- review fixes: repeated ids, safety copies, failures ----------

const old = (n, text, ts) => ({ id: `m${n}`, ts, project: 'p1', kind: 'assistant', text });

test('migration: the same id twice in one project (ids restarted at 0 in old versions) loses nothing, keeps the order', () => {
  const dir = tmp();
  const legacy = [old(1, 'old-1', 100), old(2, 'old-2', 200), old(3, 'old-3', 300), old(1, 'new-1', 400), old(2, 'new-2', 500)];
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ chats: { p1: legacy } }));
  const hub = new Hub({ dataDir: dir });
  const chat = hub.rt('p1').chat;
  assert.deepEqual(chat.map((m) => m.text), ['old-1', 'old-2', 'old-3', 'new-1', 'new-2']);
  assert.equal(new Set(chat.map((m) => m.id)).size, 5, 'ids unique');
  assert.deepEqual(chat.slice(3).map((m) => [m.id, m.origId]), [['m4', 'm1'], ['m5', 'm2']], 'repeats renumbered, old id kept');
  assert.equal(hub.chat('p1', { kind: 'user', text: 'x' }), 'm6');
  hub.save();
  const file = readFileSync(chatFile(dir, 'p1'), 'utf8');

  // A crash before state.json was rewritten: the same migration runs again over the file it wrote.
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ chats: { p1: legacy } }));
  const again = new Hub({ dataDir: dir });
  assert.deepEqual(again.rt('p1').chat.map((m) => `${m.id}:${m.text}`), ['m1:old-1', 'm2:old-2', 'm3:old-3', 'm4:new-1', 'm5:new-2', 'm6:x']);
  again.save();
  assert.equal(readFileSync(chatFile(dir, 'p1'), 'utf8'), file, 'idempotent');
});

test('migration: ids of an older app run after the move collide with the file: both messages kept, by time', () => {
  const dir = tmp();
  mkdirSync(path.join(dir, 'chats'));
  writeFileSync(chatFile(dir, 'p1'), `${[old(1, 'baru-1', 100), old(2, 'baru-2', 200), old(3, 'baru-3', 300)].map((m) => JSON.stringify(m)).join('\n')}\n`);
  // the older app found no chats in state.json, started its ids at 1 again and wrote them back into state.json
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ chats: { p1: [old(1, 'lama-1', 400), old(2, 'lama-2', 500)] } }));
  const chat = new Hub({ dataDir: dir }).rt('p1').chat;
  assert.deepEqual(chat.map((m) => m.text), ['baru-1', 'baru-2', 'baru-3', 'lama-1', 'lama-2']);
  assert.equal(new Set(chat.map((m) => m.id)).size, 5);
});

test('migration: over the limit with repeated ids keeps the newest 250 by time, not by id', () => {
  const dir = tmp();
  const legacy = [];
  for (let run = 0; run < 2; run++) for (let i = 1; i <= 150; i++) legacy.push(old(i, `run${run}-${i}`, run * 1000 + i));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ chats: { p1: legacy } }));
  const chat = new Hub({ dataDir: dir }).rt('p1').chat;
  assert.equal(chat.length, 250);
  assert.equal(chat[0].text, 'run0-51');
  assert.equal(chat.at(-1).text, 'run1-150');
  assert.equal(new Set(chat.map((m) => m.id)).size, 250);
});

test('safety copy: kept for 7 days, never removed while state.json does not parse', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ chats: { p1: [msg(1)] } }));
  new Hub({ dataDir: dir });
  const [bak] = baks(dir);
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
  utimesSync(path.join(dir, bak), eightDaysAgo, eightDaysAgo);
  const good = readFileSync(path.join(dir, 'state.json'));
  writeFileSync(path.join(dir, 'state.json'), '{kaput');
  new Hub({ dataDir: dir });
  assert.deepEqual(baks(dir), [bak], 'state.json broken: the copy stays');
  writeFileSync(path.join(dir, 'state.json'), good);
  new Hub({ dataDir: dir });
  assert.deepEqual(baks(dir), [], 'older than 7 days and state.json fine: removed');
});

test('failed migration: history shown, new ids after the stored ones, chats kept in state.json (old format) this run', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'chats'), 'bukan folder');
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ chats: { p1: [old(7, 'a', 1), old(7, 'b', 2)], 'bukan id!': [msg(1)] } }));
  let hub;
  quiet(() => (hub = new Hub({ dataDir: dir })));
  assert.deepEqual(hub.rt('p1').chat.map((m) => m.text), ['a', 'b'], 'shown in the UI');
  const id = hub.chat('p1', { kind: 'user', text: 'baru' });
  assert.equal(id, 'm9', 'after the renumbered repeat (m8)');
  quiet(() => hub.save());
  const saved = readState(dir).chats;
  assert.deepEqual(saved.p1.map((m) => m.text), ['a', 'b', 'baru'], 'new messages kept in state.json');
  assert.equal(saved['bukan id!'].length, 1, 'entries it could not use are kept as they were');
});

test('store: a file that cannot be read is never rewritten, only appended to, and read again later', () => {
  const dir = tmp();
  mkdirSync(path.join(dir, 'p1.jsonl')); // reading fails (EISDIR/EPERM), not ENOENT
  const store = new ChatStore(dir);
  const errors = quiet(() => assert.deepEqual(store.load('p1'), []));
  assert.ok(errors.some((e) => /tidak bisa dibaca/.test(e)));
  assert.ok(store.unreadable.has('p1'));
  store.rewrite('p1');
  assert.equal(store.rewrites.size, 0, 'no rewrite of an unreadable file');
  assert.throws(() => store.writeAll('p1', [msg(1)]), /tidak terbaca/);
  assert.equal(store.reload('p1'), null, 'still unreadable');
  rmSync(path.join(dir, 'p1.jsonl'), { recursive: true });
  writeFileSync(path.join(dir, 'p1.jsonl'), `${JSON.stringify(msg(1))}\n`);
  assert.deepEqual(store.reload('p1').map((m) => m.id), ['m1']);
  assert.ok(!store.unreadable.has('p1'));
});

test('hub: ids continue after chatSeq, so a chat file unreadable at start never gets its ids again', () => {
  const dir = tmp();
  const hub = new Hub({ dataDir: dir });
  hub.chat('p1', { kind: 'user', text: 'satu' });
  hub.chat('p1', { kind: 'user', text: 'dua' });
  hub.save();
  const content = readFileSync(chatFile(dir, 'p1'));
  rmSync(chatFile(dir, 'p1'));
  mkdirSync(chatFile(dir, 'p1')); // unreadable at the next start
  let next;
  quiet(() => (next = new Hub({ dataDir: dir })));
  assert.equal(next.chat('p1', { kind: 'user', text: 'tiga' }), 'm3');
  rmSync(chatFile(dir, 'p1'), { recursive: true });
  writeFileSync(chatFile(dir, 'p1'), content); // readable again
  quiet(() => next.save());
  assert.deepEqual(next.rt('p1').chat.map((m) => m.text), ['satu', 'dua', 'tiga'], 'history back, the new message appended');
});

test('store: after a failed append the file is rewritten whole at the next flush', () => {
  const dir = tmp();
  const store = new ChatStore(dir);
  const chat = [msg(1)];
  store.append('p1', chat[0]);
  store.flush(() => chat);
  rmSync(path.join(dir, 'p1.jsonl'));
  mkdirSync(path.join(dir, 'p1.jsonl')); // the append fails
  chat.push(msg(2));
  store.append('p1', chat[1]);
  assert.throws(() => store.flush(() => chat));
  assert.ok(store.rewrites.has('p1') && store.pending.has('p1'), 'kept, marked for a rewrite');
  rmSync(path.join(dir, 'p1.jsonl'), { recursive: true });
  store.flush(() => chat);
  assert.deepEqual(lines(path.join(dir, 'p1.jsonl')).map((l) => JSON.parse(l).id), ['m1', 'm2']);
});

test('chat file ids: Windows device names refused, also in a backup; chat files bounded together on import', async () => {
  for (const bad of ['con', 'NUL', 'aux', 'prn', 'com1', 'LPT9', 'a.b', '', 'x'.repeat(65)]) assert.equal(isChatId(bad), false, bad);
  for (const good of ['p1', '0123456789', 'demo-x', 'console']) assert.equal(isChatId(good), true, good);
  const dir = tmp();
  await assert.rejects(restoreInto(dir, await craft(dir, [['office/chats/nul.jsonl', `${JSON.stringify(msg(1))}\n`]])), ZipError);
  const body = `${JSON.stringify(msg(1, { text: 'x'.repeat(300) }))}\n`;
  const file = await craft(dir, [['office/chats/p1.jsonl', body], ['office/chats/p2.jsonl', body]]);
  const root = path.join(dir, 'restore-claude');
  const res = await restoreBackup(file, { locations: { projectsDir: path.join(root, 'projects'), claudeDir: root }, homeDir: dir, maxMergeBytes: body.length + 10 });
  assert.deepEqual(Object.keys(res.chats), ['p1']);
  assert.ok(res.summary.warnings.some((w) => /terlalu besar secara total/.test(w) && w.includes('p2')));
});

test('a resumed session (divider, then history rows with older times) keeps its order in the migration and an import', async () => {
  const resumed = [
    { id: 'm1', ts: 900, project: 'p1', kind: 'user', text: 'sebelum' },
    { id: 'm2', ts: 1000, project: 'p1', kind: 'divider', text: 'Melanjutkan sesi abc' },
    { id: 'm3', ts: 100, project: 'p1', kind: 'user', text: 'riwayat-1', history: true },
    { id: 'm4', ts: 200, project: 'p1', kind: 'assistant', text: 'riwayat-2', history: true },
    { id: 'm5', ts: 1100, project: 'p1', kind: 'user', text: 'sesudah' },
  ];
  const order = ['sebelum', 'Melanjutkan sesi abc', 'riwayat-1', 'riwayat-2', 'sesudah'];
  const dir = tmp();
  mkdirSync(path.join(dir, 'chats'));
  // plus one message only in the file (an older app ran after the move): placed by its time, nothing re-sorted
  writeFileSync(chatFile(dir, 'p1'), `${JSON.stringify({ id: 'm1', ts: 1200, project: 'p1', kind: 'user', text: 'hanya di file' })}\n`);
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ chats: { p1: resumed } }));
  const hub = new Hub({ dataDir: dir });
  assert.deepEqual(hub.rt('p1').chat.map((m) => m.text), [...order, 'hanya di file']);

  // Import into a chat that already has rows of its own: the backup's order is kept, interleaved by time.
  const b = new Hub({ dataDir: tmp() });
  b.chat('q1', { kind: 'user', text: 'punya B' }); // now: newer than everything in the backup
  assert.equal(b.mergeProjectData({}, new Map([['p1', 'q1']]), { p1: resumed }).chats, 5);
  assert.deepEqual(b.rt('q1').chat.map((m) => m.text), [...order, 'punya B']);
});

test('a reply still "typing" when the server was killed is closed at the next start (never typing forever)', () => {
  const dir = tmp();
  const hub = new Hub({ dataDir: dir });
  const id = hub.chat('p1', { kind: 'assistant', text: 'setengah', streaming: true });
  hub.save(); // then a forced kill: the final { streaming: false } never reaches the disk
  const again = new Hub({ dataDir: dir });
  assert.equal(again.rt('p1').chat.find((m) => m.id === id).streaming, false);
  again.save();
  assert.equal(replayChat(readFileSync(chatFile(dir, 'p1'), 'utf8')).messages[0].streaming, false, 'written back');
});
