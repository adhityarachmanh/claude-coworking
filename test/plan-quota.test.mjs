// 📊 OpenCode Go/Console quota: shown only when the console really answered. No subscription → the account panel
// stays empty instead of showing an estimate or a login nag (nothing in the app depends on a plan).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { goQuotaFromConsole } from '../public/js/core/plan-quota.js';

test('goQuotaFromConsole: only real console data counts', () => {
  assert.equal(goQuotaFromConsole({ source: 'console', console: { meters: [] } }), true);
  assert.equal(goQuotaFromConsole({ source: 'estimate', estimate: { models: [] } }), false, 'a local estimate is not a plan');
  assert.equal(goQuotaFromConsole({ source: 'console' }), false, 'console without a payload is not data');
  assert.equal(goQuotaFromConsole({ available: false }), false);
  assert.equal(goQuotaFromConsole(null), false);
  assert.equal(goQuotaFromConsole(undefined), false);
  assert.equal(goQuotaFromConsole('console'), false);
});
