// Chat message ids must stay unique across server restarts: the browser finds a bubble by its id, so a new
// message that reuses a stored id gets its live updates painted onto the old bubble (and itself stays empty).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hub } from '../src/hub.js';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A data dir whose state.json holds the chats a previous server run left behind. */
function dataDirWith(chats) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-hub-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ chats }));
  return dir;
}

test('after a restart, new chat ids never reuse an id stored from the previous run', () => {
  const stored = Array.from({ length: 40 }, (_, i) => ({ id: `m${i + 1}`, ts: 1, project: 'p1', kind: 'assistant', text: `lama ${i + 1}` }));
  const hub = new Hub({ dataDir: dataDirWith({ p1: stored, p2: [{ id: 'm77', ts: 1, project: 'p2', kind: 'user', text: 'x' }] }) });
  hub.save = () => {}; // keep the fixture as written
  hub.scheduleSave = () => {};
  const taken = new Set(['m77', ...stored.map((m) => m.id)]);
  for (let i = 0; i < 50; i++) {
    hub.office('p1', { kind: 'think', role: 'claude' }); // office events share the counter
    const id = hub.chat('p1', { kind: 'assistant', text: '', streaming: true });
    assert.ok(!taken.has(id), `id ${id} sudah dipakai pesan lama`);
    taken.add(id);
  }
});

test('updateChat patches the new message, never an older one with a similar id', () => {
  const hub = new Hub({ dataDir: dataDirWith({ p1: [{ id: 'm1', ts: 1, project: 'p1', kind: 'assistant', text: 'jawaban lama' }] }) });
  hub.save = () => {};
  hub.scheduleSave = () => {};
  const frames = [];
  hub.clients.add({ write: (f) => frames.push(f) });
  const id = hub.chat('p1', { kind: 'assistant', text: '', streaming: true });
  hub.updateChat('p1', id, { text: 'jawaban baru', streaming: false });
  const chat = hub.rt('p1').chat;
  assert.equal(chat.find((m) => m.id === 'm1').text, 'jawaban lama');
  assert.equal(chat.at(-1).text, 'jawaban baru');
  assert.equal(new Set(chat.map((m) => m.id)).size, chat.length, 'id unik');
});
