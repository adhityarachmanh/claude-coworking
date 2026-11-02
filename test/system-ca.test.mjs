// The OS certificate store is trusted too, so TLS-inspecting proxies (Zscaler, antivirus) don't break fetch().
import assert from 'node:assert/strict';
import { test } from 'node:test';
import tls from 'node:tls';
import { fingerprint, trustSystemCertificates } from '../src/system-ca.js';

test('system root certificates join the default trust list (verification stays on)', (t) => {
  if (typeof tls.setDefaultCACertificates !== 'function') return t.skip('Node without tls.setDefaultCACertificates');
  const bundled = tls.getCACertificates('default').map(fingerprint);
  const added = trustSystemCertificates();
  const now = new Set(tls.getCACertificates('default').map(fingerprint));
  for (const cert of tls.getCACertificates('system')) assert.ok(now.has(fingerprint(cert)), 'every system root is trusted');
  for (const fp of bundled) assert.ok(now.has(fp), "Node's own list is kept, not replaced");
  assert.equal(now.size, new Set(bundled).size + added, 'only the new ones are counted');
  assert.equal(trustSystemCertificates(), 0, 'a second call adds nothing new');
});
