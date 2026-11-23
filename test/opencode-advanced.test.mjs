// OpenCode advanced config: the form's view of compaction, warming, snapshots, watcher, formatter, media,
// tool_output, experimental.* and provider headers/body, plus the merge back into the user's config object.
// Unknown keys at every level survive; an "inherit" field never touches the file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advancedView, mergeAdvanced } from '../src/opencode-advanced.js';

test('advancedView: bentuk form, tri-state, dan provider headers/body', () => {
  const view = advancedView({
    snapshots: false,
    watcher: { ignore: ['dist/**'] },
    formatter: true,
    media: { image: { auto_resize: false, max_width: 1000 } },
    tool_output: { max_lines: 100 },
    compaction: { auto: true, background: false, keep: { tokens: 5000 }, buffer: '15%' },
    warming: { prompt: 'OK', interval: 'auto' },
    experimental: { todo: true, subagent_depth: 2, image_generate: { model: 'openai/gpt-image-2' }, location_idle_timeout: false },
    providers: { openai: { headers: { 'X-A': '1' }, body: { temperature: 0 }, models: {} } },
  });
  assert.equal(view.snapshots, 'off');
  assert.equal(view.formatter, 'on');
  assert.deepEqual(view.watcherIgnore, ['dist/**']);
  assert.equal(view.mediaImage.maxWidth, 1000);
  assert.equal(view.compaction.auto, 'on');
  assert.equal(view.compaction.background, 'off');
  assert.equal(view.compaction.keepTokens, 5000);
  assert.equal(view.warming.enabled, 'on');
  assert.equal(view.experimental.todo, 'on');
  assert.equal(view.experimental.locationIdleTimeout, 'false');
  assert.deepEqual(view.providers, [{ id: 'openai', headers: '{"X-A":"1"}', body: '{"temperature":0}' }]);
});

test('mergeAdvanced: inherit tidak menyentuh, angka divalidasi, kunci asing aman', () => {
  const base = {
    snapshots: false,
    formatter: { prettier: { command: ['prettier'] } },
    media: { image: { auto_resize: false, extra: 1 } },
    tool_output: { max_lines: 100, extra: 2 },
    compaction: { auto: true, background: true, keep: { tokens: 5000, extra: 3 }, buffer: '15%', extra: 4 },
    warming: { prompt: 'OK', extra: 5 },
    experimental: { todo: true, image_generate: { model: 'x', extra: 6 }, extra: 7 },
    providers: { openai: { headers: { A: '1' }, models: { m: {} }, package: 'pkg' }, lain: { models: {} } },
  };
  mergeAdvanced(base, { snapshots: 'inherit', formatter: 'inherit', mediaImage: { auto_resize: 'inherit', maxWidth: '', maxHeight: '', maxBase64Bytes: '' }, toolOutput: { maxLines: '', maxBytes: '' }, compaction: { auto: 'inherit', background: 'inherit', keepTokens: '', buffer: '' }, warming: { enabled: 'inherit', prompt: '', interval: '', duration: '' }, experimental: { todo: 'inherit', subagentDepth: '', imageModel: '', locationIdleTimeout: '' }, watcherIgnore: [], providers: [] });
  assert.deepEqual(base.snapshots, false);
  assert.deepEqual(Object.keys(base.formatter), ['prettier']);
  assert.equal(base.media.image.extra, 1);
  assert.equal(base.compaction.keep.extra, 3);
  assert.equal(base.experimental.image_generate.extra, 6);
  assert.deepEqual(base.providers.openai.models, { m: {} });
  assert.equal(base.providers.openai.package, 'pkg');
  assert.ok('lain' in base.providers);

  mergeAdvanced(base, { snapshots: 'on', formatter: 'off', mediaImage: { auto_resize: 'off', maxWidth: '1500', maxHeight: '0', maxBase64Bytes: '' }, toolOutput: { maxLines: '50', maxBytes: '1000' }, compaction: { auto: 'off', background: 'off', keepTokens: '100', buffer: '10%' }, warming: { enabled: 'on', prompt: 'Hi', interval: 'auto', duration: '30 minutes' }, experimental: { todo: 'on', subagentDepth: '2', imageModel: 'openai/gpt-image-2', locationIdleTimeout: 'false' }, watcherIgnore: ['dist/**', 'dist/**', ' coverage/** '], providers: [{ id: 'openai', headers: '{"X-A":"2"}', body: '' }] });
  assert.equal(base.snapshots, true);
  assert.equal(base.formatter, false);
  assert.deepEqual(base.media.image, { auto_resize: false, max_width: 1500, max_height: 0, extra: 1 });
  assert.deepEqual(base.tool_output, { max_lines: 50, max_bytes: 1000, extra: 2 });
  assert.deepEqual(base.compaction, { auto: false, background: false, keep: { tokens: 100, extra: 3 }, buffer: '10%', extra: 4 });
  assert.deepEqual(base.warming, { prompt: 'Hi', interval: 'auto', duration: '30 minutes', extra: 5 });
  assert.deepEqual(base.watcher, { ignore: ['dist/**', 'coverage/**'] });
  assert.equal(base.experimental.todo, true);
  assert.equal(base.experimental.subagent_depth, 2);
  assert.equal(base.experimental.image_generate.extra, 6);
  assert.equal(base.experimental.location_idle_timeout, false);
  assert.equal(base.providers.openai.headers['X-A'], '2');
  assert.equal('body' in base.providers.openai, false);
  for (const bad of [
    { toolOutput: { maxLines: '-1' } },
    { toolOutput: { maxLines: '1.5' } },
    { mediaImage: { maxWidth: '2147483648' } },
    { experimental: { subagentDepth: '6' } },
    { compaction: { buffer: 'x'.repeat(21) } },
    { providers: [{ id: 'openai', headers: '[1]' }] },
    { providers: [{ id: 'tidak-ada', headers: '{}' }] },
    { watcherIgnore: ['x'.repeat(501)] },
  ]) {
    assert.throws(() => mergeAdvanced(JSON.parse(JSON.stringify(base)), bad), (e) => e.status === 400, JSON.stringify(bad).slice(0, 80));
  }
});

test('mergeAdvanced: bentuk yang tak bisa ditampilkan form tidak hilang, id provider berbahaya ditolak', () => {
  const config = {
    warming: { auto: true },
    media: { image: { max_width: 1.5 } },
    experimental: { location_idle_timeout: 60000 },
    providers: { p: { headers: ['bukan', 'objek'], body: { a: 1 } } },
  };
  mergeAdvanced(config, {
    warming: { enabled: 'on', prompt: '', interval: '', duration: '' },
    mediaImage: { auto_resize: 'on', maxWidth: '', maxHeight: '', maxBase64Bytes: '' },
    experimental: { todo: 'inherit', subagentDepth: '', imageModel: '', locationIdleTimeout: '' },
    providers: [{ id: 'p', headers: '', body: '{"a":1}' }],
  });
  assert.deepEqual(config.warming, { auto: true }, 'warming objek asing tidak runtuh jadi true');
  assert.equal(config.media.image.max_width, 1.5, 'nilai non-integer yang tak terlihat tidak dihapus');
  assert.equal(config.experimental.location_idle_timeout, 60000, 'idle berupa angka tidak dihapus');
  assert.deepEqual(config.providers.p.headers, ['bukan', 'objek'], 'headers non-objek tidak dihapus');
  assert.deepEqual(config.providers.p.body, { a: 1 });

  for (const id of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => mergeAdvanced({ providers: { ok: {} } }, { providers: [{ id, headers: '{}' }] }), (e) => e.status === 400, id);
  }
  assert.equal(Object.prototype.headers, undefined, 'tidak ada polusi prototype');
  assert.throws(() => mergeAdvanced({ watcher: { ignore: ['x', 1] } }, { watcherIgnore: ['x'] }), (e) => e.status === 400);
});
