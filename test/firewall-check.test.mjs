// 🧱 Firewall Tailscale (src/firewall-check.js): the check parser (sample PowerShell JSON), the fixed elevated
// command (byte-for-byte sync with installer/Adhitron.iss), the two routes (laptop-only via the /api/remote
// phone gate; fakes injected — NO real netsh/PowerShell is ever spawned), and the 📱 banner rules
// (public/js/core/firewall-banner.js). Pure logic only: this file stays in the `fast` test run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FIREWALL_PORTS,
  FIREWALL_RULE_NAME,
  LEGACY_FIREWALL_RULE_NAME,
  TAILSCALE_REMOTE_IP,
  checkFirewallRules,
  elevatedFirewallFixCommand,
  firewallCheckScript,
  firewallFixArgs,
  firewallFixScript,
  installerFirewallParameters,
  manualFirewallCommand,
  parseFirewallCheck,
  powershellPath,
  runFirewallFix,
} from '../src/firewall-check.js';
import { buildRouter } from '../src/routes/index.js';
import { wifiAllows } from '../src/remote.js';
import { firewallBanner } from '../public/js/core/firewall-banner.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ISS = readFileSync(path.join(APP, 'installer', 'Adhitron.iss'), 'utf8');

// ---------- the fixed commands ----------

test('firewallFixScript: adds the NEW rule (both ports, Tailscale range, private) and deletes ONLY the legacy rule', () => {
  const script = firewallFixScript();
  assert.ok(script.includes(`netsh advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow protocol=TCP localport=${FIREWALL_PORTS.join(',')} remoteip=${TAILSCALE_REMOTE_IP} profile=private`));
  assert.ok(script.includes(`netsh advfirewall firewall delete rule name="${LEGACY_FIREWALL_RULE_NAME}"`), 'hanya nama legacy yang persis');
  assert.equal(script.match(/delete rule/g).length, 1, 'tepat satu penghapusan');
  assert.ok(!script.includes('delete rule name=""'), 'tidak ada penghapusan liar');
});

test('elevatedFirewallFixCommand: fixed string, one UAC prompt, base64 payload decodes back to the script', () => {
  const cmd = elevatedFirewallFixCommand();
  assert.ok(cmd.startsWith(`Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','`), 'satu Start-Process = satu prompt UAC');
  assert.ok(!cmd.includes('"'), 'tanpa " sama sekali: lolos lapisan Inno → PowerShell → Start-Process tanpa kutip rapuh');
  const b64 = cmd.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)?.[1];
  assert.ok(b64, 'payload base64 ada');
  assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), firewallFixScript(), 'payload = script tetap');
  assert.ok(!cmd.includes(LEGACY_FIREWALL_RULE_NAME) && !cmd.includes(FIREWALL_RULE_NAME), 'nama aturan tidak pernah keluar sebagai teks bebas (hanya di dalam base64)');
});

test('installer .iss: same fixed command byte-for-byte, task checked by default, skipped on silent updates', () => {
  const params = installerFirewallParameters();
  assert.ok(params.startsWith('-NoProfile -ExecutionPolicy Bypass -Command '), 'prefix spawn dan installer identik');
  assert.ok(ISS.includes(`Parameters: "${params}";`), 'Adhitron.iss memuat string yang PERSIS dari builder');
  assert.ok(ISS.includes('Name: "firewalltailscale"'), 'task-nya ada');
  const taskLine = ISS.split(/\r?\n/).find((l) => l.includes('Name: "firewalltailscale"'));
  assert.ok(taskLine.includes('Flags: checkedonce') && !taskLine.includes('unchecked'), 'checked by default (checkedonce, bukan unchecked)');
  const runLine = ISS.split(/\r?\n/).find((l) => l.includes('firewalltailscale') && l.includes('Parameters:'));
  assert.ok(runLine.includes('skipifsilent'), 'update senyap tidak boleh memunculkan UAC');
  assert.ok(runLine.includes('runhidden'), 'jendela PowerShell luar tersembunyi');
  // The embedded payload, decoded straight from the .iss, must equal the builder's script.
  const b64 = runLine.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)?.[1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), firewallFixScript(), 'payload di .iss = script builder');
});

test('firewallFixArgs / powershellPath: the spawn path matches the installer line', () => {
  const args = firewallFixArgs();
  assert.equal(args.join(' '), installerFirewallParameters());
  assert.ok(args.includes(elevatedFirewallFixCommand()), '-Command membawa string tetap yang sama');
  assert.match(powershellPath({ SystemRoot: 'C:\\Windows' }), /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/, 'Windows PowerShell 5.1');
  assert.equal(manualFirewallCommand(), firewallFixScript(), 'perintah manual = script yang sama');
});

// ---------- the read-only check (parser) ----------

test('parseFirewallCheck: sample PowerShell JSON → covered true/false, legacyRule', () => {
  assert.deepEqual(parseFirewallCheck('{"covered":true,"p4317":true,"p4318":true,"legacy":false}\n'), { platforms: 'windows', covered: true, legacyRule: false });
  assert.deepEqual(parseFirewallCheck('{"covered":false,"p4317":true,"p4318":false,"legacy":true}'), { platforms: 'windows', covered: false, legacyRule: true }, 'aturan lama (hanya 4317) = belum tercakup');
  assert.deepEqual(parseFirewallCheck('{"covered":false,"p4317":false,"p4318":false,"legacy":false}'), { platforms: 'windows', covered: false, legacyRule: false });
});

test('parseFirewallCheck: unknown output never becomes a false alarm (covered null)', () => {
  assert.equal(parseFirewallCheck('').covered, null, 'stdout kosong');
  assert.equal(parseFirewallCheck('Get-NetFirewallRule : access denied\r\n').covered, null, 'teks error saja');
  assert.equal(parseFirewallCheck('{"covered":"yes"}').covered, null, 'covered bukan boolean');
  assert.equal(parseFirewallCheck(null).covered, null);
  assert.equal(parseFirewallCheck('warning...\n{"covered":true,"legacy":false}').covered, true, 'JSON di tengah stdout tetap terbaca');
});

test('firewallCheckScript: fixed read-only detector (no netsh add/delete, only Get-*)', () => {
  const script = firewallCheckScript();
  assert.ok(!/netsh/i.test(script), 'pemeriksa tidak pernah menjalankan netsh');
  for (const cmdlet of ['Get-NetFirewallPortFilter', 'Get-NetFirewallRule', 'Get-NetFirewallAddressFilter']) assert.ok(script.includes(cmdlet), cmdlet);
  assert.ok(script.includes(`'${LEGACY_FIREWALL_RULE_NAME}'`) && script.includes(TAILSCALE_REMOTE_IP) && script.includes("'4317'") && script.includes("'4318'"));
});

test('checkFirewallRules: parses the fake runner; failure = unknown; non-Windows = no check', async () => {
  const yes = { platforms: 'windows', covered: true, legacyRule: false };
  assert.deepEqual(await checkFirewallRules(async () => '{"covered":true,"legacy":false}'), yes, 'jalur normal lewat parser');
  assert.deepEqual(await checkFirewallRules(async () => { throw new Error('boom'); }), { platforms: 'windows', covered: null, legacyRule: false }, 'gagal → unknown, TIDAK throw');
  assert.deepEqual(await checkFirewallRules(async () => '', 'darwin'), { platforms: 'other', covered: null, legacyRule: false }, 'non-Windows tanpa pemeriksaan');
  assert.deepEqual(await checkFirewallRules(async () => '', 'linux'), { platforms: 'other', covered: null, legacyRule: false });
});

// ---------- the elevated fix (injected runner, never real) ----------

test('runFirewallFix: ok on clean exit; declined/timeout on failure; non-Windows refused', async () => {
  assert.deepEqual(await runFirewallFix(async () => ''), { platforms: 'windows', ok: true });
  assert.deepEqual(await runFirewallFix(async () => { const e = new Error('canceled'); e.killed = false; throw e; }), { platforms: 'windows', ok: false, reason: 'declined' }, 'UAC ditolak');
  assert.deepEqual(await runFirewallFix(async () => { const e = new Error('timeout'); e.killed = true; throw e; }), { platforms: 'windows', ok: false, reason: 'timeout' }, 'UAC tidak dijawab');
  assert.deepEqual(await runFirewallFix(async () => '', 'darwin'), { platforms: 'other' });
  assert.equal((await runFirewallFix(async (cmd) => cmd, 'win32', 5)).platforms, 'windows', 'cmd tetap string tetap dari builder');
});

// ---------- the routes (laptop-only by the /api/remote phone gate) ----------

const router = buildRouter();
function fakeRes() {
  const res = { status: 0, headers: {}, body: '' };
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.writeHead = (status) => (res.status = status);
  res.end = (b) => (res.body = String(b ?? ''));
  res.json = () => JSON.parse(res.body);
  return res;
}
const call = async (p, ctx) => {
  const m = router.match('POST', p);
  assert.ok(m, `${p} harus terdaftar`);
  const res = fakeRes();
  await m.route.handler(ctx, { headers: {} }, res, m.params, {});
  return res;
};

test('routes: firewall-check answers with the (injected) check result', async () => {
  const ctx = { firewallCheck: async () => ({ platforms: 'windows', covered: false, legacyRule: true }) };
  const res = await call('/api/remote/firewall-check', ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { platforms: 'windows', covered: false, legacyRule: true });
});

test('routes: firewall-fix runs the injected fix, then re-checks and returns the manual command', async () => {
  let checks = 0;
  const ctx = {
    firewallFix: async () => ({ platforms: 'windows', ok: true }),
    firewallCheck: async () => (++checks, { platforms: 'windows', covered: true, legacyRule: false }),
  };
  const res = await call('/api/remote/firewall-fix', ctx);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.check, { platforms: 'windows', covered: true, legacyRule: false }, 'check DIULANG setelah fix (jawaban baru adalah kebenaran)');
  assert.equal(body.manual, manualFirewallCommand());
  assert.equal(checks, 1, 'route menjalankan check segar setelah fix');
});

test('routes: firewall-fix refused on non-Windows (400, no check)', async () => {
  let checks = 0;
  const ctx = {
    firewallFix: async () => ({ platforms: 'other' }),
    firewallCheck: async () => ++checks && { platforms: 'other', covered: null, legacyRule: false },
  };
  const res = await call('/api/remote/firewall-fix', ctx);
  assert.equal(res.status, 400);
  assert.ok(res.json().error);
  assert.equal(checks, 0, 'non-Windows tidak menjalankan pemeriksaan');
});

test('routes: both firewall routes stay under the phone gate (paired phone refused, plain WiFi default-deny)', () => {
  for (const p of ['/api/remote/firewall-check', '/api/remote/firewall-fix']) {
    assert.ok(p.startsWith('/api/remote'), `${p} berada di prefix yang server.js tolak untuk HP berpasangan`);
    assert.equal(wifiAllows(p), false, `${p} tidak masuk allowlist WiFi read-only`);
  }
});

// ---------- the 📱 banner (pure component) ----------

const COVERED = { platforms: 'windows', covered: true, legacyRule: false };
const UNCOVERED = { platforms: 'windows', covered: false, legacyRule: true };
const UNKNOWN = { platforms: 'windows', covered: null, legacyRule: false };

test('banner: only when HTTPS is active AND covered === false', () => {
  assert.ok(firewallBanner(UNCOVERED, { httpsActive: true }), 'HTTPS aktif + port terblokir → banner');
  assert.equal(firewallBanner(UNCOVERED, { httpsActive: false }), null, 'HTTPS belum aktif → tidak menuduh');
  assert.equal(firewallBanner(COVERED, { httpsActive: true }), null, 'sudah tercakup → tidak ada banner');
  assert.equal(firewallBanner(UNKNOWN, { httpsActive: true }), null, 'tidak diketahui (PowerShell gagal) → tidak mengganggu');
  assert.equal(firewallBanner(null, { httpsActive: true }), null);
  assert.equal(firewallBanner({ platforms: 'other', covered: null }, { httpsActive: true }), null, 'non-Windows → tanpa banner');
  assert.equal(firewallBanner(UNCOVERED, { httpsActive: true, busy: true }).button, 'Memperbaiki…', 'saat fix berjalan tombol berubah');
  assert.equal(firewallBanner(UNCOVERED, { httpsActive: true }).button, '🔧 Perbaiki (butuh Administrator)');
  assert.match(firewallBanner(UNCOVERED, { httpsActive: true }).hint, /dinyalakan di app/, 'mengingatkan akses HP tetap dinyalakan di app (📱)');
});

test('banner: failed fix keeps nagging and offers the manual command; success is silent (banner gone)', () => {
  const failed = firewallBanner(UNCOVERED, { httpsActive: true, fixError: 'declined', manual: manualFirewallCommand() });
  assert.match(failed.text, /belum berhasil/);
  assert.equal(failed.manual, manualFirewallCommand(), 'perintah manual (dari server) ikut ditampilkan');
  assert.equal(failed.manual.includes(LEGACY_FIREWALL_RULE_NAME), true, 'perintah manual menghapus aturan legacy juga');
  assert.equal(firewallBanner(COVERED, { httpsActive: true, fixError: 'timeout' }), null, 'covered jadi true → banner hilang');
});
