#!/usr/bin/env node
// 🔑 Generate an Ed25519 release-signing keypair. The private key stays outside the repo; the public key is
// copied to assets/update-pubkey.pem so builds enforce a valid .sig for every update.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(ROOT, '.keys'));
const privateFile = path.join(out, 'update-private-key.pem');
const publicFile = path.join(out, 'update-public-key.pem');
if (existsSync(privateFile)) {
  process.stderr.write(`Kunci sudah ada: ${privateFile}\nHapus/rename dulu bila benar-benar ingin membuat kunci baru.\n`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(publicFile, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
const target = path.join(ROOT, 'assets', 'update-pubkey.pem');
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
process.stdout.write([
  `Private key: ${privateFile}  (JANGAN commit; simpan di tempat aman/CI secret)`,
  `Public key : ${publicFile}`,
  `Disalin ke : ${target} (ikut build; update wajib .sig)`,
  '',
  'Tanda tangani rilis:',
  `  node scripts/sign-release.mjs dist/installer/Adhitron-Setup-<versi>.exe ${privateFile}`,
  '',
].join('\n'));
