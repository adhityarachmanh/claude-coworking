// 🖥️ Installer "server hidup sebelum login Windows" (installer/Adhitron.iss): the bootmode task, the password
// page, the [Run] hand-over to `Adhitron.exe --autologon-enable`, and the promise that the temporary password file
// never survives. Source-string checks only (same pattern as test/firewall-check.test.mjs): the installer is never
// compiled or executed here, no UAC prompt is ever raised, and a real password never appears in this file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ISS = readFileSync(path.join(APP, 'installer', 'Adhitron.iss'), 'utf8');
const LINES = ISS.split(/\r?\n/);
const CODE = ISS.slice(ISS.indexOf('[Code]'));
// The helper's own source of truth: exactly the names it will read back and delete.
const HELPER = readFileSync(path.join(APP, 'src', 'autologon.js'), 'utf8');
const SECRET_PATTERN_SOURCE = HELPER.match(/const SECRET_PATTERN = \/(.+)\/;/)?.[1];

const bootTask = () => LINES.find((line) => /^Name:\s*"bootmode"/.test(line.trim()));
// The single [Run] line that hands the password to the app (comments also mention the flag, so skip them).
const bootRun = () => LINES.find((line) => line.trim().startsWith('Filename:') && line.includes('--autologon-enable'));

test('task bootmode: unchecked by default, never offered on silent installs, honest about the trade-off', () => {
  const task = bootTask();
  assert.ok(task, 'task "bootmode" ada di [Tasks]');
  assert.match(task, /Flags:.*\bunchecked\b/, 'default tidak dicentang: autologon itu pilihan sadar');
  assert.ok(!/checkedonce/.test(task), 'bukan checkedonce');
  // Inno's [Tasks] flag list has no skipifsilent (ISCC: "Flags includes an unknown flag"), so the silent guarantee
  // lives where Inno does support it: the wizard never shows the tasks page in silent mode, the run entry is
  // skipifsilent, and BootModeSelected() also refuses WizardSilent.
  assert.ok(!/Name: "bootmode".*skipifsilent/.test(ISS), 'skipifsilent pada [Tasks] tidak bisa dikompilasi');
  assert.match(bootRun(), /skipifsilent/, 'entry yang benar-benar berjalan (dan meminta izin) dilewati saat senyap');
  assert.match(CODE, /function BootModeSelected: Boolean;[\s\S]{0,200}not WizardSilent/, 'penjaga kedua: tidak pernah aktif saat senyap');
  assert.match(task, /registry/i, 'deskripsi jujur: sandi Windows disimpan di registry');
  assert.match(task, /15 detik/, 'deskripsi jujur: layar terkunci otomatis 15 detik setelah logon');
});

test('password page: only when bootmode is checked and the wizard is not silent', () => {
  assert.match(ISS, /CreateInputQueryPage\(/, 'halaman input memakai CreateInputQueryPage');
  const wizard = CODE.slice(CODE.indexOf('procedure InitializeWizard'), CODE.indexOf('function ShouldSkipPage'));
  assert.equal(wizard.match(/BootModePage\.Add\(/g)?.length, 1, 'tepat satu field');
  assert.match(wizard, /Edits\[0\]\.Password := True/, 'field sandi disamarkan');
  // Inno has no PasswordChar on TInputQueryWizardPage.Edits (TPasswordEdit): Password := True sets the '*' mask.
  assert.ok(!/PasswordChar/.test(CODE), 'PasswordChar tidak ada di Pascal Script TPasswordEdit (gagal kompilasi)');
  assert.match(ISS, /WizardIsTaskSelected\('bootmode'\)/, 'halaman mengikuti pilihan task bootmode');
  assert.match(ISS, /WizardSilent/, 'tidak pernah muncul pada instalasi senyap');
  assert.match(CODE, /function ShouldSkipPage\(PageID: Integer\): Boolean;/, 'halaman dilewati, bukan dibuat bersyarat (bisa kembali)');
  assert.ok(!/DefaultPassword/i.test(ISS), 'sandi tidak pernah ditulis di .iss');
});

test('run entry: hands over to Adhitron.exe --autologon-enable, paths only, wait + hidden + skipifsilent', () => {
  const run = bootRun();
  assert.ok(run, 'ada entry [Run] untuk bootmode');
  assert.ok(run.includes('{#MyAppExeName}') || run.includes('Adhitron.exe'), 'menjalankan exe aplikasi yang sama');
  for (const token of ['--autologon-enable', '--password-file', '--user', '--domain']) {
    assert.ok(run.includes(token), `parameter ${token} ada`);
  }
  for (const flag of ['runhidden', 'waituntilterminated', 'skipifsilent', 'Check:']) {
    assert.ok(run.includes(flag), `flag ${flag} ada`);
  }
  assert.ok(!run.includes('postinstall'), 'bukan postinstall: harus selesai sebelum wizard tutup');
  assert.ok(!/RunAs/i.test(run), 'installer TIDAK menambah UAC kedua: aplikasi meminta izinnya sendiri');
  assert.ok(run.includes("'{code:GetBootModeUser}'") && run.includes("'{code:GetBootModeDomain}'"), 'akun = user yang sedang login');
  // Inno rejects {%USERNAME%}/{%USERDOMAIN%} at compile time ("Invalid environment constant").
  assert.ok(!/\{%USERNAME%\}|\{%USERDOMAIN%\}/.test(ISS), 'tanpa konstanta env yang tidak dikenal');
  assert.match(CODE, /ExpandConstant\('\{username\}'\)/, 'user dari GetUserName (bukan env yang bisa dipalsukan)');
  assert.match(CODE, /GetEnv\('USERDOMAIN'\)/, 'domain dari environment saat instalasi');
});

test('run entry: a failure is reported in Indonesian and never fails the installation', () => {
  const run = bootRun();
  assert.ok(run.includes('MessageBox'), 'kegagalan diberitahukan (Inno [Run] sendiri mengabaikan exit code)');
  assert.match(run, /Sandi Windows salah/, 'exit 3: sandi salah');
  assert.match(run, /Registry/, 'exit 4: registry tidak bisa diubah');
  assert.match(run, /Administrator/, 'exit 5: bukan admin / izin tidak diberikan');
  assert.match(run, /dibatalkan/, 'exit 6: permintaan izin dibatalkan');
});

test('the temporary password file matches what the helper accepts and is deleted on every path', () => {
  // src/autologon.js only accepts adhitron-autologon-<hex>.txt directly in os.tmpdir().
  assert.ok(SECRET_PATTERN_SOURCE, 'SECRET_PATTERN helper tidak berubah bentuk');
  const helperName = new RegExp(SECRET_PATTERN_SOURCE);
  assert.match(CODE, /'adhitron-autologon-'/, 'nama file mengikuti SECRET_PREFIX helper');
  // The whole name must stay inside [0-9a-f]: GetDateTimeString must not insert its date/time separators.
  const nameLine = CODE.split(/\r?\n/).find((line) => line.includes('GetDateTimeString('));
  assert.ok(nameLine, 'baris penamaan file ada');
  assert.match(nameLine, /GetDateTimeString\('yyyymmddhhnnsszzz', #0, #0\)/, 'pemisah #0: digit saja, tanpa - atau :');
  assert.ok(!/'(?:-|:)'/.test(nameLine), 'tidak ada - atau : sebagai pemisah waktu');
  assert.ok(helperName.test('adhitron-autologon-20261115094915123.txt'), 'prefix + timestamp digit diterima helper');
  assert.equal(helperName.test('adhitron-autologon-2026-11-15.txt'), false, 'pemisah akan ditolak helper (fail-closed)');
  assert.equal(helperName.test('adhitron-autologon-123456789.txt'), true, 'timestamp sah');
  assert.ok(helperName.test('adhitron-autologon-abcdef0123456789.txt'), 'hex huruf kecil juga sah');
  assert.match(CODE, /GetEnv\('TEMP'\)/, 'diletakkan langsung di %TEMP% (os.tmpdir()), bukan subfolder {tmp}');
  assert.match(CODE, /SaveStringToFile\(BootModePasswordFile, Utf8Encode\(/, 'UTF-8 tanpa BOM dan tanpa newline, apa adanya');
  assert.ok(!/SaveStringsToUTF8File/.test(CODE), 'bukan varian array: itu menambah line break di akhir sandi');
  assert.match(CODE, /DeleteFile\(BootModePasswordFile\)/, 'file sementara dihapus');
  assert.match(CODE, /procedure DeinitializeSetup\(\)?;[\s\S]{0,400}DeleteBootModePassword/, 'dihapus saat wizard tutup: sukses, gagal, batal, maupun silent');
  const writeFn = CODE.slice(CODE.indexOf('function WriteBootModePassword'), CODE.indexOf('function GetBootModePasswordFile'));
  assert.ok(writeFn.indexOf('DeleteBootModePassword;') >= 0 && writeFn.indexOf('DeleteBootModePassword;') < writeFn.indexOf('SaveStringToFile('), 'sisa percobaan sebelumnya dibersihkan sebelum menulis');
  assert.match(CODE, /BootModePage\.Edits\[0\]\.Text := ''/, 'sandi dikosongkan dari form setelah ditulis ke file');
});

test('bootmode keeps exactly one login entry point: the autostart shortcut follows it', () => {
  const startupLines = LINES.filter((line) => line.includes('{userstartup}') && line.includes('Tasks:'));
  assert.equal(startupLines.length, 1, 'hanya satu shortcut Startup');
  assert.match(startupLines[0], /Tasks: autostart or bootmode/, 'bootmode ikut membuat shortcut login tanpa entri kedua');
});

test('the existing firewall [UninstallRun] is untouched and still the only RunAs line', () => {
  assert.ok(LINES.some((line) => line.includes('firewalltailscale') && line.includes('Start-Process')), 'baris firewall tetap ada');
  const directive = (line) => !/^\s*[;\/]/.test(line);  // ignore comments
  const withRunAs = LINES.filter((line) => directive(line) && /RunAs/.test(line));
  assert.equal(withRunAs.length, 1, 'hanya firewall yang memakai Start-Process -Verb RunAs');
});
