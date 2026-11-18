// Cross-source continuation at the manager level (src/session.js): the switch path (a model of the other source
// picked) and the 🕘 Riwayat path (resuming while the other source has newer work) both attach ONE note, write it to
// disk, and report it in the chat. No model call, no git: only the stored chats are read.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionManager } from '../src/session.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'adhitron-handoff-mgr-'));

/** A chat row as the hub writes it (id + ts are all needsBridge/handoff look at). */
const row = (id, ts, text, extra = {}) => ({ id, ts, kind: 'assistant', text, ...extra });
const line = (...rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

/**
 * A manager over two real chat folders, with a fake hub that only offers what the handoff path touches. `session`
 * stands in for a ClaudeSession/AcpSession: it records the note it was given.
 */
function fixture({ claudeChat = [], opencodeChat = [], engine = 'opencode' } = {}) {
  const dir = tmp();
  const dataDir = path.join(dir, 'data');
  mkdirSync(path.join(dataDir, 'chats'), { recursive: true });
  mkdirSync(path.join(dataDir, 'chats-opencode'), { recursive: true });
  writeFileSync(path.join(dataDir, 'chats', 'proj.jsonl'), line(...claudeChat));
  writeFileSync(path.join(dataDir, 'chats-opencode', 'proj.jsonl'), line(...opencodeChat));
  const chats = [];
  const hub = {
    dataDir,
    save: () => {},
    engineOf: () => engine,
    chatDir: (eng) => path.join(dataDir, eng === 'claude' ? 'chats' : `chats-${eng}`),
    chat: (_id, msg) => chats.push(msg),
  };
  const manager = new SessionManager({ hub, claude: null, opencode: null, agents: {}, teamPrompt: '' });
  const session = {
    engine,
    pendingHandoff: '',
    setHandoffContext(text) {
      this.pendingHandoff = text;
    },
  };
  const briefFile = path.join(dataDir, 'handoff', 'proj.json');
  return { manager, session, chats, briefFile, dataDir, dir };
}

test('resume from 🕘 Riwayat carries the other source\'s newer work, saying where it came from', () => {
  const { manager, session, chats, briefFile, dir } = fixture({
    claudeChat: [row('c1', 1_000, 'kerja di src/session.js'), row('c2', 5_000, 'Berikutnya: perbarui docs/FITUR.md')],
    opencodeChat: [row('o1', 2_000, 'jawaban lama opencode')],
  });
  try {
    const ok = manager.bridgeFromOther({ id: 'proj' }, session, { reason: 'resume' });
    assert.equal(ok, true, 'a note is attached');
    assert.match(session.pendingHandoff, /Konteks dari Claude Code/);
    assert.match(session.pendingHandoff, /perbarui docs\/FITUR\.md/);
    assert.equal(chats.length, 1);
    assert.match(chats[0].text, /dari Riwayat/, 'the card names how it was triggered');
    assert.equal(chats[0].contextBridge.reason, 'resume');
    assert.deepEqual([chats[0].contextBridge.from, chats[0].contextBridge.to], ['claude', 'opencode']);
    // Written to disk and NOT consumed by attaching: only sending the prompt removes it.
    assert.equal(existsSync(briefFile), true, 'the brief is persisted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume with nothing newer on the other side attaches no note and writes no file', () => {
  const { manager, session, chats, briefFile, dir } = fixture({
    claudeChat: [row('c1', 1_000, 'kerja lama')],
    opencodeChat: [row('o1', 9_000, 'jawaban terbaru ada di sini')],
  });
  try {
    assert.equal(manager.bridgeFromOther({ id: 'proj' }, session, { reason: 'resume' }), false);
    assert.equal(session.pendingHandoff, '');
    assert.deepEqual(chats, []);
    assert.equal(existsSync(briefFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stored brief whose target is another source is not attached to this session', () => {
  const { manager, session, chats, briefFile, dir } = fixture();
  try {
    mkdirSync(path.dirname(briefFile), { recursive: true });
    writeFileSync(
      briefFile,
      JSON.stringify({ version: 1, from: 'opencode', to: 'claude', note: 'untuk claude saja', createdAt: 1, reason: 'switch', stats: { messages: 1, files: 0, commands: 0, todos: 0 }, brief: { files: [], commands: [], todos: [] } }),
    );
    // The session is on OpenCode, the brief was meant for Claude: nothing is attached, the file is left alone.
    assert.equal(manager.restoreStoredBrief({ id: 'proj' }, session), false);
    assert.equal(session.pendingHandoff, '');
    assert.deepEqual(chats, []);
    assert.equal(existsSync(briefFile), true, 'another source\'s brief is not eaten');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stored brief for this source is restored once, and stays on disk until it is sent', () => {
  const { manager, session, chats, briefFile, dir } = fixture();
  try {
    mkdirSync(path.dirname(briefFile), { recursive: true });
    writeFileSync(
      briefFile,
      JSON.stringify({ version: 1, from: 'claude', to: 'opencode', note: 'ringkasan yang belum terkirim', createdAt: 1, reason: 'switch', stats: { messages: 3, files: 1, commands: 0, todos: 0 }, brief: { files: ['a.js'], commands: [], todos: [] } }),
    );
    assert.equal(manager.restoreStoredBrief({ id: 'proj' }, session), true);
    assert.equal(session.pendingHandoff, 'ringkasan yang belum terkirim');
    assert.match(chats[0].text, /dipulihkan/);
    assert.equal(chats[0].contextBridge.restored, true);
    assert.equal(chats[0].contextBridge.note, undefined, 'the card never carries the whole note');
    assert.deepEqual(chats[0].contextBridge.brief.files, ['a.js']);
    assert.equal(existsSync(briefFile), true, 'attach does not consume: a second restart still carries it');

    // A session that already holds a note never gets a second one.
    assert.equal(manager.restoreStoredBrief({ id: 'proj' }, session), false);
    assert.equal(chats.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
