// 🚦 CI workflows: a release is only published once every platform uploaded, and the heavy suite runs nightly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(path.join(APP, '.github', 'workflows', name), 'utf8');

test('release: draft first, publish only after windows, linux and macOS', () => {
  const workflow = read('release.yml');
  assert.match(workflow, /gh release create [^\n]*--draft/, 'a new release starts as a draft');
  assert.match(workflow, /^\s{2}publish:/m, 'there is a publish job');
  assert.match(workflow, /needs: \[windows, linux, macos\]/, 'publish waits for every platform');
  assert.match(workflow, /--draft=false/, 'publish flips the draft only at the end');
  assert.match(workflow, /^\s{2}macos:/m, 'macOS builds inside the release workflow');
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(publish, /actions\/checkout@v4/, 'gh needs a checkout to resolve the repository');
});

test('release: publish refuses a release with a missing asset or signature', () => {
  const workflow = read('release.yml');
  for (const asset of [
    "AdhitOffice-Setup-[0-9.]+\\.exe$",
    "AdhitOffice-Setup-[0-9.]+\\.exe\\.sig$",
    "AdhitOffice-[0-9.]+-linux-x64\\.tar\\.gz$",
    "adhit-office_[0-9.]+_amd64\\.deb$",
    "AdhitOffice-[0-9.]+-macos-arm64-unsigned\\.zip$",
    "AdhitOffice-[0-9.]+-macos-x64-unsigned\\.zip$",
  ]) {
    assert.ok(workflow.includes(asset), `publish checks ${asset}`);
  }
  assert.match(workflow, /exit \$missing/, 'a missing asset fails the publish job');
});

test('build-macos is manual only; tag releases go through release.yml', () => {
  const workflow = read('build-macos.yml');
  assert.doesNotMatch(workflow, /tags: \['v\*'\]/, 'no second macOS build on tags');
  assert.doesNotMatch(workflow, /gh release/);
});

test('nightly runs the integration suite on Windows and Linux', () => {
  const workflow = read('nightly.yml');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /test-support\/ci-tests\.mjs unit/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /ubuntu-latest/);
});
