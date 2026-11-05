// Model logos: the pure mapping from a model id to an ai_logos/*.svg file, and the index/image caches behind the
// office plaque and 🧠 Mode Otak. Runs in Node (no DOM): image work degrades to a monogram, never to a crash.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeModelOf, drawModelLogo, logoFileFor, logoImage, logoIndex } from '../public/js/core/model-logo.js';

// A stand-in for the real folder: enough names to cover exact, alias, -free and every family fallback.
const NAMES = [
  'claude-opus-4-8.svg',
  'claude-opus-5-5.svg',
  'claude-sonnet-5-5.svg',
  'claude-haiku-5-5.svg',
  'claude-fable-5-1.svg',
  'deepseek-v4.1-flash.svg',
  'deepseek-v4.1-flash-free.svg',
  'gemini-4-argon.svg',
  'glm-5.3.svg',
  'glm-5.3-flash-free.svg',
  'gpt-5.4.svg',
  'gpt-6-luna.svg',
  'gpt-6.1-sol.svg',
  'grok-4.7.svg',
  'hy4.svg',
  'kimi-k3.1-pro.svg',
  'longcat-2.0.svg',
  'mimo-v2.6-pro.svg',
  'minimax-m3.1-flash.svg',
  'mistral-large-4.svg',
  'muse-spark-1.3.svg',
  'qwen3.8-max.svg',
  'step-5-preview.svg',
];

test('logoFileFor: an exact model id (case, provider prefix and #variant ignored)', () => {
  assert.equal(logoFileFor('deepseek-v4.1-flash', NAMES), 'deepseek-v4.1-flash.svg');
  assert.equal(logoFileFor('opencode-go/deepseek-v4.1-flash', NAMES), 'deepseek-v4.1-flash.svg', 'prefix provider dibuang');
  assert.equal(logoFileFor('opencode-go/deepseek-v4.1-flash#high', NAMES), 'deepseek-v4.1-flash.svg', '#varian dibuang');
  assert.equal(logoFileFor('  GLM-5.3  ', NAMES), 'glm-5.3.svg', 'spasi + huruf besar');
  assert.equal(logoFileFor('openrouter/anthropic/claude-opus-5-5', NAMES), 'claude-opus-5-5.svg', 'prefix bertingkat');
  assert.equal(logoFileFor('mimo-v2.6-pro', ['mimo-v2.6-pro', 'claude-opus-5-5.svg']), 'mimo-v2.6-pro.svg', 'nama tanpa .svg juga diterima');
  assert.equal(logoFileFor('kimi-k3.1-pro', ['Kimi-K3.1-Pro.svg']), 'Kimi-K3.1-Pro.svg', 'nama persis seperti di folder (huruf besar)');
  assert.equal(logoFileFor('claude-opus-5-5', ['../claude-opus-5-5.svg']), null, 'nama di luar pola server tidak pernah dipakai');
});

test('logoFileFor: Claude Code aliases map to their model', () => {
  const cases = { default: 'claude-opus-5-5.svg', opus: 'claude-opus-5-5.svg', sonnet: 'claude-sonnet-5-5.svg', haiku: 'claude-haiku-5-5.svg', fable: 'claude-fable-5-1.svg' };
  for (const [alias, file] of Object.entries(cases)) assert.equal(logoFileFor(alias, NAMES), file, alias);
  assert.equal(logoFileFor('sonnet', ['gpt-5.4.svg']), null, 'alias tanpa file keluarganya: null');
});

test('logoFileFor: a -free model uses the paid model\u2019s logo', () => {
  assert.equal(logoFileFor('glm-5.3-flash-free', NAMES), 'glm-5.3-flash-free.svg', 'file -free sendiri menang');
  assert.equal(logoFileFor('deepseek-v4.1-flash-free', NAMES), 'deepseek-v4.1-flash-free.svg');
  // only the paid file exists: drop the suffix and look again
  assert.equal(logoFileFor('claude-opus-5-5-free', NAMES), 'claude-opus-5-5.svg');
  assert.equal(logoFileFor('kimi-k3.1-pro-free', NAMES), 'kimi-k3.1-pro.svg');
});

test('logoFileFor: an unknown version still gets its family\u2019s logo', () => {
  const cases = {
    claude: 'claude-opus-5-5.svg', // the family's default file
    gpt: 'gpt-6.1-sol.svg', // the newest gpt the folder has
    kimi: 'kimi-k3.1-pro.svg',
    glm: 'glm-5.3.svg',
    deepseek: 'deepseek-v4.1-flash.svg',
    gemini: 'gemini-4-argon.svg',
    qwen: 'qwen3.8-max.svg',
    grok: 'grok-4.7.svg',
    minimax: 'minimax-m3.1-flash.svg',
    mimo: 'mimo-v2.6-pro.svg',
    hy: 'hy4.svg',
    muse: 'muse-spark-1.3.svg',
    longcat: 'longcat-2.0.svg',
    step: 'step-5-preview.svg',
    mistral: 'mistral-large-4.svg',
  };
  for (const [family, file] of Object.entries(cases)) {
    const id = family === 'hy' ? 'hy5-preview' : `${family}-9-unknown`;
    assert.equal(logoFileFor(id, NAMES), file, id);
  }
  assert.equal(logoFileFor('claude-opus-9', ['claude-opus-5-5.svg', 'claude-haiku-5-5.svg']), 'claude-opus-5-5.svg', 'tanpa file bawaan: anggota keluarga terbaru');
});

test('logoFileFor: unknown models and a missing index are null', () => {
  for (const model of ['acme-1', 'mystery', '', '   ', null, undefined, 42]) assert.equal(logoFileFor(model, NAMES), null, String(model));
  assert.equal(logoFileFor('claude-opus-5-5', []), null, 'index kosong');
  assert.equal(logoFileFor('claude-opus-5-5', undefined), null);
  assert.equal(logoFileFor('claude-opus-5-5', 'claude-opus-5-5.svg'), null, 'bukan array');
  assert.equal(logoFileFor('claude-opus-5-5', [null, 42, 'claude-opus-5-5.svg']), 'claude-opus-5-5.svg', 'entri aneh dilewati');
});

test('logoFileFor: the engine is only a last hint', () => {
  assert.equal(logoFileFor('acme-1', NAMES, 'claude'), 'claude-opus-5-5.svg');
  assert.equal(logoFileFor('acme-1', NAMES, 'opencode'), null);
  assert.equal(logoFileFor('kimi-k3.1-pro', NAMES, 'claude'), 'kimi-k3.1-pro.svg', 'modelnya sendiri menang atas mesin');
});

test('activeModelOf: activeModel wins, label is the id after the provider', () => {
  const names = ['claude-opus-5-5.svg'];
  assert.deepEqual(activeModelOf({ activeModel: 'opencode-go/glm-5.3', model: 'kimi-k3.1-pro' }, 'opencode'), {
    model: 'opencode-go/glm-5.3',
    label: 'glm-5.3',
    file: null, // the index is not loaded: the caller draws a monogram and asks again next frame
  });
  assert.deepEqual(activeModelOf({ model: 'opencode-go/deepseek-v4.1-flash#high' }, 'opencode'), {
    model: 'opencode-go/deepseek-v4.1-flash#high',
    label: 'deepseek-v4.1-flash',
    file: null,
  });
  assert.deepEqual(activeModelOf({ activeModel: 'sonnet' }, 'claude'), { model: 'sonnet', label: 'sonnet', file: null }, 'alias tetap labelnya');
  assert.deepEqual(activeModelOf({}, 'claude'), { model: '', label: '', file: null }, 'tanpa model');
  assert.deepEqual(activeModelOf(), { model: '', label: '', file: null }, 'tanpa status');
  assert.deepEqual(activeModelOf({ model: '   ' }), { model: '', label: '', file: null }, 'kosong setelah trim');
  assert.equal(activeModelOf({ model: 'claude-opus-5-5' }, 'claude').file, null, 'di Node index tidak pernah dimuat');
  assert.equal(names.length, 1);
});

test('logoImage: no DOM, no image (and an unsafe name is never requested)', () => {
  assert.equal(logoImage('claude-opus-5-5.svg'), null);
  assert.equal(logoImage('../../server.js'), null);
  assert.equal(logoImage(''), null);
  assert.equal(logoImage(null), null);
});

test('drawModelLogo: a monogram fallback, and it never throws', () => {
  const drawn = [];
  const g = {
    save() {},
    restore() {},
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
    drawImage() {},
    fillText(text) {
      drawn.push(text);
    },
  };
  drawModelLogo(g, null, 10, 10, 18, { label: 'claude-opus-5-5', ring: '#8899ff' });
  drawModelLogo(g, 'not-a-file.js', 10, 10, 18, { label: 'deepseek-v4.1-flash', ring: [1, 2, 3] });
  drawModelLogo(g, 'claude-opus-5-5.svg', 10, 10, 18, { label: 'glm-5.3' }); // no Image here: monogram again
  assert.deepEqual(drawn, ['CL', 'DE', 'GL']);
  drawModelLogo(g, null, 10, 10, 18); // nothing to show
  assert.equal(drawn.at(-1), 'AI');
  // missing arguments / a broken context must not break a frame
  drawModelLogo(null, 'x.svg', 0, 0, 10);
  drawModelLogo(g, null, 0, 0, 0);
  drawModelLogo({}, 'x.svg', 0, 0, 10);
});

test('logoIndex: fetched once, cached, and a failure is retried only after 60 s', async () => {
  const saved = { Image: globalThis.Image, fetch: globalThis.fetch, now: Date.now };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  let calls = 0;
  let answer = 'fail';
  globalThis.Image = class {}; // "a browser": only then is the index fetched at all
  globalThis.fetch = async () => {
    calls++;
    if (answer === 'fail') throw new Error('offline');
    return { ok: true, json: async () => ({ logos: ['claude-opus-5-5.svg', 'deepseek-v4.1-flash.svg', '../secret.svg', 42] }) };
  };
  try {
    assert.deepEqual(logoIndex(), [], 'belum ada nama sebelum index tiba');
    await tick();
    assert.equal(calls, 1, 'satu permintaan');
    assert.deepEqual(logoIndex(), [], 'gagal: tetap kosong');
    await tick();
    assert.equal(calls, 1, 'tidak meminta ulang tiap frame');
    answer = 'ok';
    const base = Date.now();
    Date.now = () => base + 60_000;
    assert.deepEqual(logoIndex(), []);
    await tick();
    Date.now = saved.now;
    assert.equal(calls, 2, 'dicoba lagi setelah 60 detik');
    assert.deepEqual(logoIndex(), ['claude-opus-5-5.svg', 'deepseek-v4.1-flash.svg'], 'nama yang tidak aman dibuang');
    assert.equal(calls, 2, 'sesudah berhasil: tidak pernah diminta lagi');
    // the mapping now resolves through the cached index (what the plaque/brain show once it has loaded)
    assert.equal(activeModelOf({ activeModel: 'opencode-go/deepseek-v4.1-flash' }).file, 'deepseek-v4.1-flash.svg');
    assert.equal(activeModelOf({ model: 'sonnet' }).file, null, 'alias sonnet butuh file yang tidak ada di index ini');
  } finally {
    Date.now = saved.now;
    if (saved.Image === undefined) delete globalThis.Image;
    else globalThis.Image = saved.Image;
    globalThis.fetch = saved.fetch;
  }
});
