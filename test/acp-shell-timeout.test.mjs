// 🖥️ OpenCode 2.3.1+: "a shell command still running when its timeout expires now moves to the background instead of
// being killed, so long builds and test runs finish and report back" (opencode.ai/changelog/v2.3.1, #63699).
// The announcement reaches Adhitron as TOOL OUTPUT TEXT, not metadata, so the wording is what the detector must know.
// The installed build here is 2.3.0 (the plain wording); the timeout wording is accepted ahead of the upgrade, and an
// announcement without a shell id is ignored — a task nobody can finish must never be invented.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpAdapter } from '../src/acp-session.js';

const adapter = () => new AcpAdapter(() => {});
const adopt = (text) => {
  const info = {};
  adapter().adoptBackgroundShell(info, text);
  return info.meta ?? null;
};

test('teks 2.2.5/2.3.0 ("moved to the background") tetap dikenali', () => {
  const meta = adopt('Command moved to the background (shell ID: sh_abc123). PID: 4242');
  assert.equal(meta.shellID, 'sh_abc123');
  assert.equal(meta.background, true);
  assert.equal(meta.pid, 4242);
});

test('teks 2.3.1 timeout→background juga dikenali (tidak dianggap selesai/dibunuh)', () => {
  const meta = adopt('Command timed out after 120s and was moved to the background (shell ID: sh_xyz789). PID: 99');
  assert.ok(meta, 'harus menjadi tugas latar, bukan dianggap gagal');
  assert.equal(meta.shellID, 'sh_xyz789');
  assert.equal(meta.background, true);
  assert.equal(meta.pid, 99);

  const other = adopt('The command exceeded its timeout; it keeps running in the background (shell ID: sh_q1).');
  assert.equal(other?.shellID, 'sh_q1', 'rumusan lain yang menyebut timeout + background tetap ditangkap');
});

test('pengumuman tanpa shell ID diabaikan (tidak membuat task yang tak bisa ditutup)', () => {
  assert.equal(adopt('Command moved to the background.'), null);
  assert.equal(adopt('timed out, still running in background'), null);
});

test('kegagalan biasa bukan tugas latar; metadata yang sudah ada tidak ditimpa', () => {
  assert.equal(adopt('Command failed: timeout of 30000ms exceeded'), null);
  const info = { meta: { shellID: 'sh_existing' } };
  adapter().adoptBackgroundShell(info, 'Command moved to the background (shell ID: sh_other). PID: 7');
  assert.equal(info.meta.shellID, 'sh_existing', 'metadata menang');
});
