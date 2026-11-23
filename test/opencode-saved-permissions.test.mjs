// OpenCode's durable "Allow always" permissions (permission.saved.*): the app can list and forget them, which the
// terminal only does inside its permission dialog. A fake CLI prints the OpenAPI payload shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listSavedPermissions, removeSavedPermission } from '../src/opencode-admin.js';

const fake = (operation) => ({
  command: process.execPath,
  args: ['-e', `if (process.argv[2] === ${JSON.stringify(operation)}) console.log(${JSON.stringify(JSON.stringify({ data: [{ id: 'per_1', projectID: 'prj_1', action: 'shell', resource: 'git push *', time: { created: 1, updated: 2 } }] }))});`],
});

test('listSavedPermissions: membaca data izin tersimpan dan membuang bentuk asing', async () => {
  const rows = await listSavedPermissions(fake('permission.saved.list'));
  assert.deepEqual(rows, [{ id: 'per_1', projectID: 'prj_1', action: 'shell', resource: 'git push *', created: 1, updated: 2 }]);
});

test('removeSavedPermission: menolak id aneh sebelum menjalankan CLI', async () => {
  await assert.rejects(removeSavedPermission(fake('permission.saved.remove'), '../x'), (e) => e.status === 400);
  assert.deepEqual(await removeSavedPermission(fake('permission.saved.remove'), 'per_1'), { removed: true });
});
