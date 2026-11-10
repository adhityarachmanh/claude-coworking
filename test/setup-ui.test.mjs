import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { itemView, jobView, normalizeSetup, setupSummary, shouldAutoOpen } from '../public/js/core/setup-view.js';

const item = (patch = {}) => ({ id: 'claude', label: 'Claude Code', state: 'missing', optional: false, version: null, login: null, origin: null, hint: null, ...patch });

describe('setup view', () => {
  test('normalizeSetup keeps only the wizard rows, validates fields and sorts them', () => {
    const view = normalizeSetup({
      supported: true,
      needsSetup: true,
      items: [
        { id: 'git', label: 'Git', state: 'ready' },
        { id: 'tailscale', label: 'Tailscale', state: 'missing', optional: true, hint: 'x'.repeat(500) },
        { id: 'node', label: 'Node.js', state: 'ready', version: 'v24.1.0' },
        { id: 'claude', label: 'Claude Code', state: 'nonsense', login: false, origin: 'C:\\Users\\me' },
      ],
    });
    assert.deepEqual(view.items.map((i) => i.id), ['node', 'claude', 'tailscale']);
    assert.equal(view.items[1].state, 'unknown');
    assert.equal(view.items[1].origin, null, 'an unknown origin is dropped');
    assert.equal(view.items[2].hint.length, 240, 'hints are bounded');
    assert.equal(view.needsSetup, true);
    assert.equal(normalizeSetup({ items: 'nope' }).items.length, 0);
    assert.equal(normalizeSetup(null), null);
  });

  test('a ready tool offers login only when the account is missing', () => {
    assert.equal(itemView(item({ state: 'ready', login: false })).login, 'claude');
    assert.equal(itemView(item({ state: 'ready', login: true })).login, null);
    assert.equal(itemView(item({ state: 'ready', login: false })).badge, 'Perlu login');
  });

  test('install is offered only to a local, writable page that is not busy or unsupported', () => {
    assert.equal(itemView(item()).install, 'claude');
    for (const opts of [{ readOnly: true }, { local: false }, { busy: true }, { supported: false }]) {
      assert.equal(itemView(item(), opts).install, null, JSON.stringify(opts));
    }
    assert.equal(itemView(item({ optional: true })).badge, 'Opsional');
    assert.equal(itemView(item({ state: 'ready', version: '1.2.3', origin: 'runtime', login: true })).detail, 'v1.2.3 · runtime Adhitron · sudah login');
  });

  test('jobView clamps the percent and an unset percent stays indeterminate', () => {
    assert.equal(jobView({ state: 'running', percent: 140 }).percent, 100);
    assert.equal(jobView({ state: 'running', percent: -2 }).percent, 0);
    assert.equal(jobView({ state: 'running' }).percent, null);
    assert.equal(jobView({ state: 'running', percent: 12.4 }).percent, 12);
    assert.equal(jobView({ state: 'bogus' }).state, 'failed');
  });

  test('summary names the first missing mandatory step and ignores optional ones', () => {
    const view = normalizeSetup({
      supported: true,
      items: [item(), item({ id: 'opencode', label: 'OpenCode', optional: true, state: 'missing' })],
    });
    assert.match(setupSummary(view), /0\/1 siap · berikutnya: Claude Code/);
    const ready = normalizeSetup({ supported: true, items: [item({ state: 'ready' })] });
    assert.match(setupSummary(ready), /1\/1 siap/);
    assert.match(setupSummary(normalizeSetup({ supported: false })), /Windows/);
  });

  test('the wizard opens itself only on a fresh local install, once', () => {
    const view = normalizeSetup({ supported: true, needsSetup: true, items: [item()] });
    assert.equal(shouldAutoOpen(view, {}), true);
    assert.equal(shouldAutoOpen(view, { seen: true }), false);
    assert.equal(shouldAutoOpen(view, { readOnly: true }), false);
    assert.equal(shouldAutoOpen(view, { local: false }), false);
    assert.equal(shouldAutoOpen(normalizeSetup({ supported: true, needsSetup: false, items: [item({ state: 'ready' })] })), false);
  });
});
