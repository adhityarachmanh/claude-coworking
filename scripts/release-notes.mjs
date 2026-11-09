#!/usr/bin/env node
// 📝 Release notes from CHANGELOG.md: the `## <version>` section becomes the GitHub Release body.
//   node scripts/release-notes.mjs 1.0.5                 → prints the section
//   node scripts/release-notes.mjs v1.0.5 --out notes.md → writes it to a file (used by the release workflow)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The body for one version. Unknown versions fall back to a short line instead of an empty release. */
export function notesFrom(changelog, version) {
  const wanted = String(version ?? '').trim().replace(/^v/i, '');
  if (!wanted) return '';
  const lines = String(changelog ?? '').split(/\r?\n/);
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+v?${escape(wanted)}\\s*$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return `Rilis v${wanted}`;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim() || `Rilis v${wanted}`;
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex > -1 ? args[outIndex + 1] : null;
  const skip = outIndex > -1 ? outIndex + 1 : -1;
  const version = args.find((arg, i) => !arg.startsWith('--') && i !== skip);
  if (!version) {
    console.error('Pakai: node scripts/release-notes.mjs <versi> [--out file]');
    process.exit(2);
  }
  let changelog = '';
  try {
    changelog = readFileSync(path.join(APP, 'CHANGELOG.md'), 'utf8');
  } catch {
    // a repo without a changelog still gets a minimal release body
  }
  const body = notesFrom(changelog, version);
  if (out) writeFileSync(out, `${body}\n`, 'utf8');
  else process.stdout.write(`${body}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
