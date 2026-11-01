#!/usr/bin/env node
// Test-only stand-in for the Tailscale CLI (OFFICE_TAILSCALE_BIN): answers `status --json` and
// `cert --cert-file X --key-file Y <host>` from a JSON file named by FAKE_TAILSCALE_CONFIG, re-read on
// every call so a test can change the scenario while the server runs. Never touches the real Tailscale.
//   { "backend": "Running", "host": "office.test", "certDomains": true, "certFile": "...", "keyFile": "...", "certFails": false }
import { appendFileSync, copyFileSync, readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(process.env.FAKE_TAILSCALE_CONFIG, 'utf8'));
const args = process.argv.slice(2);
if (config.log) appendFileSync(config.log, `${JSON.stringify(args)}\n`);

if (args[0] === 'status' && args[1] === '--json') {
  const dns = config.host ? `${config.host}.` : '';
  process.stdout.write(JSON.stringify({ BackendState: config.backend ?? 'Running', Self: { DNSName: dns }, CertDomains: config.certDomains ? [config.host] : null }));
  process.exit(0);
}

if (args[0] === 'cert') {
  if (config.certFails) {
    process.stderr.write('Access denied: cert access denied\n');
    process.exit(1);
  }
  const at = (flag) => args[args.indexOf(flag) + 1];
  copyFileSync(config.certFile, at('--cert-file'));
  copyFileSync(config.keyFile, at('--key-file'));
  process.exit(0);
}

process.stderr.write(`fake-tailscale: unsupported ${args.join(' ')}\n`);
process.exit(2);
