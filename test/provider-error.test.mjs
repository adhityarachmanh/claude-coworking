// Provider errors → one in-app action (public/js/core/provider-error.js). Real provider texts, verbatim where possible.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerErrorHint } from '../public/js/core/provider-error.js';

const act = (text) => providerErrorHint(text)?.act ?? null;

test('a refused key or a missing login points at 👤 Akun', () => {
  assert.equal(act('401 Unauthorized'), 'account');
  assert.equal(act('Incorrect API key provided: sk-proj-***'), 'account');
  assert.equal(act('authentication_error: invalid x-api-key'), 'account');
  assert.equal(act('Provider belum login.'), 'account');
  assert.equal(act('No credentials found for this provider'), 'account');
  assert.equal(providerErrorHint('401 Unauthorized').button, '🔑 Buka Akun');
});

test('an empty balance or quota points at the model picker (another provider may still work)', () => {
  assert.equal(act('402 Payment Required'), 'model');
  assert.equal(act('Your credit balance is too low to access the Anthropic API.'), 'model');
  assert.equal(act('insufficient_quota: You exceeded your current quota'), 'model');
  assert.equal(act('Claude AI usage limit reached'), 'model'); // the fake Claude's real-shaped result
  assert.equal(act('Kuota habis'), 'model');
});

test('a rate limit / overload says wait, with a model switch as the way out', () => {
  assert.equal(act('429 Too Many Requests'), 'model');
  assert.equal(act('rate limit exceeded, retry in 20s'), 'model');
  assert.equal(act('Overloaded'), 'model');
  assert.equal(providerErrorHint('Rate limit exceeded').text.includes('membatasi'), true);
});

test('a context-length error offers 🧹 Ringkas konteks', () => {
  assert.equal(act("This model's maximum context length is 200000 tokens"), 'compact');
  assert.equal(act('prompt is too long: 210000 tokens > 200000 maximum'), 'compact');
  assert.equal(providerErrorHint('maximum context length').button, '🧹 Ringkas konteks');
});

test('a model the provider does not have points at the model picker', () => {
  assert.equal(act('model_not_found: gpt-9 does not exist'), 'model');
  assert.equal(act('No endpoints found for deepseek/unknown'), 'model');
  assert.equal(act('The model `claude-x` is not available'), 'model');
  assert.equal(act('unknown model: foo'), 'model');
});

test('other errors are left alone: no guessed dialog', () => {
  for (const text of [
    '',
    'OpenCode berhenti (exit 7).',
    'Claude Code berhenti (exit 1)',
    'Tool failed: command not found',
    '404 Not Found',
    'Permission denied by user',
    'Model menolak permintaan ini.', // ACP refusal, not a missing model
    'Provider menolak effort «medium» untuk model ini — giliran dicoba ulang dengan Default.',
  ]) {
    assert.equal(providerErrorHint(text), null, text);
  }
});
