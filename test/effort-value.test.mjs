// The app's effort level → OpenCode's `effort` option for the current model (src/acp-session.js effortValue). OpenCode
// advertises the levels from the model metadata, which is a guess for third-party providers: a level it advertises can
// still be refused by the provider, and must then be mapped to Default instead of being sent again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effortValue } from '../src/acp-session.js';

const options = (values) => [{ id: 'effort', options: values.map((value) => ({ value })) }];
const opencodeLike = options(['low', 'medium', 'high', 'max', 'default']);

test('effortValue: the model’s own level is used as offered', () => {
  assert.equal(effortValue('low', opencodeLike), 'low');
  assert.equal(effortValue('max', opencodeLike), 'max');
  assert.equal(effortValue('', opencodeLike), 'default', 'Default is OpenCode’s own default level');
});

test('effortValue: a level the model does not offer maps to the nearest one it does', () => {
  assert.equal(effortValue('xhigh', options(['high', 'max', 'default'])), 'max');
  assert.equal(effortValue('none', opencodeLike), 'low');
  assert.equal(effortValue('high', options([])), null, 'a model without effort levels sends none');
  assert.equal(effortValue('low', null), null);
});

test('effortValue: a level the provider refused is never sent again — Default instead', () => {
  assert.equal(effortValue('low', opencodeLike, new Set(['low'])), 'default');
  assert.equal(effortValue('medium', opencodeLike, new Set(['medium'])), 'default');
  assert.equal(effortValue('low', opencodeLike, new Set(['low', 'medium'])), 'default');
  assert.equal(effortValue('high', opencodeLike, new Set(['low'])), 'high', 'another level is still allowed');
});

test('effortValue: a refused nearest level falls back to an accepted one, then Default', () => {
  assert.equal(effortValue('xhigh', options(['high', 'max', 'default']), new Set(['max'])), 'high');
  assert.equal(effortValue('xhigh', options(['max', 'default']), new Set(['max'])), 'default');
});
