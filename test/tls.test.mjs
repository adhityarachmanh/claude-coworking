// src/tls.js: the HTTPS certificate from `tailscale cert`, with a fake CLI (never the real Tailscale,
// never a real certificate request). Certificates are made on the fly by test-support/x509.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXPIRING_MS, HTTPS_STATES, TailscaleCert, cliRunner, findTailscale, httpsPortFrom, inspectCert, restrictDir, splitPem } from '../src/tls.js';
import { selfSignedCert } from '../test-support/x509.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-tls-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const HOST = 'arh-3.taild0f8a1.ts.net';
const DAY = 86_400_000;
let n = 0;
const freshDir = () => path.join(TMP, `d${n++}`);
const certFor = (host, days) => selfSignedCert({ cn: host, dns: [host], ips: [], notAfter: new Date(Date.now() + days * DAY) });

/**
 * A fake CLI: `status --json` from `status`, `cert` writes `issue` (a {cert,key} pair) to the requested files.
 * Records every call.
 */
function fakeCli({ status = { BackendState: 'Running', Self: { DNSName: `${HOST}.` }, CertDomains: [HOST] }, issue, certError } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'status') {
      if (status instanceof Error) throw status;
      return JSON.stringify(status);
    }
    if (args[0] === 'cert') {
      if (certError) throw Object.assign(new Error('exit 1'), { stderr: certError });
      const at = (flag) => args[args.indexOf(flag) + 1];
      writeFileSync(at('--cert-file'), issue.cert);
      writeFileSync(at('--key-file'), issue.key);
      return '';
    }
    throw new Error(`unexpected ${args}`);
  };
  return { run, calls };
}

const quiet = () => {};
const noop = async () => {};

test('state values are the documented set', () => {
  assert.deepEqual([...HTTPS_STATES], ['off', 'no-tailscale', 'certs-disabled', 'ok', 'expiring', 'expired', 'error']);
});

test('finding the CLI: OFFICE_TAILSCALE_BIN; Windows default install before PATH; only absolute PATH folders', () => {
  const has = (files) => (f) => files.includes(f);
  const W = path.win32;
  assert.equal(findTailscale({ OFFICE_TAILSCALE_BIN: 'D:\\ts\\tailscale.exe' }, 'win32', has(['D:\\ts\\tailscale.exe'])), 'D:\\ts\\tailscale.exe');
  assert.equal(findTailscale({ OFFICE_TAILSCALE_BIN: 'D:\\missing.exe', PATH: 'C:\\bin' }, 'win32', has(['C:\\bin\\tailscale.exe'])), null, 'an explicit path that does not exist: not installed (no fallback)');
  const installed = W.join('C:\\Program Files', 'Tailscale', 'tailscale.exe');
  const onPath = W.join('C:\\tools', 'tailscale.exe');
  assert.equal(findTailscale({ ProgramFiles: 'C:\\Program Files', PATH: 'C:\\nothing;C:\\tools' }, 'win32', has([installed, onPath])), installed, '%ProgramFiles% wins over PATH');
  assert.equal(findTailscale({ ProgramFiles: 'C:\\Program Files', PATH: 'C:\\nothing;C:\\tools' }, 'win32', has([onPath])), onPath);
  // relative PATH entries (".", "bin", "") are never searched: they resolve against the working directory
  const relative = ['.', 'bin', '..\\x'].map((d) => W.join(d, 'tailscale.exe'));
  assert.equal(findTailscale({ ProgramFiles: 'C:\\nope', PATH: '.;bin;;..\\x' }, 'win32', has(relative)), null);
  assert.equal(findTailscale({ PATH: '.:bin:/usr/bin' }, 'linux', has(['tailscale', 'bin/tailscale', '/usr/bin/tailscale'])), '/usr/bin/tailscale');
  assert.equal(findTailscale({ PATH: '' }, 'linux', has([])), null);
});

test('the tls folder is restricted to the current user (best effort, failures only logged)', async (t) => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  const logs = [];
  await restrictDir(dir, (m) => logs.push(m));
  if (process.platform === 'win32') {
    assert.deepEqual(logs, [], 'icacls succeeded');
    const acl = execFileSync('icacls', [dir], { windowsHide: true, encoding: 'utf8' });
    assert.match(acl, new RegExp(`${process.env.USERNAME}:\\(OI\\)\\(CI\\)\\(F\\)`, 'i'));
    assert.doesNotMatch(acl, /\(I\)/, 'no inherited entries left');
  } else {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  }
  // a folder that does not exist: logged, never thrown
  const missing = [];
  await restrictDir(path.join(TMP, 'does-not-exist'), (m) => missing.push(m));
  assert.equal(missing.length, 1);
  t.diagnostic(missing[0]);
});

test('no CLI: no-tailscale, nothing served, HTTP unaffected', async () => {
  const tls = new TailscaleCert({ dir: freshDir(), bin: null, log: quiet, secureDir: noop });
  await tls.refresh();
  assert.equal(tls.state, 'no-tailscale');
  assert.equal(tls.usable, false);
  assert.equal(tls.host, null);
  assert.deepEqual(Object.keys(tls.publicInfo(4318)).sort(), ['checkedAt', 'error', 'host', 'state', 'url', 'validTo']);
});

test('phone access off: state off and the CLI is never run', async () => {
  const cli = fakeCli({ issue: certFor(HOST, 80) });
  const tls = new TailscaleCert({ dir: freshDir(), enabled: () => false, run: cli.run, log: quiet, secureDir: noop });
  await tls.refresh();
  assert.equal(tls.state, 'off');
  assert.equal(cli.calls.length, 0);
  assert.equal(tls.publicInfo(4318).error, null);
});

test('Tailscale installed but not connected / not logged in: no-tailscale', async () => {
  for (const status of [{ BackendState: 'Stopped', Self: { DNSName: `${HOST}.` }, CertDomains: null }, { BackendState: 'NeedsLogin' }, Object.assign(new Error('exit 1'), { code: 1 })]) {
    const cli = fakeCli({ status });
    const tls = new TailscaleCert({ dir: freshDir(), run: cli.run, log: quiet, secureDir: noop });
    await tls.refresh();
    assert.equal(tls.state, 'no-tailscale', JSON.stringify(status));
    assert.ok(!cli.calls.some((a) => a[0] === 'cert'), 'no certificate requested');
  }
});

test('HTTPS Certificates off in the tailnet (CertDomains empty): certs-disabled, no cert request, clear hint', async () => {
  for (const CertDomains of [null, [], ['other.taild0f8a1.ts.net']]) {
    const cli = fakeCli({ status: { BackendState: 'Running', Self: { DNSName: `${HOST}.` }, CertDomains } });
    const tls = new TailscaleCert({ dir: freshDir(), run: cli.run, log: quiet, secureDir: noop });
    await tls.refresh();
    assert.equal(tls.state, 'certs-disabled');
    assert.match(tls.publicInfo(4318).error, /HTTPS Certificates/);
    assert.deepEqual(cli.calls, [['status', '--json']], 'only the status was asked');
    assert.equal(tls.publicInfo(4318).url, null);
  }
  // no MagicDNS name at all
  const cli = fakeCli({ status: { BackendState: 'Running', Self: { DNSName: '' }, CertDomains: [] } });
  const tls = new TailscaleCert({ dir: freshDir(), run: cli.run, log: quiet, secureDir: noop });
  await tls.refresh();
  assert.equal(tls.state, 'certs-disabled');
  assert.match(tls.publicInfo(4318).error, /MagicDNS/);
});

test('success: certificate written to the folder, validated, state ok; never --force; no key or path exposed', async () => {
  const dir = freshDir();
  const issued = certFor(HOST, 80);
  const cli = fakeCli({ issue: issued });
  const changes = [];
  const tls = new TailscaleCert({ dir, run: cli.run, log: quiet, secureDir: noop, onChange: (info) => changes.push(info) });
  await tls.refresh();
  assert.equal(tls.state, 'ok');
  assert.equal(tls.host, HOST);
  const info = tls.publicInfo(4318);
  assert.equal(info.url, `https://${HOST}:4318`);
  assert.ok(info.validTo > Date.now() + 70 * DAY);
  assert.equal(info.error, null);
  assert.ok(!JSON.stringify(info).includes('PRIVATE KEY') && !JSON.stringify(info).includes(dir), 'no key, no path');
  assert.equal(changes.length, 1, 'listeners are told once');
  const certCall = cli.calls.find((a) => a[0] === 'cert');
  assert.ok(certCall, 'cert requested');
  assert.ok(!certCall.includes('--force'), 'never --force (Let\'s Encrypt rate limits)');
  assert.equal(certCall.at(-1), HOST);
  assert.deepEqual(readdirSync(dir).sort(), [`${HOST}.pem`, 'last-host'], 'one combined file, no temp files left');
  const onDisk = splitPem(readFileSync(path.join(dir, `${HOST}.pem`), 'utf8'));
  assert.equal(onDisk.key.trim(), issued.key.trim());
  assert.equal(onDisk.cert.trim(), issued.cert.trim());
  assert.equal(readFileSync(path.join(dir, 'last-host'), 'utf8').trim(), HOST);
  assert.equal(tls.material.cert, issued.cert);

  // the same certificate again: nothing changes, nobody is told
  await tls.refresh();
  assert.equal(changes.length, 1);
  // a renewed certificate: new fingerprint, listeners told (server.js swaps it in with setSecureContext)
  const renewed = certFor(HOST, 89);
  const cli2 = fakeCli({ issue: renewed });
  tls.run = cli2.run;
  await tls.refresh();
  assert.equal(changes.length, 2);
  assert.equal(tls.material.cert, renewed.cert);
});

test('a certificate for another name or already expired is refused and never replaces the good one', async () => {
  const dir = freshDir();
  const good = certFor(HOST, 80);
  const tls = new TailscaleCert({ dir, run: fakeCli({ issue: good }).run, log: quiet, secureDir: noop });
  await tls.refresh();
  assert.equal(tls.state, 'ok');

  tls.run = fakeCli({ issue: certFor('someone-else.ts.net', 80) }).run;
  await tls.refresh();
  assert.equal(tls.state, 'ok', 'the good certificate is still served');
  assert.match(tls.publicInfo(4318).error, /bukan untuk/);
  assert.equal(splitPem(readFileSync(path.join(dir, `${HOST}.pem`), 'utf8')).cert.trim(), good.cert.trim(), 'file not replaced');
  assert.deepEqual(readdirSync(dir).sort(), [`${HOST}.pem`, 'last-host']);

  // a fresh install that only ever got bad answers
  const wrongHost = new TailscaleCert({ dir: freshDir(), run: fakeCli({ issue: certFor('someone-else.ts.net', 80) }).run, log: quiet, secureDir: noop });
  await wrongHost.refresh();
  assert.equal(wrongHost.state, 'error');
  const expired = selfSignedCert({ cn: HOST, dns: [HOST], ips: [], notBefore: new Date(Date.now() - 100 * DAY), notAfter: new Date(Date.now() - DAY) });
  const stale = new TailscaleCert({ dir: freshDir(), run: fakeCli({ issue: expired }).run, log: quiet, secureDir: noop });
  await stale.refresh();
  assert.equal(stale.state, 'expired');
  assert.equal(stale.usable, false);
  // key that does not belong to the certificate
  const mixed = new TailscaleCert({ dir: freshDir(), run: fakeCli({ issue: { cert: good.cert, key: certFor(HOST, 80).key } }).run, log: quiet, secureDir: noop });
  await mixed.refresh();
  assert.equal(mixed.state, 'error');
});

test('14 days or less left: expiring (still served, with a warning)', async () => {
  const tls = new TailscaleCert({ dir: freshDir(), run: fakeCli({ issue: certFor(HOST, 10) }).run, log: quiet, secureDir: noop });
  await tls.refresh();
  assert.equal(tls.state, 'expiring');
  assert.equal(tls.usable, true);
  assert.ok(EXPIRING_MS === 14 * DAY);
});

test('CLI fails (e.g. needs admin) while a valid certificate exists: keep serving it, report the error', async () => {
  const dir = freshDir();
  const tls = new TailscaleCert({ dir, run: fakeCli({ issue: certFor(HOST, 80) }).run, log: quiet, secureDir: noop });
  await tls.refresh();
  tls.run = fakeCli({ certError: 'Access denied: cert access denied' }).run;
  await tls.refresh();
  assert.equal(tls.state, 'ok');
  assert.match(tls.publicInfo(4318).error, /admin/);
  assert.deepEqual(readdirSync(dir).sort(), [`${HOST}.pem`, 'last-host'], 'temp files cleaned up');
  // Tailscale went offline: same (the cached certificate is used until it expires)
  tls.run = fakeCli({ status: Object.assign(new Error('not running'), { code: 1 }) }).run;
  await tls.refresh();
  assert.equal(tls.state, 'ok');
  // without a certificate, the same failure is an error state
  const none = new TailscaleCert({ dir: freshDir(), run: fakeCli({ certError: 'boom' }).run, log: quiet, secureDir: noop });
  await none.refresh();
  assert.equal(none.state, 'error');
});

test('machine or tailnet renamed: the old certificate stops being served', async () => {
  const tls = new TailscaleCert({ dir: freshDir(), run: fakeCli({ issue: certFor(HOST, 80) }).run, log: quiet, secureDir: noop });
  await tls.refresh();
  tls.run = fakeCli({ status: { BackendState: 'Running', Self: { DNSName: 'new-name.taild0f8a1.ts.net.' }, CertDomains: [] } }).run;
  await tls.refresh();
  assert.equal(tls.state, 'certs-disabled');
  assert.equal(tls.host, null);
});

test('start: a valid certificate on disk is used before (and without) asking Tailscale', async () => {
  const dir = freshDir();
  const first = new TailscaleCert({ dir, run: fakeCli({ issue: certFor(HOST, 80) }).run, log: quiet, secureDir: noop });
  await first.refresh();
  writeFileSync(path.join(dir, 'broken.example.pem'), 'not a cert'); // ignored
  writeFileSync(path.join(dir, `${HOST}.pem.new`), 'half-written'); // a write cut short: removed
  const cli = fakeCli();
  const later = new TailscaleCert({ dir, enabled: () => false, run: cli.run, log: quiet, secureDir: noop });
  await later.start();
  later.stop();
  assert.equal(later.usable, true);
  assert.equal(later.host, HOST);
  assert.equal(later.state, 'off', 'phone access off: reported as off');
  assert.equal(cli.calls.length, 0, 'phone access off: Tailscale not asked');
  assert.ok(!existsSync(path.join(dir, `${HOST}.pem.new`)), 'leftover temp file removed');
});

test('several names on disk: last-host is preferred at start; a successful fetch removes the other names', async () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  const OLD = 'old-name.taild0f8a1.ts.net';
  const write = (host, days) => {
    const c = certFor(host, days);
    writeFileSync(path.join(dir, `${host}.pem`), `${c.key}${c.cert}`);
  };
  write(OLD, 85); // newer, but not the name served last
  write(HOST, 60);
  writeFileSync(path.join(dir, 'last-host'), `${HOST}\n`);
  const tls = new TailscaleCert({ dir, enabled: () => false, run: fakeCli().run, log: quiet, secureDir: noop });
  await tls.loadFromDisk();
  assert.equal(tls.host, HOST, 'last-host wins over a longer-lived certificate for another name');
  // last-host pointing at an expired / missing certificate: the newest valid one is used
  writeFileSync(path.join(dir, 'last-host'), 'gone.taild0f8a1.ts.net\n');
  const fallback = new TailscaleCert({ dir, enabled: () => false, run: fakeCli().run, log: quiet, secureDir: noop });
  await fallback.loadFromDisk();
  assert.equal(fallback.host, OLD);
  // fetch for HOST: other names' files (and any legacy .crt/.key) are deleted, last-host updated
  writeFileSync(path.join(dir, 'legacy.crt'), 'x');
  writeFileSync(path.join(dir, 'legacy.key'), 'x');
  let secured = 0;
  const fetcher = new TailscaleCert({ dir, run: fakeCli({ issue: certFor(HOST, 80) }).run, log: quiet, secureDir: async () => secured++ });
  await fetcher.refresh();
  assert.equal(fetcher.state, 'ok');
  assert.deepEqual(readdirSync(dir).sort(), [`${HOST}.pem`, 'last-host']);
  assert.equal(readFileSync(path.join(dir, 'last-host'), 'utf8').trim(), HOST);
  assert.equal(secured, 1, 'folder permissions restricted before the key is written');
});

test('splitPem: key and chain from one file, in any order', () => {
  const c = certFor(HOST, 80);
  const other = certFor('intermediate.example', 400);
  for (const pem of [`${c.key}${c.cert}${other.cert}`, `${c.cert}${other.cert}${c.key}`]) {
    const { key, cert } = splitPem(pem);
    assert.equal(key.trim(), c.key.trim());
    assert.equal((cert.match(/BEGIN CERTIFICATE/g) ?? []).length, 2);
    assert.equal(inspectCert(cert, key, HOST).host, HOST);
  }
  assert.deepEqual(splitPem('nothing'), { key: '', cert: '' });
});

test('expiry while running is noticed without running the CLI (tick)', async () => {
  let now = Date.now();
  const changes = [];
  const tls = new TailscaleCert({ dir: freshDir(), run: fakeCli({ issue: certFor(HOST, 30) }).run, now: () => now, log: quiet, secureDir: noop, onChange: (i) => changes.push(i.state) });
  await tls.refresh();
  assert.equal(tls.state, 'ok');
  tls.tick();
  assert.deepEqual(changes, ['ok'], 'no change, no event');
  now += 20 * DAY;
  tls.tick();
  now += 20 * DAY;
  tls.tick();
  tls.tick();
  assert.deepEqual(changes, ['ok', 'expiring', 'expired']);
  assert.equal(tls.usable, false);
  assert.equal(tls.host, null);
});

test('inspectCert: chain files use the first certificate', () => {
  const leaf = certFor(HOST, 80);
  const other = certFor('intermediate.example', 400);
  const found = inspectCert(leaf.cert + other.cert, leaf.key, HOST);
  assert.equal(found.host, HOST);
  assert.throws(() => inspectCert('garbage', leaf.key, HOST), /rusak/);
});

test('cliRunner runs a .mjs fake CLI under node (no shell, hidden window) and the whole flow works', async () => {
  const dir = freshDir();
  const issued = certFor('office.test', 80);
  const certFile = path.join(TMP, 'issued.crt');
  const keyFile = path.join(TMP, 'issued.key');
  writeFileSync(certFile, issued.cert);
  writeFileSync(keyFile, issued.key);
  const config = path.join(TMP, 'fake-ts.json');
  writeFileSync(config, JSON.stringify({ host: 'office.test', certDomains: true, certFile, keyFile }));
  process.env.FAKE_TAILSCALE_CONFIG = config;
  try {
    const tls = new TailscaleCert({ dir, run: cliRunner(path.join(APP, 'test-support', 'fake-tailscale.mjs')), log: quiet, secureDir: noop });
    await tls.refresh();
    assert.equal(tls.state, 'ok');
    assert.equal(tls.host, 'office.test');
    assert.ok(existsSync(path.join(dir, 'office.test.pem')));
  } finally {
    delete process.env.FAKE_TAILSCALE_CONFIG;
  }
});

test('OFFICE_HTTPS_PORT: validated; a clash with OFFICE_PORT turns HTTPS off instead of crashing', () => {
  assert.deepEqual(httpsPortFrom(undefined, 4317), { port: 4318, warning: null });
  assert.deepEqual(httpsPortFrom('', 4317), { port: 4318, warning: null });
  assert.deepEqual(httpsPortFrom('8443', 4317), { port: 8443, warning: null });
  assert.deepEqual(httpsPortFrom(' 443 ', 4317), { port: 443, warning: null });
  for (const bad of ['0', '65536', '-1', '4318.5', 'abc', '1e3', '0x10cf']) {
    const r = httpsPortFrom(bad, 4317);
    assert.equal(r.port, 4318, bad);
    assert.match(r.warning, /tidak valid/, bad);
  }
  assert.equal(httpsPortFrom('4317', 4317).port, null, 'same as the http port: HTTPS off');
  assert.match(httpsPortFrom('4317', 4317).warning, /dimatikan/);
  assert.equal(httpsPortFrom('nonsense', 4318).port, null, 'the fallback clashes too: HTTPS off');
});
