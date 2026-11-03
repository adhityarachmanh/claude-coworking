// Contract test against the REAL OpenCode CLI (`opencode acp`). Run after updating OpenCode:  npm run test:opencode
// It checks every protocol assumption this app relies on (docs/design-opencode.md), so a breaking change shows up
// here first. The checks live in src/opencode-contract.js (the "full" profile: the token-free checks plus a short
// protocol run — a text turn, a permission request that is rejected, a cancel — with a model). The server runs the
// token-free "light" profile on its own after an OpenCode update (src/opencode-check.js).
//
//   npm run test:opencode                         model: opencode-go/beam-free when offered, else OpenCode's default
//   npm run test:opencode -- --light              token-free checks only (what the server runs)
//   OPENCODE_CONTRACT_MODEL=google/gemini-2.5-flash npm run test:opencode
// Every step is bounded (total ≤ 10 min); every OpenCode process is stopped (whole tree) at the end.
import { findOpenCode } from '../src/opencode-bin.js';
import { runOpenCodeContract } from '../src/opencode-contract.js';

const bin = findOpenCode();
if (!bin) {
  console.error('OpenCode tidak ditemukan (npm i -g @opencode/cli, atau set env OPENCODE_BIN).');
  process.exit(1);
}

const light = process.argv.includes('--light');
const model = process.env.OPENCODE_CONTRACT_MODEL || 'opencode-go/beam-free';
const report = await runOpenCodeContract({
  bin,
  profile: light ? 'light' : 'full',
  model,
  onCheck: ({ name, ok, detail }) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`),
});

const failed = report.failing.length;
console.log(`\nOpenCode ${report.version ?? '(versi tidak terbaca)'} · ${light ? 'ringan (tanpa token)' : `lengkap (model ${model})`} · ${Math.round(report.durationMs / 1000)} s`);
console.log(failed ? `${failed} cek gagal — OpenCode mungkin mengubah protokolnya.` : `Semua ${report.checks.length} cek lolos.`);
process.exit(failed ? 1 : 0);
