// Stage 2: the old app-wide switch parked one engine's settings/sessions under `workspaces[engine]`. On load that
// parking lot is flattened into the per-project fields (settings[id].engine, engineSettings, sessionsByEngine),
// a copy of state.json is kept first, and the field disappears. One-way, idempotent, no user data lost.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';

const UUID = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
};
const PRE = 'state.json.pre-per-project-';

/** Runs `fn(dir)` against a data folder holding exactly `state` (raw bytes kept for the backup check). */
function withState(state, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-engine-migration-'));
  try {
    const raw = state === null ? null : JSON.stringify(state);
    if (raw !== null) writeFileSync(path.join(dir, 'state.json'), raw);
    return fn(dir, raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const backups = (dir) => readdirSync(dir).filter((name) => name.startsWith(PRE));
const saved = (dir) => JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));

test('load flattens workspaces: per-engine settings/sessions are kept and the parking lot is gone', () => {
  const stored = {
    engine: 'opencode',
    remote: { devices: [{ id: 'phone-1', name: 'HP Adhit' }], vapid: { privateKey: 'RAHASIA-VAPID' } },
    settings: {
      a: { model: 'opencode-go/beam-free', team: false },
      b: { model: 'sonnet', effort: 'low', engine: 'claude' },
    },
    sessions: { a: 'ses_abc123' },
    engineSettings: { b: { opencode: { model: 'opencode-go/kimi-k3', effort: 'medium', agent: 'docs' } } },
    sessionsByEngine: { b: { opencode: 'ses_keep' } },
    workspaces: {
      claude: {
        // settings: model, effort, agent (the rest was shared and never parked)
        settings: { a: { model: 'opus', effort: 'high', agent: 'docs', team: true }, b: { model: 'haiku', effort: 'low', mode: 'auto' } },
        sessions: { a: UUID.a, b: UUID.b },
        // a parked turn of the other engine: never carried over (it would be resumed by the wrong engine)
        turns: { a: { sessionId: UUID.a, prompt: 'jangan dibawa', uuid: null, startedAt: 1 } },
        interrupted: { a: { reason: 'crash', sessionId: UUID.a, at: 2 } },
      },
    },
  };
  withState(stored, (dir) => {
    const hub = new Hub({ dataDir: dir });
    const state = hub.persisted;
    // The rollback copy keeps the project data but never the paired phones / VAPID key.
    assert.equal(state.workspaces, undefined, 'the parking lot is removed');
    assert.ok(!('workspaces' in saved(dir)), 'and not written back to state.json');

    // The project's own engine wins; the others get the app-wide default (then the app-wide switch's engine).
    assert.equal(state.settings.a.engine, 'opencode', 'a project without its own engine takes the default... which was OpenCode');
    assert.equal(state.settings.b.engine, 'claude', 'an explicit per-project engine is preserved');

    // Parked Claude Code settings are remembered per project, next to the project's current engine.
    assert.deepEqual(state.engineSettings.a.claude, { model: 'opus', effort: 'high', agent: 'docs' });
    assert.deepEqual(state.engineSettings.b.claude, { model: 'haiku', effort: 'low', agent: '' }, 'only model/effort/agent are taken');

    // An engineSettings entry written later (Stage 1) wins over the older parked one.
    assert.deepEqual(state.engineSettings.b.opencode, { model: 'opencode-go/kimi-k3', effort: 'medium', agent: 'docs' });

    // Sessions: parked ids per engine, and the legacy single map seeds the project's current engine.
    assert.equal(state.sessionsByEngine.a.claude, UUID.a);
    assert.equal(state.sessionsByEngine.a.opencode, 'ses_abc123', 'the old single map belongs to the current engine');
    assert.equal(state.sessionsByEngine.b.claude, UUID.b);
    assert.equal(state.sessionsByEngine.b.opencode, 'ses_keep', 'an id already stored is not replaced');
    assert.equal(state.sessions.a, 'ses_abc123', 'the compatibility mirror is unchanged');
    assert.equal(state.sessions.b, UUID.b, "an empty mirror is filled from the project's current engine");

    // A turn belongs to the engine that ran it: nothing of the parked workspace arrives.
    assert.deepEqual(state.turns, {});
    assert.deepEqual(state.interrupted, {});

    // The safety copy keeps the project data for a rollback, but never the paired phones / VAPID key.
    const copies = backups(dir);
    assert.equal(copies.length, 1, 'one copy, best effort');
    const copy = JSON.parse(readFileSync(path.join(dir, copies[0]), 'utf8'));
    assert.equal(copy.remote, undefined, 'device records and the VAPID key are not in the copy');
    assert.equal(copy.push, undefined);
    assert.deepEqual(copy.settings, stored.settings, 'project settings are kept');
    assert.ok(!JSON.stringify(copy).includes('RAHASIA-VAPID'));
  });
});

test('a second start is a no-op: no workspace left, no new copy, same data', () => {
  const stored = {
    engine: 'opencode',
    settings: { a: {} },
    workspaces: { claude: { settings: { a: { model: 'opus', effort: 'high' } }, sessions: { a: UUID.a }, turns: { a: { prompt: 'x' } } } },
  };
  withState(stored, (dir) => {
    const first = new Hub({ dataDir: dir }).persisted;
    assert.equal(backups(dir).length, 1);
    const before = saved(dir);
    const second = new Hub({ dataDir: dir }).persisted;
    assert.equal(backups(dir).length, 1, 'an already migrated state makes no new copy');
    assert.deepEqual(second.workspaces, undefined);
    assert.deepEqual(second.engineSettings, first.engineSettings);
    assert.deepEqual(second.sessionsByEngine, first.sessionsByEngine);
    assert.deepEqual(saved(dir), before, 'state.json is not rewritten again');
  });
});

test('nothing to migrate: no copy and state.json is left byte for byte alone', () => {
  const stored = { engine: 'claude', settings: { a: { engine: 'claude', model: 'opus' } }, sessionsByEngine: { a: { claude: UUID.a } } };
  withState(stored, (dir, raw) => {
    const hub = new Hub({ dataDir: dir });
    assert.equal(backups(dir).length, 0, 'no misleading safety copy');
    assert.equal(readFileSync(path.join(dir, 'state.json'), 'utf8'), raw, 'not even rewritten');
    assert.equal(hub.engineOf('a'), 'claude');
  });
});

test('settings without an engine are filled with the app-wide default (no copy needed)', () => {
  withState({ engine: 'opencode', settings: { a: { model: 'opencode-go/beam-free' }, b: {} } }, (dir) => {
    const hub = new Hub({ dataDir: dir });
    assert.equal(hub.persisted.settings.a.engine, 'opencode');
    assert.equal(hub.persisted.settings.b.engine, 'opencode');
    assert.equal(backups(dir).length, 0, 'no parked workspace: nothing to back up');
    assert.equal(hub.engineOf('a'), 'opencode');
  });
});

test('invalid engines fall back to the default; unknown parked engines are ignored', () => {
  const stored = {
    engine: 'gpt-4', // not an engine: the load falls back to Claude Code
    settings: { a: { engine: 'klingon', model: 'opus' } },
    workspaces: {
      gpt: { settings: { a: { model: 'gpt-5', effort: 'high' } }, sessions: { a: 'ses_not-an-open-code-session' } },
      claude: { sessions: { a: 'bukan-uuid' } }, // wrong shape for a Claude Code conversation: dropped
    },
  };
  withState(stored, (dir) => {
    const hub = new Hub({ dataDir: dir });
    assert.equal(hub.persisted.engine, 'claude');
    assert.equal(hub.persisted.settings.a.engine, 'claude', 'an unknown per-project engine falls back');
    assert.equal(hub.persisted.engineSettings?.a?.gpt, undefined, 'an unknown engine is never remembered');
    assert.equal(hub.persisted.sessionsByEngine?.a?.claude, undefined, 'a malformed session id is dropped');
    assert.equal(backups(dir).length, 1, 'there was parked data, so the copy is made');
    assert.ok(existsSync(path.join(dir, 'state.json')));
  });
});

test('a hand-written workspaces value of the wrong type is just removed', () => {
  withState({ engine: 'claude', settings: { a: { engine: 'claude' } }, workspaces: ['bukan', 'objek'] }, (dir) => {
    const hub = new Hub({ dataDir: dir });
    assert.equal(hub.persisted.workspaces, undefined);
    assert.equal(backups(dir).length, 0, 'nothing usable was parked: no copy');
  });
});

test('pre-per-project state copies are pruned to the newest five', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-engine-prune-'));
  try {
    writeFileSync(path.join(dir, 'state.json'), '{}');
    for (let i = 0; i < 7; i++) {
      const file = path.join(dir, `${PRE}${1000 + i}`);
      writeFileSync(file, '{}');
      const time = new Date(Date.now() - (7 - i) * 86_400_000);
      utimesSync(file, time, time);
    }
    new Hub({ dataDir: dir }); // the constructor prunes at start
    const left = backups(dir).sort();
    assert.equal(left.length, 5, 'only the newest five stay');
    assert.ok(!left.includes(`${PRE}1000`) && !left.includes(`${PRE}1001`), 'the two oldest were removed');
    assert.ok(left.includes(`${PRE}1006`), 'the newest is kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
