// The plan card's build/revision turns: one visible "preparing" status while Auto classifies, and one chat line
// telling which effort/model it picked — so a slow classifier never looks like a stuck app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '../src/session.js';

const SETTINGS = { effortAuto: true, modelAuto: true, model: 'opencode-go/deepseek-v4.1-flash', modelTiers: null };

function fixture(settings = SETTINGS) {
  const status = {};
  const chats = [];
  const hub = {
    settingsFor: () => ({ ...settings }),
    engineOf: () => 'opencode',
    setStatus: (_id, patch) => Object.assign(status, patch),
    updateSettings: () => {},
    chat: (_id, msg) => chats.push(msg),
  };
  const manager = new SessionManager({ hub, claude: null, opencode: {}, agents: {}, teamPrompt: '', ledger: null, account: null });
  return { manager, status, chats };
}

async function withFakeClassifier(level, fn) {
  const before = process.env.OFFICE_EFFORT_FAKE;
  process.env.OFFICE_EFFORT_FAKE = level;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.OFFICE_EFFORT_FAKE;
    else process.env.OFFICE_EFFORT_FAKE = before;
  }
}

test('preparePlanTurn: planPreparing is live during build, cleared after, with one Auto line for effort and model', async () => {
  await withFakeClassifier('high', async () => {
    const { manager, status, chats } = fixture();
    const running = manager.preparePlanTurn('p', '## Rencana\n\n1. Ubah README', 'build');
    assert.equal(status.planPreparing, 'build', 'the card/bottom typing row has something to show while the classifier runs');
    const auto = await running;
    assert.equal(status.planPreparing, null, 'the status is cleared even after a successful classification');
    assert.equal(auto.autoEffort.level, 'high');
    assert.deepEqual(auto.autoModel && { tier: auto.autoModel.tier, label: auto.autoModel.label, model: auto.autoModel.model }, { tier: 'kuat', label: 'Kuat', model: 'opencode-go/deepseek-v4-pro' });
    assert.equal(chats.length, 1);
    assert.match(chats[0].text, /^⚙️ Auto build: Effort High · Model Kuat → deepseek-v4-pro/);
  });
});

test('preparePlanTurn: a revision is labelled as such and clears its own status', async () => {
  await withFakeClassifier('high', async () => {
    const { manager, status, chats } = fixture();
    const running = manager.preparePlanTurn('p', 'Revisi rencananya: tambahkan lisensi', 'revisi');
    assert.equal(status.planPreparing, 'revisi');
    await running;
    assert.equal(status.planPreparing, null);
    assert.match(chats[0].text, /^⚙️ Auto revisi: Effort High · Model Kuat/);
  });
});

test('preparePlanTurn: the chosen model is reported even when the tier already matches the current model', async () => {
  await withFakeClassifier('high', async () => {
    const { manager, chats } = fixture({ ...SETTINGS, model: 'opencode-go/deepseek-v4-pro' });
    const auto = await manager.preparePlanTurn('p', '## Rencana', 'build');
    assert.equal(auto.autoModel.label, 'Kuat');
    assert.match(chats[0].text, /Model Kuat → deepseek-v4-pro/, 'the bubble/info must show the model even when no switch was needed');
  });
});

test('preparePlanTurn: both Auto off means no status, no classification and no chat line', async () => {
  await withFakeClassifier('high', async () => {
    const { manager, status, chats } = fixture({ ...SETTINGS, effortAuto: false, modelAuto: false });
    const auto = await manager.preparePlanTurn('p', '## Rencana', 'build');
    assert.equal(auto, null);
    assert.equal(status.planPreparing, undefined);
    assert.deepEqual(chats, []);
  });
});
