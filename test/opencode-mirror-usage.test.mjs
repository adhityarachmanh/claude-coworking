// OpenCode terminal sessions: the mirror writes each assistant message's token/cost usage into the ledger,
// once, and never replays older history that existed before it started watching.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { OpenCodeMirror } from '../src/opencode-mirror.js';
import { UsageLedger } from '../src/usage.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-oc-mirror-usage-'));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const messages = [
  {
    id: 'msg_old',
    type: 'assistant',
    time: { created: 1, completed: 2 },
    model: { providerID: 'opencode-go', id: 'old-model' },
    tokens: { input: 999, output: 999, cache: { read: 0, write: 0 } },
    cost: 9,
    content: [{ type: 'text', text: 'lama' }],
  },
  { id: 'msg_user', type: 'user', text: 'halo' },
  {
    id: 'msg_current',
    type: 'assistant',
    time: { created: 3, completed: 4 },
    model: { providerID: 'opencode-go', id: 'beam-free' },
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 7 } },
    cost: 0.01,
    content: [{ type: 'text', text: 'jawab' }],
  },
];

test('a terminal OpenCode assistant message records input/output/reasoning/cache/cost once', async () => {
  const project = { id: 'p1', name: 'toko', path: 'C:/project/toko' };
  const hub = {
    engine: 'opencode',
    mirrorPaused: false,
    projects: new Map([[project.id, project]]),
    upsertProject: () => project,
    office() {},
    chat() {},
    updateChat() {},
    setStatus() {},
  };
  const ledger = new UsageLedger({ file: path.join(TMP, 'usage.jsonl'), account: () => null });
  const api = async (_bin, operation) => {
    if (operation === 'session.active') return { ses_test: {} };
    if (operation === 'session.get') return { location: { directory: project.path } };
    if (operation === 'session.message.list') return messages.slice().reverse(); // OpenCode's order=desc
    throw new Error(`unexpected ${operation}`);
  };
  const mirror = new OpenCodeMirror(hub, { bin: { command: 'fake', args: [] }, ownSessions: () => new Set(), skipDir: () => false, api, ledger });

  await mirror.tick();
  await mirror.tick(); // the same messages are pulled again; they must not be counted twice

  const rows = ledger.rows();
  assert.equal(rows.length, 1, 'one row per assistant message, not per poll');
  assert.deepEqual(
    {
      account: rows[0].account.id,
      source: rows[0].source,
      project: rows[0].projectId,
      session: rows[0].sessionId,
      model: rows[0].model,
      input: rows[0].input,
      output: rows[0].output,
      cacheRead: rows[0].cacheRead,
      cacheWrite: rows[0].cacheWrite,
      cost: rows[0].costUsd,
      requests: rows[0].requests,
    },
    {
      account: 'opencode',
      source: 'cli',
      project: 'p1',
      session: 'ses_test',
      model: 'opencode-go/beam-free',
      input: 100,
      output: 25,
      cacheRead: 300,
      cacheWrite: 7,
      cost: 0.01,
      requests: 1,
    },
    'old history before the watched turn is not replayed',
  );
});
