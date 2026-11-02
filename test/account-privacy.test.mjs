// 👤 Akun on plain-HTTP WiFi (read-only, sniffable): plan and quota only, never the email, names, organisation or
// real ids. src/account.js accountPrivacyView + the routes of src/routes/account.js with a hand-made ctx. No server.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { accountPrivacyView, accountViewKey } from '../src/account.js';
import { buildRouter } from '../src/routes/index.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-account-privacy-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const PROFILE = { loggedIn: true, email: 'adhit@example.com', orgName: 'Abati Technology', orgId: 'org-123', subscriptionType: 'max', authMethod: 'claude.ai', accountUuid: 'uuid-adhit', displayName: 'Adhit', fullName: 'Adhit Rachman', role: 'admin', seatTier: null, billingType: 'stripe', rateLimitTier: 'default_claude_max_5x' };
const STATE = { profile: PROFILE, limits: { windows: [{ label: 'Current session', percent: 40 }], at: 1 }, rateLimit: null, login: { state: 'waiting', url: 'https://claude.ai/oauth/authorize?code=secret', error: null } };
const IDENTITY = /adhit@example\.com|Abati|org-123|uuid-adhit|Adhit|oauth/;

test('accountPrivacyView: plan facts and quota stay; identity, ids and the login URL go; ids are opaque and stable', () => {
  const key = accountViewKey(path.join(TMP, 'k', 'account-view.key'));
  assert.ok(key.length >= 32);
  assert.deepEqual(accountViewKey(path.join(TMP, 'k', 'account-view.key')), key, 'the same key after a restart');
  assert.deepEqual(readFileSync(path.join(TMP, 'k', 'account-view.key')), key);
  const view = accountPrivacyView(key);
  const s = view.state(STATE);
  assert.doesNotMatch(JSON.stringify(s), IDENTITY);
  assert.deepEqual(s.limits, STATE.limits, 'quota numbers stay');
  assert.equal(s.profile.subscriptionType, 'max');
  assert.equal(s.profile.loggedIn, true);
  assert.equal(s.profile.email, undefined);
  assert.match(s.profile.accountKey, /^acct-[0-9a-f]{16}$/);
  assert.equal(s.profile.accountKey, view.id('uuid-adhit'), 'the same opaque id as the report routes');
  assert.equal(view.state(STATE).profile.accountKey, s.profile.accountKey, 'stable across events');
  assert.notEqual(accountPrivacyView(Buffer.alloc(32, 7)).id('uuid-adhit'), s.profile.accountKey, 'keyed: not a plain hash');
  assert.deepEqual(s.login, { state: 'waiting', url: null, error: null });
  assert.equal(STATE.profile.email, 'adhit@example.com', 'input not mutated');
  assert.equal(view.state({ profile: null, login: null }).profile, null);
  assert.equal(view.state({ profile: { loggedIn: false } }).profile.accountKey, null);
  const list = view.accounts([{ id: 'uuid-adhit', email: 'adhit@example.com', org: 'Abati', tokens: 9, first: 1, last: 2 }]);
  assert.deepEqual(list, [{ id: view.id('uuid-adhit'), email: null, org: null, tokens: 9, first: 1, last: 2 }]);
});

// ---------- routes ----------

function fakeRes() {
  const res = { status: 0, headers: {}, body: '' };
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.writeHead = (status, headers = {}) => {
    res.status = status;
    Object.assign(res.headers, headers);
  };
  res.end = (b) => (res.body = String(b ?? ''));
  res.json = () => JSON.parse(res.body);
  return res;
}
const router = buildRouter();
async function call(ctx, p, body = {}) {
  const m = router.match('POST', p);
  const res = fakeRes();
  await m.route.handler(ctx, { headers: {} }, res, m.params, body);
  return res;
}

const view = accountPrivacyView(Buffer.alloc(32, 1));
const rows = [{ ts: Date.now() - 1000, account: { id: 'uuid-adhit' }, input: 5, output: 5, cacheRead: 0, cacheWrite: 0, model: 'opus', source: 'web', project: { id: 'p', name: 'p' } }];
const ctxFor = (isReadOnly) => ({
  account: { current: { id: 'uuid-adhit', email: PROFILE.email, org: PROFILE.orgName }, profile: PROFILE, limits: null, refreshProfile: async () => PROFILE, publicState: () => structuredClone(STATE) },
  ledger: { accounts: () => [{ id: 'uuid-adhit', email: PROFILE.email, org: PROFILE.orgName, tokens: 10, first: rows[0].ts, last: rows[0].ts }], query: ({ accountId }) => rows.filter((r) => r.account.id === accountId) },
  allowForce: () => false,
  accountPrivacy: view,
  ...(isReadOnly === undefined ? {} : { isReadOnly: () => isReadOnly }),
});

test('/api/account and /api/report/accounts: full for laptop/Tailscale, reduced for WiFi and when the ctx cannot tell', async () => {
  const full = await call(ctxFor(false), '/api/account');
  assert.equal(full.json().profile.email, PROFILE.email);
  const fullList = (await call(ctxFor(false), '/api/report/accounts')).json();
  assert.equal(fullList.current, 'uuid-adhit');
  for (const ro of [true, undefined]) {
    const acct = await call(ctxFor(ro), '/api/account');
    assert.doesNotMatch(acct.body, IDENTITY, `isReadOnly ${ro}`);
    assert.equal(acct.json().usage.week.total, 10, 'usage numbers stay');
    const list = await call(ctxFor(ro), '/api/report/accounts');
    assert.doesNotMatch(list.body, IDENTITY);
  }
  const list = (await call(ctxFor(true), '/api/report/accounts')).json();
  assert.equal(list.current, view.id('uuid-adhit'));
  assert.equal(list.accounts[0].id, list.current, 'the same opaque id in the list and as current');
  assert.equal((await call(ctxFor(true), '/api/account')).json().profile.accountKey, list.current, 'and in the profile');
});

test('/api/report/summary from WiFi: the opaque id selects the account; a real or unknown id is refused', async () => {
  const ctx = ctxFor(true);
  const sum = await call(ctx, '/api/report/summary', { accountId: view.id('uuid-adhit'), from: 0 });
  assert.equal(sum.status, 200);
  assert.equal(sum.json().totals.total, 10);
  assert.equal((await call(ctx, '/api/report/summary', { from: 0 })).json().totals.total, 10, 'no id: the current account');
  for (const id of ['uuid-adhit', 'acct-0000000000000000']) assert.equal((await call(ctx, '/api/report/summary', { accountId: id })).status, 404, id);
  assert.equal((await call(ctxFor(false), '/api/report/summary', { accountId: 'uuid-adhit', from: 0 })).json().totals.total, 10, 'laptop: real ids as before');
});
