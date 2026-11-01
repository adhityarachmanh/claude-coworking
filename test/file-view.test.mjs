import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSecretPath, languageOf } from '../src/file-view.js';

test('likely secrets: .env*, keys, id_*, credentials and key folders; examples and public keys are not', () => {
  const secret = ['.env', '.env.local', '.env.production', 'app/.ENV', 'certs/server.pem', 'tls.key', 'store.p12', 'id_rsa', 'id_ed25519', '.ssh/config', '.aws/config', 'credentials', 'credentials.json', 'gcp-credentials.json', '.npmrc', '.netrc', '.git-credentials', 'secrets.yaml', 'config\\secrets.json', 'service-account-prod.json'];
  const plain = ['.env.example', '.env.sample', '.env.template', 'id_rsa.pub', 'src/env.ts', 'README.md', 'src/keyboard.js', 'docs/credentials.md', 'environment.yml', 'src/identity.js'];
  for (const p of secret) assert.ok(isSecretPath(p), p);
  for (const p of plain) assert.ok(!isSecretPath(p), p);
});

test('language from the file name', () => {
  const cases = { 'a.js': 'js', 'b.MJS': 'js', 'c.tsx': 'ts', 'Dockerfile': 'dockerfile', '.env.local': 'env', 'x.py': 'py', 'run.ps1': 'ps1', 'q.sql': 'sql', 'conf.yml': 'yaml', 'LICENSE': 'text', 'notes.weird': 'text', Makefile: 'sh' };
  for (const [name, lang] of Object.entries(cases)) assert.equal(languageOf(name), lang, name);
});
