// ⚙ Nyala otomatis (src/autostart.js): mode 'login' (launcher Startup + watchdog task) dan mode 'boot'
// (ditambah task `Adhitron Lock`) yang membuat server hidup SEBELUM login. Autologon sendiri ditulis oleh
// src/autologon.js (POST /api/autologon): tidak ada lagi file .cmd.
// Semua efek nyata di-inject: folder Startup, `schtasks`/`reg` (execFileSync) dan tmpdir berasal dari sandbox,
// jadi tes tidak pernah menyentuh task asli, registry, atau folder Startup pengguna.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { autostartStatus, installLockTask, lockTaskXml, repairUnsafeAutologon, setAutostart } from '../src/autostart.js';
import { buildRouter } from '../src/routes/index.js';

const DIRS = [];
after(() => DIRS.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

const LAUNCHER = 'claude-coworking.vbs';
const LEGACY_LOCK = 'adhitron-lock.vbs';
const WATCHDOG = 'Claude Coworking';
const LOCK_TASK = 'Adhitron Lock';

/**
 * A fake machine: a temp Startup folder, a temp app folder, and an execFileSync stub that pretends to be
 * `schtasks` (a named task exists only after /Create for that name) and `reg` (the value is missing → autologon
 * 'unknown'). The XML handed to `schtasks /XML` is captured from inside the stub, before setAutostart deletes it.
 */
function sandbox({ autologon = 'unknown', lockTask = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-autostart-'));
  DIRS.push(root);
  const startupDir = path.join(root, 'Startup');
  const appDir = path.join(root, 'app');
  mkdirSync(appDir, { recursive: true });
  const calls = [];
  const tasks = new Set(lockTask ? [LOCK_TASK] : []);
  const xml = {};
  const execFileSync = (file, args = []) => {
    calls.push({ file, args });
    if (file === 'schtasks') {
      const name = args[args.indexOf('/TN') + 1];
      if (args[0] === '/Query') {
        if (!tasks.has(name)) throw new Error('ERROR: The system cannot find the file specified.');
        return '';
      }
      if (args[0] === '/Create') {
        tasks.add(name);
        // schtasks /XML gets UTF-16 with a BOM: same read the scheduler does.
        if (args.includes('/XML')) xml[name] = readFileSync(args[args.indexOf('/XML') + 1], 'utf16le').replace(/^\uFEFF/, '');
        return '';
      }
      if (args[0] === '/Delete') {
        tasks.delete(name);
        return '';
      }
    }
    if (file === 'reg') {
      // `autologon: 'on'` = Windows really logs in by itself (AutoAdminLogon=1); 'off' = the value says 0.
      if (autologon === 'on') return 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\r\n    AutoAdminLogon    REG_SZ    1\r\n';
      if (autologon === 'off') return 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\r\n    AutoAdminLogon    REG_SZ    0\r\n';
      throw new Error('ERROR: The system was unable to find the specified registry key or value.');
    }
    return '';
  };
  const options = { platform: 'win32', startupDir, execFileSync, tmpdir: root, appDir, hostname: 'ADHITRON-PC', username: 'adhit' };
  return { root, startupDir, appDir, calls, options, tasks, xml: (name) => xml[name] ?? '' };
}

/** Every <tag> must be closed by </tag>: catches a stray escape or a truncated Task Scheduler definition. */
function assertXmlWellFormed(xml, command) {
  const stack = [];
  for (const m of xml.matchAll(/<\s*(\/?)\s*([A-Za-z_][\w.:-]*)[^>]*?(\/?)>/g)) {
    if (m[3] === '/') continue; // self-closing
    if (m[1] === '/') assert.equal(stack.pop(), m[2], `tag penutup </${m[2]}> tidak cocok`);
    else stack.push(m[2]);
  }
  assert.deepEqual(stack, [], 'ada tag XML yang belum ditutup');
  assert.match(xml, /<Task version="1\.2"/);
  if (command) assert.ok(xml.includes(`<Command>${command}</Command>`) || new RegExp(`<Command>[^<]*${command}</Command>`).test(xml), `Command ${command} tidak ada`);
}

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

const exists = (dir, file) => existsSync(path.join(dir, file));
const creates = (box, name) => box.calls.filter((c) => c.file === 'schtasks' && c.args[0] === '/Create' && c.args[c.args.indexOf('/TN') + 1] === name);

test('mode login: hanya launcher + watchdog, tanpa task pengunci', () => {
  const box = sandbox();
  const status = setAutostart(true, box.appDir, 4317, box.options);

  assert.equal(status.supported, true);
  assert.equal(status.enabled, true);
  assert.equal(status.mode, 'login');
  assert.equal(status.needsElevation, false);
  assert.equal(status.watchdog, true);
  assert.ok(exists(box.startupDir, LAUNCHER));
  assert.ok(!exists(box.startupDir, LEGACY_LOCK), 'mode login tidak boleh menulis launcher kunci layar');
  assert.ok(!box.tasks.has(LOCK_TASK), 'mode login tidak boleh memasang task pengunci');
  assert.equal('scripts' in status, false, 'payload tidak lagi membawa path file .cmd');
  assertXmlWellFormed(box.xml(WATCHDOG), 'wscript.exe');
});

test('boot mode installs a logon task that locks the workstation', () => {
  const box = sandbox();
  const status = setAutostart(true, box.appDir, 4317, { ...box.options, mode: 'boot' });

  assert.equal(status.enabled, true);
  assert.equal(status.mode, 'boot', 'keberadaan task Adhitron Lock = mode boot');
  assert.ok(box.tasks.has(LOCK_TASK), 'task pengunci wajib terpasang');
  assert.equal(status.autologon, 'unknown'); // `reg` gagal dibaca → belum tentu aktif
  assert.equal(status.needsElevation, true, 'boot tanpa autologon wajib minta elevasi');

  // Tidak ada file pengunci lagi: Defender mengarantina .vbs berisi payload LockWorkStation.
  assert.ok(!exists(box.startupDir, LEGACY_LOCK), 'pengunci layar tidak boleh berupa file .vbs');
  assert.ok(exists(box.startupDir, LAUNCHER));

  const xml = box.xml(LOCK_TASK);
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<Delay>PT15S<\/Delay>/, 'sesi diberi 15 detik untuk settle');
  assert.match(xml, /<Command>[^<]*(System32[\\/])?rundll32\.exe<\/Command>/, 'aksi memakai rundll32.exe');
  assert.match(xml, /<Arguments>user32\.dll,LockWorkStation<\/Arguments>/);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assertXmlWellFormed(xml, 'rundll32.exe');

  assert.ok(creates(box, LOCK_TASK).length === 1, 'tepat satu schtasks /Create untuk task pengunci');
  assert.ok(creates(box, LOCK_TASK)[0].args.includes('/XML'), 'task dibuat dari XML UTF-16, bukan argumen /TR');
  assertXmlWellFormed(box.xml(WATCHDOG), 'wscript.exe');
});

test('C2: mode boot menulis <UserId> akun autologon ke task pengunci (bila diberikan)', () => {
  const box = sandbox();
  setAutostart(true, box.appDir, 4317, { ...box.options, mode: 'boot', user: 'adhit', domain: 'ADHITRON-PC' });
  assert.match(box.xml(LOCK_TASK), /<UserId>ADHITRON-PC\\adhit<\/UserId>/);

  // Jalur GUI boleh tidak tahu akunnya: perilaku lama (tanpa UserId) tetap.
  const plain = sandbox();
  setAutostart(true, plain.appDir, 4317, { ...plain.options, mode: 'boot' });
  assert.doesNotMatch(plain.xml(LOCK_TASK), /<UserId>/);
});

test('M4: installLockTask menolak port aneh tanpa mengganggu task', () => {
  const box = sandbox();
  installLockTask('4317</Command><Evil>', box.options);
  assert.ok(box.tasks.has(LOCK_TASK), 'task tetap dipasang');
  const xml = box.xml(LOCK_TASK);
  assert.match(xml, /server port 4317/);
  assert.doesNotMatch(xml, /Evil/);
  // Bentuk XML langsung juga tervalidasi (dipakai helper autologon untuk UserId).
  assert.match(lockTaskXml(Number.NaN), /server port 4317/);
});

test('status di folder kosong: mode login, autologon belum diketahui, tanpa elevasi', () => {
  const box = sandbox();
  const status = autostartStatus(box.options);

  assert.equal(status.supported, true);
  assert.equal(status.enabled, false);
  assert.equal(status.watchdog, false);
  assert.equal(status.mode, 'login');
  assert.ok(['unknown', 'off'].includes(status.autologon), `autologon tak terbaca harus 'unknown'/'off', dapat ${status.autologon}`);
  assert.equal(status.needsElevation, false);
  assert.ok(!exists(box.startupDir, LAUNCHER));
});

test('enabled=false menghapus launcher, task pengunci, dan task watchdog', () => {
  const box = sandbox();
  setAutostart(true, box.appDir, 4317, { ...box.options, mode: 'boot' });
  const status = setAutostart(false, box.appDir, 4317, box.options);

  assert.equal(status.enabled, false);
  assert.equal(status.mode, 'login');
  assert.equal(status.watchdog, false);
  for (const [dir, file] of [[box.startupDir, LAUNCHER], [box.startupDir, LEGACY_LOCK]]) {
    assert.ok(!exists(dir, file), `${file} harus terhapus`);
  }
  assert.ok(!box.tasks.has(LOCK_TASK), 'task pengunci ikut dilepas');
  assert.ok(!box.tasks.has(WATCHDOG), 'task watchdog ikut dilepas');
  assert.ok(box.calls.some((c) => c.file === 'schtasks' && c.args[0] === '/Delete'));
});

test('downgrading to login removes the lock task', () => {
  const box = sandbox();
  setAutostart(true, box.appDir, 4317, { ...box.options, mode: 'boot' });
  assert.ok(box.tasks.has(LOCK_TASK));

  const status = setAutostart(true, box.appDir, 4317, { ...box.options, mode: 'login' });

  assert.equal(status.enabled, true);
  assert.equal(status.mode, 'login', 'autologon mati: task pengunci dilepas');
  assert.ok(!box.tasks.has(LOCK_TASK), 'task pengunci harus dihapus');
  assert.ok(!exists(box.startupDir, LEGACY_LOCK));
  assert.ok(exists(box.startupDir, LAUNCHER));
});

test('a leftover adhitron-lock.vbs from 1.0.33 is deleted', () => {
  const box = sandbox();
  mkdirSync(box.startupDir, { recursive: true });
  // Sisa 1.0.33: file yang sekarang diarantina Defender, tetapi masih ada di mesin yang belum reboot.
  writeFileSync(path.join(box.startupDir, LEGACY_LOCK), "' sisa 1.0.33");

  setAutostart(true, box.appDir, 4317, { ...box.options, mode: 'boot' });
  assert.ok(!exists(box.startupDir, LEGACY_LOCK), 'migrasi boot: file .vbs lama dihapus');
  assert.ok(box.tasks.has(LOCK_TASK));

  // Mode login yang bersih juga tidak boleh meninggalkan file itu.
  writeFileSync(path.join(box.startupDir, LEGACY_LOCK), "' sisa 1.0.33");
  setAutostart(true, box.appDir, 4317, { ...box.options, mode: 'login' });
  assert.ok(!exists(box.startupDir, LEGACY_LOCK), 'migrasi login: file .vbs lama dihapus');
});

test('POST /api/autostart menolak mode tak dikenal dengan 400 dan tidak memasang apa pun', async () => {
  const router = buildRouter();
  const match = router.match('POST', '/api/autostart');
  assert.ok(match, '/api/autostart harus terdaftar');
  const hub = { config: {}, broadcast: () => {} };
  const res = fakeRes();
  await match.route.handler({ hub, appDir: 'C:\\adhitron', port: 4317 }, { headers: {} }, res, match.params, { enabled: true, mode: 'system' });

  assert.equal(res.status, 400);
  assert.match(res.json().error, /login/);
  assert.match(res.json().error, /boot/);
  assert.deepEqual(hub.config, {}, 'mode tidak valid tidak boleh mengubah config');
});

test('kunci layar hanya dipasang oleh mode boot, bukan oleh watchdog', () => {
  const box = sandbox();
  setAutostart(true, box.appDir, 4317, box.options);
  assert.ok(creates(box, WATCHDOG).length === 1, 'task watchdog dibuat');
  assert.ok(!box.tasks.has(LOCK_TASK), 'mode login tidak memasang task pengunci');
  assert.ok(!box.xml(WATCHDOG).includes('LockWorkStation'), 'watchdog hanya menjalankan launcher utama, bukan kunci layar');
  assert.ok(box.xml(WATCHDOG).includes(LAUNCHER));
});

test('autologon menyala: mematikan auto-start TIDAK melepas pengunci layar', () => {
  const box = sandbox({ autologon: 'on' });
  const boot = setAutostart(true, box.appDir, 4317, { ...box.options, mode: 'boot' });
  assert.equal(boot.autologon, 'on');
  assert.equal(boot.needsElevation, false, 'autologon sudah aktif: tidak perlu elevasi lagi');
  assert.equal(boot.unsafeDesktop, false, 'pengunci layar terpasang, jadi desktop aman');

  const off = setAutostart(false, box.appDir, 4317, box.options);
  assert.equal(off.enabled, false);
  assert.equal(off.watchdog, false);
  assert.ok(!exists(box.startupDir, LAUNCHER), 'auto-start benar-benar mati');
  assert.ok(box.tasks.has(LOCK_TASK), 'task pengunci tetap ada selama AutoAdminLogon=1 (hanya admin yang bisa mematikannya)');
  assert.equal(off.unsafeDesktop, false, 'layar tetap terkunci: tidak ada desktop terbuka');
  assert.equal(off.mode, 'boot', 'status jujur: pengunci masih terpasang');
  assert.ok(box.calls.some((c) => c.file === 'schtasks' && c.args[0] === '/Delete' && c.args.includes(WATCHDOG)));
});

test('autologon menyala: kembali ke mode login tidak bisa melepas pengunci layar', () => {
  const box = sandbox({ autologon: 'on' });
  setAutostart(true, box.appDir, 4317, { ...box.options, mode: 'boot' });
  const status = setAutostart(true, box.appDir, 4317, { ...box.options, mode: 'login' });

  // The lock task is the mode flag, and it stays while autologon does: with AutoAdminLogon=1 Windows logs in by
  // itself, so the screen MUST still be locked at every boot. Honest status beats the requested mode.
  assert.equal(status.mode, 'boot');
  assert.equal(status.enabled, true);
  assert.ok(box.tasks.has(LOCK_TASK), 'layar tetap terkunci setelah login manual');
  assert.equal(status.unsafeDesktop, false);
});

test('autologon without the lock task is unsafeDesktop', () => {
  const box = sandbox({ autologon: 'on' });
  const status = autostartStatus(box.options);
  assert.equal(status.mode, 'login');
  assert.equal(status.autologon, 'on');
  assert.equal(status.unsafeDesktop, true, 'autologon aktif tetapi task Adhitron Lock tidak ada: desktop akan terbuka');

  // Kebalikannya: tugas pengunci terpasang → desktop aman, dan mode jujur 'boot'.
  const installed = sandbox({ autologon: 'on', lockTask: true });
  const safe = autostartStatus(installed.options);
  assert.equal(safe.mode, 'boot');
  assert.equal(safe.unsafeDesktop, false);
  assert.equal(safe.needsElevation, false);
});

test('autologon dimatikan (REG_SZ 0): semua berkas khusus boot dibersihkan lagi', () => {
  const box = sandbox({ autologon: 'off' });
  setAutostart(true, box.appDir, 4317, { ...box.options, mode: 'boot' });
  const off = setAutostart(false, box.appDir, 4317, box.options);

  assert.equal(off.unsafeDesktop, false);
  assert.ok(!exists(box.startupDir, LEGACY_LOCK), 'file .vbs lama boleh dihapus: autologon sudah mati');
  assert.ok(!box.tasks.has(LOCK_TASK), 'autologon mati: task pengunci dilepas');
});

test('Task Scheduler menolak: pesan jelas, bukan "Command failed"', () => {
  const box = sandbox();
  const failing = (file, args = []) => {
    box.options.execFileSync(file, args); // tetap tercatat, lalu gagal seperti schtasks sungguhan
    if (file === 'schtasks' && args[0] === '/Create') {
      const err = new Error('Command failed: schtasks /Create');
      err.stderr = 'ERROR: Access is denied.\r\n';
      throw err;
    }
    return '';
  };

  assert.throws(
    () => setAutostart(true, box.appDir, 4317, { ...box.options, mode: 'boot', execFileSync: failing }),
    /Task Scheduler menolak memasang pengunci layar: ERROR: Access is denied\./,
  );
});

test('launcher yang tidak bisa ditulis: pesan jelas menyebut berkasnya', () => {
  const box = sandbox();
  mkdirSync(box.startupDir, { recursive: true });
  mkdirSync(path.join(box.startupDir, LAUNCHER)); // menulis ke sebuah folder = gagal, apa pun errornya
  assert.throws(
    () => setAutostart(true, box.appDir, 4317, box.options),
    /Tidak bisa menulis .*claude-coworking\.vbs/,
  );
});

// --- Putaran perbaikan (review keamanan independen) ---------------------------------------------------------

test('M6: sisa .vbs yang tidak bisa dihapus dilaporkan dalam bahasa Indonesia', () => {
  const box = sandbox();
  mkdirSync(box.startupDir, { recursive: true });
  mkdirSync(path.join(box.startupDir, LEGACY_LOCK)); // unlinkSync pada sebuah folder = EPERM
  assert.throws(
    () => installLockTask(4317, box.options),
    /Tidak bisa menghapus .*adhitron-lock\.vbs/,
  );
  assert.ok(box.tasks.has(LOCK_TASK), 'task terpasang dulu; hanya pembersihan sisa file yang gagal');
});

test('7: penjaga upgrade memasang pengunci saat autologon on tanpa task (dan menghapus sisa .vbs)', () => {
  const box = sandbox({ autologon: 'on' });
  mkdirSync(box.startupDir, { recursive: true });
  writeFileSync(path.join(box.startupDir, LEGACY_LOCK), "' sisa 1.0.33");

  assert.equal(repairUnsafeAutologon(4317, box.options), true);
  assert.ok(box.tasks.has(LOCK_TASK), 'task pengunci dipasang tanpa elevasi');
  assert.ok(!exists(box.startupDir, LEGACY_LOCK), 'sisa .vbs 1.0.33 ikut dihapus');
  assert.ok(creates(box, LOCK_TASK).length === 1);
});

test('7: penjaga upgrade tidak melakukan apa pun saat autologon mati/unknown atau task sudah ada', () => {
  const off = sandbox({ autologon: 'off' });
  assert.equal(repairUnsafeAutologon(4317, off.options), false);
  assert.equal(creates(off, LOCK_TASK).length, 0, 'autologon mati: tidak ada task baru');

  const unknown = sandbox();
  assert.equal(repairUnsafeAutologon(4317, unknown.options), false);
  assert.equal(creates(unknown, LOCK_TASK).length, 0, 'status tak terbaca bukan alasan memasang task');

  const boot = sandbox({ autologon: 'on', lockTask: true });
  assert.equal(repairUnsafeAutologon(4317, boot.options), false);
  assert.equal(creates(boot, LOCK_TASK).length, 0, 'task sudah ada: tidak dipasang ulang');
});

test('7: kegagalan penjaga upgrade dilempar, bukan ditelan diam-diam', () => {
  const box = sandbox({ autologon: 'on' });
  const failing = (file, args = []) => {
    if (file === 'schtasks' && args[0] === '/Create') throw new Error('ERROR: Access is denied.');
    return box.options.execFileSync(file, args);
  };
  assert.throws(() => repairUnsafeAutologon(4317, { ...box.options, execFileSync: failing }), /Task Scheduler menolak/);
});
