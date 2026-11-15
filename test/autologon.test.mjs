// 🔐 Autologon (src/autologon.js): helper elevated + CLI (`--autologon-enable` / `--autologon-disable`).
//
// Semua proses di-inject: `spawn` (Start-Process -Verb RunAs) dan `execFileSync` (powershell -File, reg query, net
// session, schtasks) adalah stub. Jadi tes ini tidak pernah memunculkan UAC, tidak pernah menulis registry, tidak
// menyentuh folder Startup pengguna, dan tidak menyentuh Task Scheduler asli.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { enableAutologon, helperMain, lockTaskCheckScript, relaunchOf, sweepLeftoverSecrets, windowsAccount, winlogonScript } from '../src/autologon.js';
import { lockTaskXml, startupDirOf } from '../src/autostart.js';

const SECRET = 'R4has1a!SandiWindows';
const LOCK_TASK = 'Adhitron Lock';
// The account helperMain has to accept: the one this test process runs under (`--user`/`--domain` are checked, S1).
const ME = windowsAccount();
/** A stand-in for this session's SID (`whoami /user`); the real one is machine-specific. */
const TEST_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const accountArgs = () => ['--user', ME.user, '--domain', ME.domain];

const DIRS = [];
after(() => DIRS.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

/** A fake machine: temp tmp/Startup/app folders, so nothing real is read or written. */
function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'adhitron-autologon-test-'));
  DIRS.push(root);
  const tmp = path.join(root, 'tmp');
  const startupDir = path.join(root, 'Startup');
  const appDir = path.join(root, 'app');
  for (const dir of [tmp, startupDir, appDir]) mkdirSync(dir, { recursive: true });
  return { root, tmp, startupDir, appDir };
}

/** The temp file this module creates for the password (name pattern is part of the contract). */
function secretFileIn(dir, hex = 'a1b2c3d4e5f6a7b8') {
  const file = path.join(dir, `adhitron-autologon-${hex}.txt`);
  writeFileSync(file, SECRET);
  return file;
}

/**
 * `spawn` stub: records the call, optionally inspects the machine at that moment, then emits exactly one of
 * 'error' (spawn failed: no PowerShell) or 'close' - or nothing at all (`never`), like a process an antivirus
 * holds. `kill` is recorded so the timeout path (S6) can prove it asked the child to stop.
 */
function fakeSpawn({ code = 0, signal = null, stderr = '', error = null, never = false, onCall } = {}) {
  const calls = [];
  const children = [];
  const spawn = (file, args = [], options = {}) => {
    const call = { file, args, options };
    calls.push(call);
    if (onCall) onCall(call);
    const listeners = new Map();
    const stderrHandlers = [];
    const child = {
      killed: false,
      stderr: {
        on: (event, handler) => {
          if (event === 'data') stderrHandlers.push(handler);
        },
      },
      on: (event, handler) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
        return child;
      },
      kill: () => {
        child.killed = true;
      },
    };
    children.push(child);
    if (!never) {
      queueMicrotask(() => {
        if (stderr) for (const handler of stderrHandlers) handler(Buffer.from(stderr));
        const [event, ...detail] = error ? ['error', error] : ['close', code, signal];
        for (const handler of listeners.get(event) ?? []) handler(...detail);
      });
    }
    return child;
  };
  return { spawn, calls, children };
}

const commandOf = (call) => call.args[call.args.indexOf('-Command') + 1];

/** The password file named on the elevated command line. */
function passwordFileIn(command) {
  const match = /--password-file\s+"?([^"\s]+)"?/.exec(command);
  return match ? match[1] : null;
}

/** `execFileSync` stub: answers `reg query` and the lock-task queries (for the real autostartStatus). */
function fakeExec({ autoAdminLogon = null, lockTask = true, powershellStatus = 0 } = {}) {
  const calls = [];
  const exec = (file, args = [], options = {}) => {
    calls.push({ file, args, options });
    if (file === 'powershell.exe') {
      if (powershellStatus !== 0) {
        const error = new Error(`PowerShell exited ${powershellStatus}`);
        error.status = powershellStatus;
        throw error;
      }
      return '';
    }
    if (file === 'schtasks') {
      const index = args.indexOf('/TN');
      if (lockTask && index >= 0 && args[index + 1] === LOCK_TASK) return '';
      throw new Error('ERROR: The system cannot find the file specified.');
    }
    if (file === 'reg') {
      if (autoAdminLogon === null) throw new Error('ERROR: The system was unable to find the specified registry key or value.');
      return `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\r\n    AutoAdminLogon    REG_SZ    ${autoAdminLogon}\r\n`;
    }
    if (file === 'whoami') {
      if (args.includes('/user')) return `"${ME.domain}\\${ME.user}","${TEST_SID}"\r\n`;
      throw new Error('ERROR: whoami: argumen tidak diharapkan di tes ini.');
    }
    throw new Error(`ERROR: ${file} tidak diharapkan di tes ini.`);
  };
  return { exec, calls };
}

/** The status Windows reports when autologon really is on and the lock task is installed (M8). */
const onStatus = () => ({ autologon: 'on', mode: 'boot', unsafeDesktop: false });

/**
 * The script the elevated helper actually ran (`-File <ps1>`), captured before helperMain deletes it. Also answers
 * the C2 identity check (`powershell -Command Get-ScheduledTask …`): `verify:false` makes it fail (exit 4 in the
 * helper), `schtasksCreate:'fail'` makes the lock task installation itself fail (I1), and `autoAdminLogon` is what
 * `reg query` reports afterwards (`null`: the value cannot be read at all).
 */
function scriptRunner({ status = 0, verify = true, schtasksCreate = 'ok', autoAdminLogon = '0' } = {}) {
  const calls = [];
  let script = '';
  let scriptPath = '';
  let taskXml = '';
  const exec = (file, args = [], options = {}) => {
    calls.push({ file, args, options });
    if (file === 'whoami') {
      return args.includes('/user') ? `"${ME.domain}\\${ME.user}","${TEST_SID}"\r\n` : '';
    }
    if (file === 'reg') {
      if (autoAdminLogon === null) throw new Error('ERROR: Access is denied.');
      return `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\r\n    AutoAdminLogon    REG_SZ    ${autoAdminLogon}\r\n`;
    }
    if (file === 'powershell.exe') {
      const fileIndex = args.indexOf('-File');
      // C2: `-Command Get-ScheduledTask ... Principal.UserId` — a throw means "not verified".
      if (fileIndex === -1) {
        if (!verify) {
          const error = new Error('ERROR: The system cannot find the task.');
          error.status = 4;
          throw error;
        }
        return '';
      }
      scriptPath = args[fileIndex + 1];
      script = readFileSync(scriptPath, 'utf8');
      if (status !== 0) {
        const error = new Error(`PowerShell exited ${status}`);
        error.status = status;
        throw error;
      }
      return '';
    }
    if (file === 'schtasks') {
      if (args.includes('/Create') && schtasksCreate === 'fail') {
        const error = new Error('ERROR: Access is denied.');
        error.status = 1;
        throw error;
      }
      // schtasks /Create ... /XML <file>: read the definition before installLockTask deletes it.
      if (args.includes('/XML')) taskXml = readFileSync(args[args.indexOf('/XML') + 1], 'utf16le').replace(/^\uFEFF/, '');
    }
    return '';
  };
  return { exec, calls, script: () => script, scriptPath: () => scriptPath, taskXml: () => taskXml };
}

test('skrip elevated tidak pernah memuat sandi', () => {
  const script = winlogonScript();

  assert.ok(!script.includes(SECRET), 'sandi tidak boleh masuk skrip: file PowerShell bisa dibaca siapa saja');
  assert.match(script, /\[string\]\$PasswordFile/, 'sandi hanya lewat -PasswordFile');
  assert.match(script, /\[string\]\$User/);
  assert.match(script, /\[string\]\$Domain/);
  assert.match(script, /Get-ScheduledTask -TaskName 'Adhitron Lock'/, 'tanpa task pengunci, registry tidak boleh disentuh');
  assert.doesNotMatch(script, /adhitron-lock\.vbs/, 'pengunci layar bukan file .vbs lagi');
  assert.match(script, /ReadAllText\(\$PasswordFile\)/, 'sandi dibaca dari file, bukan dari argumen');
});

test('sandi salah: exit 3 dan registry tidak disentuh', async () => {
  const script = winlogonScript();
  const validate = script.indexOf('$logon::LogonUser(');
  const firstWrite = script.indexOf("SetValue('DefaultUserName'");
  const deleteFile = script.indexOf('Remove-Item -LiteralPath $PasswordFile');

  assert.ok(validate > 0, 'skrip harus memvalidasi sandi dengan LogonUser');
  assert.ok(deleteFile > 0 && deleteFile < firstWrite, 'file sandi dihapus sebelum tulisan registry pertama');
  assert.ok(validate < firstWrite, 'LogonUser harus sebelum SetValue pertama: sandi salah = registry utuh');
  assert.ok(!script.slice(0, validate).includes('SetValue('), 'tidak boleh ada tulisan registry sebelum validasi');
  assert.match(script, /if \(-not \$logon::LogonUser\([^\r\n]*\) \{ \$plain = \$null; exit 3 \}/, 'sandi salah keluar dengan kode 3');

  // Urutan nilai (M2): user → domain → DefaultPassword, lalu `AutoAdminLogon=1` sebagai SAKLAR paling akhir.
  const order = ['DefaultUserName', 'DefaultDomainName', 'DefaultPassword', 'AutoAdminLogon']
    .map((value) => script.indexOf(`SetValue('${value}'`));
  assert.ok(order.every((index) => index > firstWrite - 1), 'semua nilai registry harus ditulis');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'AutoAdminLogon wajib paling akhir');

  // Helper meneruskan kode 3 dari PowerShell, dan tetap membersihkan file sandi.
  const box = sandbox();
  const file = secretFileIn(box.tmp);
  const ps = scriptRunner({ status: 3 });
  const code = await helperMain(
    ['node', 'server.js', '--autologon-enable', '--password-file', file, ...accountArgs(),
      '--app-dir', box.appDir, '--port', '4317'],
    // startupDir: sandbox, so the 1.0.33 leftover cleanup never looks at the real Startup folder.
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  assert.equal(code, 3, 'sandi salah = exit 3');
  assert.ok(!existsSync(file), 'file sandi harus terhapus walau validasi gagal');
  assert.ok(!existsSync(ps.scriptPath()), 'skrip sementara harus terhapus');
  assert.ok(ps.script().includes('LogonUser'), 'yang dijalankan adalah skrip LogonUser, bukan perintah reg add');
});

test('akun Microsoft memakai domain MicrosoftAccount', async () => {
  assert.deepEqual(windowsAccount('adhit', 'adhit@outlook.com'), { user: 'adhit@outlook.com', domain: 'MicrosoftAccount' });
  assert.deepEqual(windowsAccount('adhit', ''), { user: 'adhit', domain: os.hostname() });
  assert.deepEqual(windowsAccount('  adhit  '), { user: 'adhit', domain: os.hostname() });

  const box = sandbox();
  const { spawn, calls } = fakeSpawn({ code: 0 });
  await enableAutologon({
    password: SECRET,
    appDir: box.appDir,
    port: 4317,
    spawn,
    exec: fakeExec().exec,
    tmpdir: box.tmp,
    user: 'adhit',
    upn: 'adhit@outlook.com',
    status: onStatus,
  });

  const command = commandOf(calls[0]);
  assert.match(command, /--user "?adhit@outlook\.com"?/, 'user = alamat email akun Microsoft');
  assert.match(command, /--domain "?MicrosoftAccount"?/, 'domain wajib MicrosoftAccount');
});

test('enable menulis file sandi 0600 dan menghapusnya di finally', async () => {
  const box = sandbox();
  const seen = [];
  const { spawn, calls } = fakeSpawn({
    code: 0,
    onCall: (call) => {
      const file = passwordFileIn(commandOf(call));
      seen.push({
        file,
        exists: file ? existsSync(file) : false,
        content: file && existsSync(file) ? readFileSync(file, 'utf8') : null,
        mode: file && existsSync(file) ? statSync(file).mode & 0o777 : null,
      });
    },
  });

  const result = await enableAutologon({
    password: SECRET,
    appDir: box.appDir,
    port: 4317,
    spawn,
    exec: fakeExec({ autoAdminLogon: '1' }).exec,
    tmpdir: box.tmp,
    user: 'adhit',
    status: onStatus,
  });

  assert.deepEqual(result, { ok: true, verified: true });
  assert.equal(seen.length, 1, 'satu proses elevated, satu UAC');
  assert.equal(path.dirname(seen[0].file), box.tmp, 'file sandi hanya di folder temp pengguna');
  assert.match(path.basename(seen[0].file), /^adhitron-autologon-[0-9a-f]+\.txt$/);
  assert.equal(seen[0].content, SECRET, 'isi file = sandi, tanpa newline');
  if (process.platform !== 'win32') assert.equal(seen[0].mode, 0o600, 'hanya pemilik yang boleh membaca');
  assert.ok(!existsSync(seen[0].file), 'file sandi harus terhapus sebelum fungsi kembali');

  // Tidak ada jalur yang membawa sandi selain file itu: command line hanya berisi path-nya.
  for (const arg of calls[0].args) assert.ok(!arg.includes(SECRET), 'sandi tidak boleh muncul di argumen proses');
  assert.match(commandOf(calls[0]), /--autologon-enable/);
  assert.match(commandOf(calls[0]), /-Verb RunAs -Wait -PassThru/);
});

test('UAC dibatalkan (1223) dilaporkan cancelled, bukan error', async () => {
  const box = sandbox();
  const noStatus = () => {
    throw new Error('status tidak boleh dibaca saat UAC dibatalkan');
  };

  const cancelled = await enableAutologon({
    password: SECRET,
    appDir: box.appDir,
    spawn: fakeSpawn({ code: 1223 }).spawn,
    exec: fakeExec().exec,
    tmpdir: box.tmp,
    user: 'adhit',
    status: noStatus,
  });
  assert.deepEqual(cancelled, { ok: false, cancelled: true });
  assert.equal(readdirSync(box.tmp).filter((name) => name.endsWith('.txt')).length, 0, 'file sandi tetap dibersihkan');

  // PowerShell juga melaporkan batal sebagai error biasa (kode 1 + teks 1223).
  const fromText = await enableAutologon({
    password: SECRET,
    appDir: box.appDir,
    spawn: fakeSpawn({ code: 1, stderr: 'Start-Process : This command cannot be run due to the error: The operation was canceled by the user. (1223)' }).spawn,
    exec: fakeExec().exec,
    tmpdir: box.tmp,
    user: 'adhit',
    status: noStatus,
  });
  assert.deepEqual(fromText, { ok: false, cancelled: true });
});

test('setelah enable, status harus membaca autologon on', async () => {
  const box = sandbox();
  const base = {
    password: SECRET,
    appDir: box.appDir,
    port: 4317,
    spawn: fakeSpawn({ code: 0 }).spawn,
    tmpdir: box.tmp,
    user: 'adhit',
  };

  // Status asli (autostartStatus) membaca `reg query`: 1 = Windows benar-benar akan login sendiri.
  const on = await enableAutologon({ ...base, exec: fakeExec({ autoAdminLogon: '1' }).exec });
  assert.deepEqual(on, { ok: true, verified: true });

  // Exit code 0 tapi Windows masih bilang 0/missing: jangan pernah mengaku sudah menyala.
  await assert.rejects(
    () => enableAutologon({ ...base, exec: fakeExec({ autoAdminLogon: '0' }).exec }),
    (err) => {
      assert.equal(err.code, 'unverified');
      assert.match(err.message, /belum aktif/i);
      return true;
    },
  );
  await assert.rejects(() => enableAutologon({ ...base, exec: fakeExec({ autoAdminLogon: null }).exec }), /belum aktif/i);

  // M8: autologon on tapi task pengunci tidak ada = desktop bisa terbuka. Jangan pernah dianggap sukses.
  await assert.rejects(
    () => enableAutologon({ ...base, exec: fakeExec({ autoAdminLogon: '1', lockTask: false }).exec }),
    (err) => {
      assert.equal(err.code, 'unverified');
      assert.match(err.message, /pengunci layar/i);
      return true;
    },
  );
});

test('sandi salah dari helper dipetakan ke error wrong-password', async () => {
  const box = sandbox();
  await assert.rejects(
    () => enableAutologon({
      password: SECRET,
      appDir: box.appDir,
      spawn: fakeSpawn({ code: 3 }).spawn,
      exec: fakeExec().exec,
      tmpdir: box.tmp,
      user: 'adhit',
      status: () => ({ autologon: 'off' }),
    }),
    (err) => {
      assert.equal(err.code, 'wrongPassword');
      assert.equal(err.message, 'Sandi Windows salah.');
      return true;
    },
  );
});

test('enable menolak platform non-Windows dan sandi kosong tanpa menjalankan proses', async () => {
  const box = sandbox();
  const { spawn, calls } = fakeSpawn({ code: 0 });

  await assert.rejects(() => enableAutologon({ password: SECRET, appDir: box.appDir, spawn, platform: 'linux' }), /Windows/);
  await assert.rejects(() => enableAutologon({ password: '', appDir: box.appDir, spawn, platform: 'win32', tmpdir: box.tmp }), /wajib diisi/);
  assert.equal(calls.length, 0, 'tidak ada UAC untuk input yang tidak valid');
});

test('helper elevated memasang task pengunci layar sebelum registry', async () => {
  const box = sandbox();
  const file = secretFileIn(box.tmp);
  const ps = scriptRunner({ status: 0 });

  const code = await helperMain(
    ['node', 'server.js', '--autologon-enable', '--password-file', file, ...accountArgs(),
      '--app-dir', box.appDir, '--port', '4317'],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  assert.equal(code, 0);
  // Task pengunci dipasang SEBELUM skrip PowerShell yang menulis AutoAdminLogon.
  const create = ps.calls.findIndex((c) => c.file === 'schtasks' && c.args.includes('/Create'));
  const verify = ps.calls.findIndex((c) => c.file === 'powershell.exe' && c.args.includes('-Command') && String(c.args).includes('Get-ScheduledTask'));
  const registry = ps.calls.findIndex((c) => c.file === 'powershell.exe' && c.args.includes('-File'));
  assert.ok(create >= 0, 'schtasks /Create untuk pengunci layar wajib dipanggil');
  assert.ok(verify > create, 'C2: identitas task diverifikasi setelah dipasang');
  assert.ok(verify < registry, 'C2: verifikasi harus sebelum registry diubah');
  assert.equal(ps.calls[create].args[ps.calls[create].args.indexOf('/TN') + 1], LOCK_TASK);
  assert.match(ps.taskXml(), /user32\.dll,LockWorkStation/);
  assert.match(ps.taskXml(), /<Delay>PT15S<\/Delay>/);
  // C2: task milik akun yang akan login, bukan milik administrator yang menjawab UAC.
  assert.match(ps.taskXml(), new RegExp(`<UserId>${ME.domain}\\\\${ME.user}</UserId>`));
  assert.ok(!existsSync(path.join(box.startupDir, 'adhitron-lock.vbs')), 'tidak ada file .vbs yang ditulis');

  assert.ok(!existsSync(file), 'file sandi terhapus');
  assert.ok(!existsSync(ps.scriptPath()), 'skrip sementara terhapus');
  assert.match(path.basename(ps.scriptPath()), /^adhitron-autologon-[0-9a-f]{32}\.ps1$/, 'M5: nama acak 128-bit');
  assert.match(ps.script(), /LogonUser/);

  const call = ps.calls[registry];
  assert.equal(call.file, 'powershell.exe');
  assert.ok(call.args.includes('-NonInteractive'), 'tidak boleh menggantung menunggu input');
  assert.deepEqual(call.args.slice(call.args.indexOf('-PasswordFile'), call.args.indexOf('-PasswordFile') + 2), ['-PasswordFile', file]);
  assert.ok(!call.args.includes('-Startup'), 'skrip tidak lagi butuh folder Startup');
});

test('C2 membandingkan SID, bukan tulisan nama akun', async () => {
  const box = sandbox();
  const file = secretFileIn(box.tmp);
  const ps = scriptRunner({ status: 0 });

  await helperMain(
    ['node', 'server.js', '--autologon-enable', '--password-file', file, ...accountArgs(),
      '--app-dir', box.appDir, '--port', '4317'],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  const script = String(ps.calls.find((c) => c.file === 'powershell.exe' && c.args.includes('-Command'))?.args.at(-1) ?? '');
  // Windows answers `Principal.UserId` with the SHORT name ("adhit") while the task belongs to "ARH\adhit" - or with
  // the SID. Compare identities, not spellings: translate the owner to a SecurityIdentifier.
  assert.match(script, /NTAccount/, 'nama akun harus diterjemahkan ke SID sebelum dibandingkan');
  assert.match(script, /Translate\(\[Security\.Principal\.SecurityIdentifier\]\)/, 'perbandingan lewat SID');
  assert.match(script, new RegExp(`\\$wantSid = '${TEST_SID}'`), 'SID sesi ini (dibaca induk) ikut dikirim');
  assert.match(script, /COMPUTERNAME/, 'nama pendek dianggap akun komputer ini');
  assert.match(script, /WindowsIdentity\]::GetCurrent\(\)\.User\.Value/, 'cadangan bila SID induk tidak terbaca');
});

test('SID sesi ini diteruskan ke salinan elevated lewat --account-sid', async () => {
  const box = sandbox();
  const { spawn, calls } = fakeSpawn({ code: 0 });
  await enableAutologon({
    password: SECRET,
    appDir: box.appDir,
    port: 4317,
    spawn,
    exec: fakeExec().exec,
    tmpdir: box.tmp,
    status: onStatus,
  });

  assert.match(commandOf(calls[0]), new RegExp(`--account-sid "?${TEST_SID}"?`), 'SID induk, bukan SID administrator UAC');
});

test('helper elevated menolak file sandi asing atau di luar folder temp', async () => {
  const box = sandbox();
  const foreign = path.join(box.root, 'adhitron-autologon-deadbeef.txt');
  writeFileSync(foreign, SECRET);
  const wrongName = path.join(box.tmp, 'adhitron-autologon-XX.txt');
  writeFileSync(wrongName, SECRET);

  for (const file of [foreign, wrongName, path.join(box.tmp, 'tidak-ada.txt')]) {
    const ps = scriptRunner();
    const code = await helperMain(
      ['--autologon-enable', '--password-file', file, ...accountArgs()],
      { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp },
    );
    assert.equal(code, 1, `${path.basename(file)} harus ditolak`);
    assert.equal(ps.calls.length, 0, 'tidak ada PowerShell untuk input yang tidak valid');
  }
  assert.ok(existsSync(foreign), 'file asing tidak boleh dihapus');
  assert.ok(existsSync(wrongName));
});

test('helper --autologon-disable mematikan autologon dan melepas pengunci layar', async () => {
  const box = sandbox();
  const ps = scriptRunner({ status: 0 });

  const code = await helperMain(
    ['--autologon-disable', '--app-dir', box.appDir],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp },
  );

  assert.equal(code, 0);
  const script = ps.script();
  assert.match(script, /SetValue\('AutoAdminLogon', '0'/);
  assert.match(script, /DeleteValue\('DefaultPassword'/);
  assert.match(script, /Unregister-ScheduledTask -TaskName 'Adhitron Lock'/, 'task pengunci dilepas bersama autologon');
  assert.doesNotMatch(script, /adhitron-lock\.vbs/, 'tidak ada file .vbs untuk dihapus lagi');
  assert.doesNotMatch(script, /PasswordFile/, 'mematiikan tidak perlu sandi');
});

test('helper tidak elevated meminta UAC sekali dan meneruskan kode keluar', async () => {
  const box = sandbox();
  const notElevated = (file) => {
    if (file === 'net') throw new Error('ERROR: Access is denied.');
    return '';
  };

  const ok = fakeSpawn({ code: 0 });
  const code = await helperMain(
    ['--autologon-disable', '--app-dir', box.appDir],
    { platform: 'win32', execFileSync: notElevated, spawn: ok.spawn, tmpdir: box.tmp },
  );
  assert.equal(code, 0);
  assert.equal(ok.calls.length, 1, 'tepat satu prompt UAC');
  assert.match(commandOf(ok.calls[0]), /--autologon-disable/);
  assert.match(commandOf(ok.calls[0]), /--elevated/, 'penanda supaya tidak minta UAC dua kali');

  const cancelled = fakeSpawn({ code: 1223 });
  const cancelledCode = await helperMain(
    ['--autologon-disable', '--app-dir', box.appDir],
    { platform: 'win32', execFileSync: notElevated, spawn: cancelled.spawn, tmpdir: box.tmp },
  );
  assert.equal(cancelledCode, 6, 'UAC dibatalkan = 6');
});

test('helperMain menolak argv tanpa perintah autologon', async () => {
  await assert.rejects(() => helperMain(['node', 'server.js']), /--autologon-enable/);
  await assert.rejects(() => helperMain(['--autologon-enable', '--autologon-disable']), /tepat satu/);
});

test('startupDirOf memakai folder Startup yang sama dengan autostartStatus', () => {
  const box = sandbox();
  assert.equal(startupDirOf({ appData: box.root }), path.join(box.root, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'));
  assert.equal(startupDirOf({ startupDir: box.startupDir }), box.startupDir);
});

// --- Putaran perbaikan (review independen) -------------------------------------------------------------------

test('S1: --user/--domain akun lain ditolak sebelum UAC, registry tidak ditulis', async () => {
  const box = sandbox();
  const file = secretFileIn(box.tmp);
  const ps = scriptRunner();

  const code = await helperMain(
    ['--autologon-enable', '--password-file', file, '--user', 'administrator', '--domain', ME.domain,
      '--app-dir', box.appDir, '--port', '4317'],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  assert.equal(code, 1, 'akun lain = exit 1');
  assert.equal(ps.calls.length, 0, 'tidak ada PowerShell/schtasks: registry tidak boleh disentuh');
  assert.ok(!existsSync(file), 'file sandi dibersihkan walau request ditolak');

  const otherDomain = secretFileIn(box.tmp, '0f1e2d3c4b5a6978');
  const wrongDomain = await helperMain(
    ['--autologon-enable', '--password-file', otherDomain, '--user', ME.user, '--domain', 'KOMPUTER-LAIN',
      '--app-dir', box.appDir],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
  );
  assert.equal(wrongDomain, 1, 'domain lain = exit 1');
  assert.equal(ps.calls.length, 0);
  assert.ok(!existsSync(otherDomain));
});

test('S1: nama akun dicocokkan tanpa peduli huruf besar/kecil', async () => {
  const box = sandbox();
  const file = secretFileIn(box.tmp);
  const ps = scriptRunner({ status: 0 });

  const code = await helperMain(
    ['--autologon-enable', '--password-file', file, '--user', ME.user.toUpperCase(),
      '--domain', ME.domain.toLowerCase(), '--app-dir', box.appDir, '--port', '4317'],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  assert.equal(code, 0, 'huruf besar/kecil bukan akun lain');
  assert.ok(ps.calls.some((call) => call.file === 'powershell.exe'), 'skrip registry dijalankan');
});

test('S1: akun Microsoft dibandingkan lewat upn, dengan fallback nama akun', async () => {
  const box = sandbox();
  const account = { user: 'adhit', domain: 'MicrosoftAccount' };
  const run = (upn, hex) => {
    const file = secretFileIn(box.tmp, hex);
    return helperMain(
      ['--autologon-enable', '--password-file', file, '--user', 'adhit@outlook.com', '--domain', 'MicrosoftAccount',
        '--app-dir', box.appDir, '--port', '4317'],
      {
        platform: 'win32',
        execFileSync: scriptRunner({ status: 0 }).exec,
        spawn: fakeSpawn().spawn,
        elevated: true,
        tmpdir: box.tmp,
        startupDir: box.startupDir,
        account,
        upn,
      },
    );
  };

  assert.equal(await run('adhit@outlook.com', '1111222233334444'), 0, 'upn cocok');
  assert.equal(await run('orang-lain@outlook.com', '5555666677778888'), 1, 'upn lain ditolak');
  // Windows tidak selalu memberi upn untuk akun Microsoft: nama akun lokal harus cocok dengan bagian lokal email.
  assert.equal(await run('', '9999aaaabbbbcccc'), 0, 'fallback ke nama akun sesi');
});

test('M2: saklar AutoAdminLogon=1 adalah tulisan terakhir, tanpa rollback yang tak terjangkau', () => {
  const script = winlogonScript();
  const passwordWrite = script.indexOf("SetValue('DefaultPassword'");
  const switchWrite = script.indexOf("SetValue('AutoAdminLogon', '1'");
  const exit4 = script.indexOf('exit 4', switchWrite);

  // M2: sandi dan akun lebih dulu, saklar AutoAdminLogon=1 paling akhir.
  assert.ok(passwordWrite > 0, 'DefaultPassword ditulis sebelum saklar');
  assert.ok(switchWrite > passwordWrite, 'AutoAdminLogon=1 adalah tulisan terakhir');
  assert.ok(script.indexOf("SetValue('DefaultUserName'") < switchWrite);
  assert.ok(script.indexOf("SetValue('DefaultDomainName'") < switchWrite);
  // Tidak ada rollback: saklar tidak pernah 1 sebelum tulisan lain berhasil, jadi kegagalan mana pun
  // meninggalkan Windows dengan login normal. (Review: blok `if ($switched)` lama tidak pernah tercapai.)
  assert.equal(script.indexOf("SetValue('AutoAdminLogon', '0'"), -1, 'tidak ada rollback mati di skrip enable');
  assert.doesNotMatch(script, /\$switched/);
  // catch menyerah tanpa menulis apa pun lagi: $plain dibersihkan lalu exit 4.
  const catchBlock = script.slice(switchWrite, exit4);
  assert.match(catchBlock, /\$plain = \$null/, 'sandi tidak tertinggal di variabel');
  assert.match(script, /4: registry write[\s\S]*AutoAdminLogon is the SWITCH and goes LAST/);
});

test('S4: argumen berakhiran backslash tidak menelan argumen berikutnya', async () => {
  const box = sandbox();
  const { spawn, calls } = fakeSpawn({ code: 0 });
  const weird = 'C:\\Folder Dengan Spasi\\';

  await enableAutologon({
    password: SECRET,
    appDir: box.appDir,
    port: 4317,
    spawn,
    exec: fakeExec().exec,
    tmpdir: box.tmp,
    user: weird,
    status: onStatus,
  });

  const command = commandOf(calls[0]);
  assert.match(command, /--user "C:\\Folder Dengan Spasi\\\\" --domain /, `quoting salah: ${command}`);
});

test('S5: UAC dibatalkan saat self-elevation tetap menghapus file sandi', async () => {
  const box = sandbox();
  const file = secretFileIn(box.tmp);
  const notElevated = (name) => {
    if (name === 'net') throw new Error('ERROR: Access is denied.');
    return '';
  };
  const uac = fakeSpawn({ code: 1223 });

  const code = await helperMain(
    ['--autologon-enable', '--password-file', file, ...accountArgs(), '--app-dir', box.appDir, '--port', '4317'],
    { platform: 'win32', execFileSync: notElevated, spawn: uac.spawn, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  assert.equal(code, 6, 'UAC dibatalkan = 6');
  assert.equal(uac.calls.length, 1, 'tepat satu prompt UAC');
  assert.ok(!existsSync(file), 'file sandi tidak boleh bertahan setelah UAC dibatalkan');
});

test('S6: PowerShell yang menggantung dibatasi timeout (bukan menggantung selamanya)', async () => {
  const box = sandbox();
  const { spawn, children } = fakeSpawn({ never: true });

  const result = await enableAutologon({
    password: SECRET,
    appDir: box.appDir,
    port: 4317,
    spawn,
    exec: fakeExec().exec,
    tmpdir: box.tmp,
    user: ME.user,
    timeoutMs: 500,
    status: () => ({ autologon: 'off', mode: 'login', unsafeDesktop: false }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.match(result.error, /Status tidak diketahui/, 'I2: jangan mengarang status saat timeout');
  assert.match(result.error, /Setelan/);
  assert.equal(children[0].killed, true, 'proses yang menggantung harus dihentikan');
  assert.equal(readdirSync(box.tmp).filter((name) => name.endsWith('.txt')).length, 0, 'file sandi dihapus');

  // Jalur helper (belum elevated): timeout bukan sukses.
  const stuckFile = secretFileIn(box.tmp, 'aaaabbbbccccdddd');
  const stuck = fakeSpawn({ never: true });
  const code = await helperMain(
    ['--autologon-enable', '--password-file', stuckFile, ...accountArgs(), '--app-dir', box.appDir],
    {
      platform: 'win32',
      execFileSync: (name) => {
        if (name === 'net') throw new Error('ERROR: Access is denied.');
        return '';
      },
      spawn: stuck.spawn,
      tmpdir: box.tmp,
      timeoutMs: 25,
      startupDir: box.startupDir,
    },
  );
  assert.equal(code, 1, 'timeout bukan sukses');
  assert.ok(!existsSync(stuckFile), 'file sandi tetap dibersihkan');
});

test('S7: file sandi yang gagal dihapus dilaporkan, tanpa mencetak isinya', async () => {
  const box = sandbox();
  const { spawn, calls } = fakeSpawn({ code: 0 });
  const lines = [];
  const original = console.error;
  console.error = (...parts) => lines.push(parts.map(String).join(' '));
  let result;
  try {
    result = await enableAutologon({
      password: SECRET,
      appDir: box.appDir,
      port: 4317,
      spawn,
      exec: fakeExec().exec,
      tmpdir: box.tmp,
      user: ME.user,
      status: onStatus,
      removeFile: () => {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      },
    });
  } finally {
    console.error = original;
  }

  assert.deepEqual(result, { ok: true, verified: true }, 'perubahan tetap dianggap sukses');
  const file = passwordFileIn(commandOf(calls[0]));
  assert.ok(file && existsSync(file), 'file memang tidak terhapus (penghapus di-inject)');
  const warning = lines.find((line) => line.includes('PERINGATAN') && line.includes(file));
  assert.ok(warning, `peringatan wajib muncul, dapat: ${lines.join(' | ')}`);
  assert.match(warning, /EBUSY/);
  assert.ok(!warning.includes(SECRET), 'isi sandi tidak boleh dicetak');
});

test('G4: exit code null tanpa signal dianggap gagal, bukan sukses', async () => {
  const box = sandbox();
  await assert.rejects(
    () => enableAutologon({
      password: SECRET,
      appDir: box.appDir,
      spawn: fakeSpawn({ code: null }).spawn,
      exec: fakeExec().exec,
      tmpdir: box.tmp,
      user: ME.user,
      status: onStatus,
    }),
    (err) => {
      assert.equal(err.code, 'registry');
      assert.match(err.message, /kode tidak ada/);
      return true;
    },
  );
});

test('G1: helper meneruskan exit 4 (registry) dan 5 (bukan admin)', async () => {
  for (const status of [4, 5]) {
    const box = sandbox();
    const file = secretFileIn(box.tmp);
    const ps = scriptRunner({ status });

    const code = await helperMain(
      ['--autologon-enable', '--password-file', file, ...accountArgs(), '--app-dir', box.appDir, '--port', '4317'],
      { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
    );

    assert.equal(code, status, `exit ${status} harus diteruskan apa adanya`);
    assert.ok(!existsSync(file), 'file sandi tetap terhapus');
    assert.ok(!existsSync(ps.scriptPath()), 'skrip sementara tetap terhapus');
  }
});

test('G1: spawn error (PowerShell tidak ada) tetap menghapus file sandi', async () => {
  const box = sandbox();
  const { spawn, calls } = fakeSpawn({ error: new Error('spawn powershell.exe ENOENT') });

  await assert.rejects(
    () => enableAutologon({
      password: SECRET,
      appDir: box.appDir,
      spawn,
      exec: fakeExec().exec,
      tmpdir: box.tmp,
      user: ME.user,
      status: onStatus,
    }),
    (err) => {
      assert.equal(err.code, 'registry');
      assert.match(err.message, /Tidak bisa meminta izin Administrator/);
      return true;
    },
  );

  const file = passwordFileIn(commandOf(calls[0]));
  assert.ok(file && !existsSync(file), 'file sandi harus terhapus walau proses tidak pernah jalan');
});

test('G1: helperMain tidak pernah memanggil process.exit', async () => {
  const box = sandbox();
  const file = secretFileIn(box.tmp);
  const ps = scriptRunner({ status: 0 });
  const original = process.exit;
  let called = false;
  process.exit = () => {
    called = true;
    throw new Error('process.exit tidak boleh dipanggil helperMain');
  };
  try {
    const code = await helperMain(
      ['node', 'server.js', '--autologon-enable', '--password-file', file, ...accountArgs(),
        '--app-dir', box.appDir, '--port', '4317'],
      { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
    );
    assert.equal(code, 0);
  } finally {
    process.exit = original;
  }
  assert.equal(called, false, 'helperMain mengembalikan kode; server.js yang keluar');
});

// --- Putaran perbaikan (review keamanan independen) ---------------------------------------------------------

test('C2: task pengunci yang tidak bisa diverifikasi = exit 4, registry tidak disentuh', async () => {
  const box = sandbox();
  const file = secretFileIn(box.tmp);
  const ps = scriptRunner({ verify: false });

  const code = await helperMain(
    ['--autologon-enable', '--password-file', file, ...accountArgs(), '--app-dir', box.appDir, '--port', '4317'],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  assert.equal(code, 4, 'identitas task tidak cocok = exit 4');
  assert.ok(
    ps.calls.some((c) => c.file === 'powershell.exe' && c.args.includes('-Command')),
    'C2: identitas task memang dicek',
  );
  assert.equal(
    ps.calls.filter((c) => c.file === 'powershell.exe' && c.args.includes('-File')).length,
    0,
    'registry tidak boleh ditulis bila pengunci tidak terbukti milik akun ini',
  );
  assert.ok(!existsSync(file), 'file sandi tetap terhapus');
  // Fail closed also means: the task must not be LEFT behind. An unverified lock would lock the screen 15 s after
  // every logon while the registry is untouched.
  const create = ps.calls.findIndex((c) => c.file === 'schtasks' && c.args.includes('/Create'));
  const remove = ps.calls.findIndex((c) => c.file === 'schtasks' && c.args.includes('/Delete'));
  assert.ok(create >= 0, 'task memang dipasang lebih dulu');
  assert.ok(remove > create, 'task yang tidak bisa diverifikasi harus dilepas lagi');
  assert.equal(ps.calls[remove].args[ps.calls[remove].args.indexOf('/TN') + 1], LOCK_TASK);
});

for (const [label, autoAdminLogon] of [['sudah ON', '1'], ['tidak terbaca', null]]) {
  test(`C2 gagal + autologon ${label}: pengunci TIDAK dilepas`, async () => {
    const box = sandbox();
    const file = secretFileIn(box.tmp);
    const ps = scriptRunner({ verify: false, autoAdminLogon });

    const code = await helperMain(
      ['--autologon-enable', '--password-file', file, ...accountArgs(), '--app-dir', box.appDir, '--port', '4317'],
      { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
    );

    assert.equal(code, 4);
    // Removing the lock while Windows still logs in by itself is the open desktop this module prevents. Only an
    // explicit AutoAdminLogon=0 proves nobody gets logged in, which is the case the other test covers.
    assert.ok(!ps.calls.some((c) => c.file === 'schtasks' && c.args.includes('/Delete')), 'pengunci tidak boleh hilang');
  });
}

test('C2: SID di argv yang formatnya salah ditolak, bukan diganti SID sesi ini', async () => {
  const box = sandbox();
  const file = secretFileIn(box.tmp);
  const ps = scriptRunner({ status: 0 });

  const code = await helperMain(
    ['--autologon-enable', '--password-file', file, ...accountArgs(), '--account-sid', 'bukan-sid',
      '--app-dir', box.appDir, '--port', '4317'],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  assert.equal(code, 1, 'argumen cacat = exit 1 (tidak ada perubahan)');
  assert.equal(ps.calls.length, 0, 'tidak ada schtasks/PowerShell yang dijalankan');
  assert.ok(!existsSync(file), 'file sandi tetap terhapus');
});

/** The real script, run by the real powershell.exe against a stubbed `Get-ScheduledTask` (Windows only). */
const psScriptVerdict = (script) => {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 0;
  } catch (err) {
    return err.status;
  }
};

/** `lockTaskCheckScript` with `Get-ScheduledTask` replaced: no real task, no Administrator rights needed. */
const withOwner = (owner, script) => [
  `function Get-ScheduledTask { param($TaskName) [pscustomobject]@{ Principal = [pscustomobject]@{ UserId = '${owner}' } } }`,
  script,
].join('\r\n');

test('skrip C2 asli: nama pendek diterima, akun lain ditolak', { skip: process.platform !== 'win32' }, () => {
  // This is the bug 1.0.34 shipped: Task Scheduler answers with the short name while the code compared "DOMAIN\User".
  const realSid = /"(S-1-[0-9-]+)"/.exec(String(execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }) ?? ''));
  assert.ok(realSid, 'SID sesi ini harus terbaca');
  const account = { user: ME.user, domain: ME.domain, sid: realSid[1] };
  const script = lockTaskCheckScript(account);

  assert.equal(psScriptVerdict(withOwner(ME.user, script)), 0, 'nama pendek = akun ini');
  assert.equal(psScriptVerdict(withOwner(`${ME.domain}\\${ME.user}`, script)), 0, 'DOMAIN\\User = akun ini');
  assert.equal(psScriptVerdict(withOwner(realSid[1], script)), 0, 'SID = akun ini');
  assert.equal(psScriptVerdict(withOwner('administrator', script)), 4, 'akun lain harus ditolak');
  assert.equal(psScriptVerdict(withOwner(`${ME.domain}\\administrator`, script)), 4, 'akun lain harus ditolak');
  // The SID from argv must BE this account: a foreign SID cannot bless the session's own task.
  assert.equal(psScriptVerdict(withOwner(ME.user, lockTaskCheckScript({ ...account, sid: 'S-1-5-18' }))), 4, 'SID asing ditolak');
  // Without a SID, the elevated session's own account is the only thing left to compare against.
  assert.equal(psScriptVerdict(withOwner(ME.user, lockTaskCheckScript({ ...account, sid: '' }))), 0, 'cadangan SID sesi');
});

test('C2/M4: lockTaskXml menulis <UserId> DOMAIN\\User dan tidak pernah memuat port aneh', () => {
  const xml = lockTaskXml(4318, { user: 'adhit', domain: 'KOMPUTER' });
  assert.match(xml, /<UserId>KOMPUTER\\adhit<\/UserId>/);
  assert.match(xml, /server port 4318/);

  // M4: port di luar jangkauan atau string apa pun jatuh ke 4317, tidak masuk XML.
  assert.match(lockTaskXml(70000), /server port 4317/);
  assert.match(lockTaskXml('4317</Description><Evil>'), /server port 4317/);
  assert.doesNotMatch(lockTaskXml('4317</Description><Evil>'), /Evil/);
  // M4: nilai akun di-escape sebelum masuk XML.
  assert.match(lockTaskXml(4317, { user: 'a&b', domain: 'x<y' }), /<UserId>x&lt;y\\a&amp;b<\/UserId>/);
});

test('I1: schtasks /Create untuk pengunci gagal = fail-closed', async () => {
  const box = sandbox();
  const file = secretFileIn(box.tmp);
  const ps = scriptRunner({ schtasksCreate: 'fail' });

  const code = await helperMain(
    ['--autologon-enable', '--password-file', file, ...accountArgs(), '--app-dir', box.appDir, '--port', '4317'],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  assert.notEqual(code, 0, 'gagal memasang pengunci bukan sukses');
  assert.equal(code, 4);
  assert.equal(ps.calls.filter((c) => c.file === 'powershell.exe').length, 0, 'scripts registry tidak pernah dipanggil');
  assert.ok(!existsSync(file), 'file sandi tetap terhapus');
});

test('I3: --app-dir asing tidak menentukan kode yang jalan sebagai Administrator', async () => {
  const box = sandbox();
  const own = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const notElevated = (name) => {
    if (name === 'net') throw new Error('ERROR: Access is denied.');
    return '';
  };
  const uac = fakeSpawn({ code: 5 });
  const file = secretFileIn(box.tmp);

  await helperMain(
    ['--autologon-enable', '--password-file', file, ...accountArgs(), '--app-dir', 'C:\\evil', '--port', '4317'],
    { platform: 'win32', execFileSync: notElevated, spawn: uac.spawn, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  const command = commandOf(uac.calls[0]);
  assert.ok(!/evil/i.test(command), `--app-dir asing tidak boleh dipakai: ${command}`);
  assert.ok(command.includes(`--app-dir ${own}`) || command.includes(`--app-dir "${own}"`), `pakai folder aplikasi ini: ${command}`);
});

test('I4: alasan dari anak elevated dipakai di pesan error, file hasil dihapus', async () => {
  const box = sandbox();
  const { spawn } = fakeSpawn({
    code: 4,
    onCall: (call) => {
      const match = /--result-file\s+"?([^"\s]+)"?/.exec(commandOf(call));
      if (match) writeFileSync(match[1], '4\r\nTask Scheduler menolak: access denied\r\n');
    },
  });

  await assert.rejects(
    () => enableAutologon({
      password: SECRET,
      appDir: box.appDir,
      spawn,
      exec: fakeExec().exec,
      tmpdir: box.tmp,
      user: ME.user,
      status: () => ({ autologon: 'off', mode: 'login', unsafeDesktop: false }),
    }),
    (err) => {
      assert.equal(err.code, 'registry');
      assert.match(err.message, /Pengunci layar atau registry tidak bisa dipasang/);
      assert.match(err.message, /Task Scheduler menolak: access denied/, 'I4: detail dari anak diteruskan');
      return true;
    },
  );
  assert.equal(readdirSync(box.tmp).filter((name) => name.endsWith('.result')).length, 0, 'file hasil dihapus');
});

test('UAC akun lain: file sandi di %TEMP% pemanggil diterima lewat --password-dir', async () => {
  const box = sandbox();
  // Named exactly like a real per-user temp: `...\AppData\Local\Temp`. The elevated copy (different administrator
  // account) has another %TEMP%, so without --password-dir the file would look foreign and bootmode could never be
  // enabled from the installer on a standard-user PC.
  const parentTemp = path.join(box.root, 'AppData', 'Local', 'Temp');
  mkdirSync(parentTemp, { recursive: true });
  const file = secretFileIn(parentTemp);
  const ps = scriptRunner({ status: 0 });

  const code = await helperMain(
    ['--autologon-enable', '--password-file', file, '--password-dir', parentTemp, ...accountArgs(),
      '--app-dir', box.appDir, '--port', '4317'],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  assert.equal(code, 0, 'diterima karena folder itu memang temp pengguna');
  assert.ok(ps.calls.some((call) => call.file === 'powershell.exe'), 'registry ditulis setelah validasi');
  assert.ok(!existsSync(file), 'file sandi tetap dihapus walau beda akun');
});

test('UAC akun lain: folder selain temp pengguna tetap ditolak dan tidak dihapus', async () => {
  const box = sandbox();
  const rogue = path.join(box.root, 'bukan-temp');
  mkdirSync(rogue, { recursive: true });
  const file = secretFileIn(rogue);
  const ps = scriptRunner();

  const code = await helperMain(
    ['--autologon-enable', '--password-file', file, '--password-dir', rogue, ...accountArgs(),
      '--app-dir', box.appDir, '--port', '4317'],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  assert.equal(code, 1, 'fail-closed');
  assert.equal(ps.calls.length, 0, 'registry tidak disentuh');
  assert.ok(existsSync(file), 'file milik orang lain tidak boleh dihapus');
});

test('I4: helper menulis kode + satu baris alasan ke --result-file (tanpa sandi)', async () => {
  const box = sandbox();
  const file = secretFileIn(box.tmp);
  const result = path.join(box.tmp, 'adhitron-autologon-1111222233334444.result');
  const ps = scriptRunner({ status: 3 });

  const code = await helperMain(
    ['--autologon-enable', '--password-file', file, ...accountArgs(), '--result-file', result,
      '--app-dir', box.appDir, '--port', '4317'],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, startupDir: box.startupDir },
  );

  assert.equal(code, 3);
  assert.ok(existsSync(result), 'anak elevated menulis laporan');
  const text = readFileSync(result, 'utf8');
  assert.match(text, /^3\r?\n/);
  assert.ok(!text.includes(SECRET), 'laporan tidak boleh memuat sandi');
  assert.ok(!existsSync(file), 'file sandi tetap terhapus');
});

test('I5: sandi salah tidak meninggalkan task pengunci yang baru dipasang', async () => {
  const box = sandbox();
  const base = {
    password: SECRET,
    appDir: box.appDir,
    spawn: fakeSpawn({ code: 3 }).spawn,
    tmpdir: box.tmp,
    user: ME.user,
  };

  // Task belum ada sebelum helper: yang dipasang helper harus dilepas lagi.
  const fresh = fakeExec();
  await assert.rejects(
    () => enableAutologon({ ...base, exec: fresh.exec, status: () => ({ autologon: 'off', mode: 'login' }) }),
    /Sandi Windows salah/,
  );
  assert.ok(fresh.calls.some((c) => c.file === 'schtasks' && c.args.includes('/Delete')), 'task baru dilepas lagi');

  // Task sudah ada sebelum helper: jangan sentuh.
  const kept = fakeExec();
  await assert.rejects(() => enableAutologon({ ...base, exec: kept.exec, status: onStatus }), /Sandi Windows salah/);
  assert.equal(kept.calls.some((c) => c.file === 'schtasks' && c.args.includes('/Delete')), false, 'task lama dipertahankan');
});

test('I2: parent kehabisan waktu tapi Windows sudah on+boot = sukses', async () => {
  const box = sandbox();
  const result = await enableAutologon({
    password: SECRET,
    appDir: box.appDir,
    port: 4317,
    spawn: fakeSpawn({ never: true }).spawn,
    exec: fakeExec().exec,
    tmpdir: box.tmp,
    user: ME.user,
    timeoutMs: 200,
    status: onStatus,
  });
  assert.deepEqual(result, { ok: true, verified: true }, 'anak selesai setelah parent berhenti menunggu');
});

test('I6: --autologon-disable tidak digerbang cek akun', async () => {
  const box = sandbox();
  const ps = scriptRunner({ status: 0 });

  const code = await helperMain(
    ['--autologon-disable', '--user', 'administrator', '--domain', 'KOMPUTER-LAIN', '--app-dir', box.appDir],
    { platform: 'win32', execFileSync: ps.exec, spawn: fakeSpawn().spawn, elevated: true, tmpdir: box.tmp, account: ME },
  );

  assert.equal(code, 0, 'mematikan tidak butuh akun yang cocok');
  assert.match(ps.script(), /SetValue\('AutoAdminLogon', '0'/);
});

test('M3: exit 4 memakai kalimat yang jelas untuk pengguna', async () => {
  const box = sandbox();
  await assert.rejects(
    () => enableAutologon({
      password: SECRET,
      appDir: box.appDir,
      spawn: fakeSpawn({ code: 4 }).spawn,
      exec: fakeExec().exec,
      tmpdir: box.tmp,
      user: ME.user,
      status: () => ({ autologon: 'off', mode: 'login' }),
    }),
    (err) => {
      assert.equal(err.code, 'registry');
      assert.equal(err.message, 'Pengunci layar atau registry tidak bisa dipasang (izin Administrator / Task Scheduler menolak).');
      return true;
    },
  );
});


test('file sandi yang tertinggal dibersihkan saat start, file baru dan file lain tidak', () => {
  const box = sandbox();
  const oldSecret = secretFileIn(box.tmp, 'aaaaaaaaaaaaaaa1');
  const oldResult = path.join(box.tmp, 'adhitron-autologon-aaaaaaaaaaaaaaa2.result');
  writeFileSync(oldResult, '4\r\nTask Scheduler menolak\r\n');
  const fresh = secretFileIn(box.tmp, 'bbbbbbbbbbbbbbb3');
  const stranger = path.join(box.tmp, 'catatan.txt');
  writeFileSync(stranger, 'bukan milik kita');

  // Two hours old: only the leftovers from a crashed wizard are old enough to go.
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(oldSecret, twoHoursAgo, twoHoursAgo);
  utimesSync(oldResult, twoHoursAgo, twoHoursAgo);
  assert.equal(sweepLeftoverSecrets(box.tmp), 2);
  assert.ok(!existsSync(oldSecret), 'file sandi lama hilang');
  assert.ok(!existsSync(oldResult), 'file hasil lama hilang');
  assert.ok(existsSync(fresh), 'file yang masih baru tidak disentuh (helper mungkin sedang memakainya)');
  assert.ok(existsSync(stranger), 'file lain di %TEMP% tidak pernah disentuh');
});

test('relaunchOf tidak memakai skrip di luar folder aplikasi', () => {
  const box = sandbox();
  // appDir tanpa server.js: process.argv[1] (berkas test ini) berada di luar appDir, jadi tidak boleh dipakai.
  const { args } = relaunchOf(box.appDir);
  assert.deepEqual(args, [], 'tidak ada skrip asing yang ikut dieksekusi sebagai Administrator');

  writeFileSync(path.join(box.appDir, 'server.js'), '// app entry');
  assert.deepEqual(relaunchOf(box.appDir).args, [path.join(box.appDir, 'server.js')], 'entri aplikasi sendiri dipakai');
});