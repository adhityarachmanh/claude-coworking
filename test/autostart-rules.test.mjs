// The sentence a paired phone sees in ⚙ → Sistem about the next reboot: is auto-start/autologon ready, and what is
// still a one-time job at the PC? Pure, so this is testable without a Windows machine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laptopBootNote } from '../public/js/core/autostart-rules.js';

test('laptopBootNote: supported platforms only, and the unsafe direction always wins', () => {
  assert.equal(laptopBootNote({}), '');
  assert.equal(laptopBootNote({ supported: false, enabled: true }), '');
  const unsafe = laptopBootNote({ supported: true, enabled: true, mode: 'login', autologon: 'on', unsafeDesktop: true });
  assert.match(unsafe, /desktop terbuka/i);
  assert.match(unsafe, /Matikan dari laptop/i);
});

test('laptopBootNote: a ready PC is a clear yes; the missing half names the one-time steps at the PC', () => {
  const ready = laptopBootNote({ supported: true, enabled: true, mode: 'boot', autologon: 'on' });
  assert.match(ready, /menyalakan server lagi setelah reboot/i);
  assert.match(ready, /tidak perlu disentuh/i);

  const login = laptopBootNote({ supported: true, enabled: true, mode: 'login', autologon: 'off' });
  assert.match(login, /hanya berjalan setelah login Windows/i);
  assert.match(login, /Sekali di PC/i);
  assert.match(login, /bukan PIN/i);

  const bootNoAuto = laptopBootNote({ supported: true, enabled: true, mode: 'boot', autologon: 'off' });
  assert.match(bootNoAuto, /Nyalakan otomatis sudah terpasang/i);
  assert.match(bootNoAuto, /login otomatis Windows belum aktif/i);

  const off = laptopBootNote({ supported: true, enabled: false, mode: 'login', autologon: 'off' });
  assert.match(off, /belum menyalakan diri setelah reboot/i);
  assert.match(off, /Nyalakan otomatis saat Windows login/i);
  assert.match(off, /Akses saat PC terkunci/i);

  const half = laptopBootNote({ supported: true, enabled: true, mode: 'boot', autologon: 'unknown' });
  assert.match(half, /login otomatis Windows belum aktif/i);
});
