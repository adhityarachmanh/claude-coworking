#!/usr/bin/env node
// ✍ Sign a release installer: writes <installer>.sha256 and <installer>.sig (Ed25519, base64).
// Usage: node scripts/sign-release.mjs <installer.exe> <private-key.pem>
import { createHash, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [, , installer, keyFile] = process.argv;
if (!installer || !keyFile) {
  process.stderr.write('Pakai: node scripts/sign-release.mjs <installer.exe> <private-key.pem>\n');
  process.exit(2);
}
const bytes = readFileSync(path.resolve(installer));
const key = readFileSync(path.resolve(keyFile));
const sha = createHash('sha256').update(bytes).digest('hex');
const sig = sign(null, bytes, key).toString('base64');
writeFileSync(`${path.resolve(installer)}.sha256`, `${sha}  ${path.basename(installer)}\n`);
writeFileSync(`${path.resolve(installer)}.sig`, `${sig}\n`);
process.stdout.write(`SHA-256: ${sha}\nSignature: ${path.resolve(installer)}.sig\n`);
