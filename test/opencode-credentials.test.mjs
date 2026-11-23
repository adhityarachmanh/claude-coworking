// OpenCode stored credentials: credential.list for the active account per provider, credential.activate to switch.
// The credential payload holds keys/tokens; only identity and state may leave the module.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCodeActivateCredential, openCodeCredentials } from '../src/opencode-auth.js';

const fake = (operation, payload) => ({
  command: process.execPath,
  args: ['-e', `if (process.argv[2] === ${JSON.stringify(operation)}) console.log(${JSON.stringify(JSON.stringify(payload))});`],
});

test('openCodeCredentials: tidak pernah membocorkan key/token, active ikut', async () => {
  const rows = await openCodeCredentials(
    fake('credential.list', {
      data: [
        { id: 'cred_1', integrationID: 'openai', label: 'Kerja', active: true, value: { type: 'key', key: 'sk-rahasia' } },
        { id: 'cred_2', integrationID: 'openai', label: 'Pribadi', active: false, value: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, methodID: 'm' } },
        { id: 'x', integrationID: 'bad id', label: 'x', active: false, value: { type: 'key', key: 'k' } },
      ],
    }),
  );
  assert.deepEqual(rows, [
    { id: 'cred_1', integrationID: 'openai', label: 'Kerja', active: true, type: 'key' },
    { id: 'cred_2', integrationID: 'openai', label: 'Pribadi', active: false, type: 'oauth' },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /rahasia|refresh/i);
});

test('openCodeActivateCredential: memanggil credential.activate, id aneh ditolak', async () => {
  assert.deepEqual(await openCodeActivateCredential(fake('credential.activate', { data: null }), 'cred_1'), { ok: true });
  await assert.rejects(openCodeActivateCredential(fake('credential.activate', {}), '../x'), (e) => e.status === 400);
});
