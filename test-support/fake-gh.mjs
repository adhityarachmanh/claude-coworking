#!/usr/bin/env node
// A fake GitHub CLI for tests (OFFICE_GH_BIN): auth status / auth login --web (device code) / pr create.
// State in FAKE_GH_STATE (a file: present = logged in); `pr create` appends its argv to FAKE_GH_LOG.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const [cmd, sub, ...rest] = process.argv.slice(2);
const state = process.env.FAKE_GH_STATE;
if (cmd === 'auth' && sub === 'status') {
  if (state && existsSync(state)) {
    process.stderr.write('github.com\n  ✓ Logged in to github.com account tester (keyring)\n');
    process.exit(0);
  }
  process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\n');
  process.exit(1);
}
if (cmd === 'auth' && sub === 'login') {
  process.stdout.write('! First copy your one-time code: ABCD-1234\nPress Enter to open https://github.com/login/device in your browser... ');
  process.stdin.once('data', () => {
    setTimeout(() => {
      if (state) writeFileSync(state, 'tester');
      process.stdout.write('\n✓ Authentication complete.\n');
      process.exit(0);
    }, 300);
  });
} else if (cmd === 'pr' && sub === 'create') {
  if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(rest)}\n`);
  console.log('https://github.com/acme/toko/pull/7');
  process.exit(0);
} else if (!(cmd === 'auth' && sub === 'login')) {
  process.exit(2);
}
