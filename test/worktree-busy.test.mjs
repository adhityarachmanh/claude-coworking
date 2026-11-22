// ⎇ Worktree routes: the busy guard is per project — a turn running elsewhere must not block this project's
// worktree. Pure router calls with a fake hub (no server, no git): the guard answers before git is ever reached.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRouter } from '../src/routes/index.js';

const router = buildRouter();

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

const call = async (p, body, ctx) => {
  const m = router.match('POST', p);
  assert.ok(m, `${p} harus terdaftar`);
  const res = fakeRes();
  await m.route.handler(ctx, { headers: {} }, res, m.params, body);
  return res;
};

/** A context whose hub knows one project; `busyId` gets a running turn, other ids stay idle. */
const ctxWith = (busyId) => ({
  hub: {
    projects: new Map([['p1', { id: 'p1', path: '/tmp/nowhere-repo', name: 'p1', sources: ['custom'] }]]),
    worktreeOf: () => null,
    workspacePathFor: () => '/tmp/nowhere-repo',
    setWorktree: () => {},
    chat: () => {},
  },
  sessions: { sessions: new Map(busyId ? [[busyId, { turnActive: () => true }]] : []) },
});

test('busy guard: giliran di project lain tidak memblokir worktree project ini', async () => {
  const other = await call('/api/projects/p1/worktree-create', { name: 'x' }, ctxWith('p2'));
  assert.notEqual(other.status, 409, 'project lain yang sibuk bukan alasan 409');
});

test('busy guard: giliran project ini sendiri tetap menolak 409 busy', async () => {
  const mine = await call('/api/projects/p1/worktree-create', { name: 'x' }, ctxWith('p1'));
  assert.equal(mine.status, 409, JSON.stringify(mine.json()));
  assert.equal(mine.json().code, 'busy');
  const enter = await call('/api/projects/p1/worktree-enter', { name: 'x' }, ctxWith('p1'));
  assert.equal(enter.status, 409);
  assert.equal(enter.json().code, 'busy');
});
