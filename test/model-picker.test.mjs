// The model picker panel (public/js/features/model-picker.js): only sources that can actually run are offered, and
// every row says where its model comes from — two providers may offer a model with the same name.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// The panel module reaches core/dom.js and core/state.js, which read browser globals at import time.
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.document ??= { querySelector: () => ({ content: 'test-token' }), documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { modelPanelHtml, modelSourceLabel } = await import('../public/js/features/model-picker.js');

const CATALOG = {
  claude: { models: [{ value: 'sonnet', name: 'Sonnet' }] },
  opencode: {
    models: [
      { value: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { value: 'wally/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { value: 'river/glm-5.3', name: 'GLM 5.3' },
    ],
  },
};
const NAMES = { 'opencode-go': 'OpenCode Go', wally: 'Wally', river: 'River AI' };
const AUTH = { known: ['opencode-go', 'wally', 'river'], connected: ['opencode-go', 'river'] };

const panel = (over = {}) =>
  modelPanelHtml({ catalog: CATALOG, current: '', query: '', engine: 'opencode', providerNames: NAMES, providerAuth: AUTH, favorites: [], recent: [], ...over });

test('a source without credentials is hidden entirely, not disabled or greyed', () => {
  const html = panel();
  assert.doesNotMatch(html, /Wally/);
  assert.doesNotMatch(html, /wally\/deepseek-v4.1-flash/);
  assert.match(html, /OpenCode Go/);
  assert.match(html, /River AI/);
});

test('rows carry a source chip so identical model names stay distinguishable', () => {
  const html = panel();
  assert.match(html, /<span class="mp-src"[^>]*>OpenCode Go<\/span>/);
  assert.match(html, /<span class="mp-src"[^>]*>River AI<\/span>/);
  // The Claude group's rows are labelled by their subscription source.
  assert.match(html, /<span class="mp-src"[^>]*>Claude<\/span>/);
});

test('the source label: Claude for Claude rows, the provider display name otherwise, empty when unknown', () => {
  assert.equal(modelSourceLabel({ engine: 'claude' }), 'Claude');
  assert.equal(modelSourceLabel({ engine: 'opencode', provider: 'river', providerNames: NAMES }), 'River AI');
  assert.equal(modelSourceLabel({ engine: 'opencode', provider: 'unknown-provider' }), 'unknown-provider');
  assert.equal(modelSourceLabel({ engine: 'opencode', provider: '' }), '');
});

test('no usable source: the panel says so instead of showing models that cannot run', () => {
  const html = panel({ providerAuth: { known: ['opencode-go', 'wally', 'river'], connected: [] } });
  assert.match(html, /Belum ada sumber model yang aktif/);
  assert.doesNotMatch(html, /Glm|GLM 5.3/);
});

test('an unreadable account view keeps every model and adds one light warning', () => {
  const html = panel({ providerAuth: null });
  assert.match(html, /wally\/deepseek-v4\.1-flash/, 'model tetap bisa dipilih saat status login tak terbaca');
  assert.match(html, /status login provider tidak terbaca/i);
  assert.match(html, /OpenCode Go \(\d\)/, 'grup tetap menampilkan jumlah model');
});

test('the project’s current model stays visible even when its source lost its credentials', () => {
  const html = panel({ current: 'wally/deepseek-v4.1-flash', providerAuth: { known: ['opencode-go', 'wally', 'river'], connected: ['opencode-go', 'river'] } });
  // Changing away from the current model must remain possible; the row itself is not hidden.
  assert.match(html, /wally\/deepseek-v4\.1-flash/);
});

test('search matches the source name too (finding a provider’s models by provider)', () => {
  const html = panel({ query: 'river' });
  assert.match(html, /river\/glm-5\.3/);
  assert.doesNotMatch(html, /opencode-go\/deepseek-v4\.1-flash/);
});
