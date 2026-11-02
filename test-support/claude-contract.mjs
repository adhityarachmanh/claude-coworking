// Contract test against the REAL Claude Code CLI (uses a few cheap Haiku requests).
// Run after updating Claude Code:  npm run test:claude
// It checks every protocol assumption this app relies on, so a breaking CLI change shows up here first.
// The checks live in src/claude-contract.js (the "full" profile); the server runs its "light" profile on its own
// after a Claude Code update (src/claude-check.js).
import { findClaude } from '../src/claude-bin.js';
import { runContract } from '../src/claude-contract.js';

const claude = findClaude();
if (!claude) {
  console.error('Claude Code tidak ditemukan.');
  process.exit(1);
}

const report = await runContract({
  claude,
  profile: 'full',
  onCheck: ({ name, ok, detail }) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`),
});

const failed = report.failing.length;
console.log(`\nClaude Code ${report.version ?? '(versi tidak terbaca)'} · ${Math.round(report.durationMs / 1000)} s`);
console.log(failed ? `${failed} cek gagal — Claude Code mungkin mengubah protokolnya.` : `Semua ${report.checks.length} cek lolos.`);
process.exit(failed ? 1 : 0);
