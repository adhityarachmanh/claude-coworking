// OpenCode config/agent editor: safe file IO under a throwaway home/project. No OpenCode process and no network.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { configFile, mergeForm, openCodeConfigRoot, readOpenCodeConfig, saveOpenCodeConfig } from '../src/opencode-config.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-opencode-config-'));
const HOME = path.join(TMP, 'xdg');
const PROJECT = path.join(TMP, 'projects', 'toko');
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};

test('configFile: global under XDG, project root before .opencode, JSONC kept', () => {
  assert.equal(openCodeConfigRoot({ OFFICE_OPENCODE_CONFIG_HOME: HOME }), path.join(HOME, 'opencode'));
  assert.equal(configFile({ scope: 'global', home: HOME }).path, path.join(HOME, 'opencode', 'opencode.json'));
  const projectJson = path.join(PROJECT, 'opencode.json');
  assert.equal(configFile({ scope: 'project', projectPath: PROJECT, home: HOME }).path, projectJson);
  write(path.join(PROJECT, '.opencode', 'opencode.jsonc'), '{}');
  assert.equal(configFile({ scope: 'project', projectPath: PROJECT, home: HOME }).path, path.join(PROJECT, '.opencode', 'opencode.jsonc'), 'an existing .opencode file is used');
  write(projectJson, '{}');
  assert.equal(configFile({ scope: 'project', projectPath: PROJECT, home: HOME }).path, projectJson, 'the project root wins when both exist');
});

test('readOpenCodeConfig: agents expose name/mode/model/prompt, missing file is empty', () => {
  const file = path.join(HOME, 'opencode', 'opencode.jsonc');
  write(file, `{
    // a comment survives a raw JSON save
    "model": "anthropic/claude-sonnet-4",
    "small_model": "anthropic/claude-haiku",
    "agent": {
      "reviewer": { "mode": "subagent", "model": "openai/gpt-5", "description": "Review changes", "system": "Be strict" },
      "helper": { "prompt": "Help" }
    }
  }`);
  const view = readOpenCodeConfig({ scope: 'global', home: HOME });
  assert.equal(view.exists, true);
  assert.equal(view.format, 'jsonc');
  assert.equal(view.config.model, 'anthropic/claude-sonnet-4');
  assert.deepEqual(view.agents, [
    { name: 'helper', mode: '', model: '', description: '', prompt: 'Help' },
    { name: 'reviewer', mode: 'subagent', model: 'openai/gpt-5', description: 'Review changes', prompt: 'Be strict' },
  ]);
  assert.match(view.text, /a comment survives/);
  const missing = readOpenCodeConfig({ scope: 'project', projectPath: path.join(TMP, 'empty'), home: HOME });
  assert.deepEqual({ exists: missing.exists, config: missing.config, agents: missing.agents }, { exists: false, config: {}, agents: [] });
});

test('save JSON keeps comments and makes a timestamped backup', () => {
  const file = path.join(HOME, 'opencode', 'opencode.jsonc');
  write(file, '{\n  // keep me\n  "model": "lama",\n}\n');
  const text = '{\n  // keep me\n  "model": "baru",\n}\n';
  const saved = saveOpenCodeConfig({ scope: 'global', home: HOME, mode: 'json', text });
  assert.equal(readFileSync(file, 'utf8'), text, 'raw text is written as typed (comments stay)');
  assert.ok(saved.backup && saved.backup.startsWith(`${file}.bak-`), `backup: ${saved.backup}`);
  assert.match(readFileSync(saved.backup, 'utf8'), /lama/);
  assert.equal(saved.config.model, 'baru');
});

test('save form merges model/small model and agents, preserving unknown fields', () => {
  const file = path.join(PROJECT, 'opencode.json');
  write(file, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: 'lama',
    agent: {
      keep: { mode: 'primary', tools: { bash: false }, system: 'old prompt' },
      gone: { mode: 'subagent' },
    },
  }));
  const saved = saveOpenCodeConfig({
    scope: 'project',
    projectPath: PROJECT,
    home: HOME,
    mode: 'form',
    form: {
      model: 'anthropic/claude-opus-4',
      smallModel: '',
      agents: [{ name: 'keep', mode: 'primary', model: 'openai/gpt-5', description: '', prompt: 'new prompt' }],
    },
  });
  assert.equal(saved.config.$schema, 'https://opencode.ai/config.json');
  assert.equal(saved.config.model, 'anthropic/claude-opus-4');
  assert.equal(saved.config.small_model, undefined, 'blank small model removes the key');
  assert.deepEqual(Object.keys(saved.config.agent), ['keep']);
  assert.deepEqual(saved.config.agent.keep, {
    mode: 'primary',
    tools: { bash: false },
    system: 'new prompt',
    model: 'openai/gpt-5',
  });
  assert.deepEqual(saved.agents, [{ name: 'keep', mode: 'primary', model: 'openai/gpt-5', description: '', prompt: 'new prompt' }]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), saved.config);
});

test('a broken config is still readable (so the JSON tab can fix it); a form save refuses', () => {
  const file = path.join(PROJECT, 'opencode.json');
  write(file, '{ broken\n');
  const view = readOpenCodeConfig({ scope: 'project', projectPath: PROJECT, home: HOME });
  assert.equal(view.exists, true);
  assert.equal(view.text, '{ broken\n');
  assert.deepEqual(view.config, {});
  assert.match(view.parseError, /JSON\/JSONC/);
  assert.throws(() => saveOpenCodeConfig({ scope: 'project', projectPath: PROJECT, home: HOME, mode: 'form', form: { model: 'x' } }), /tab JSON/);
  const fixed = saveOpenCodeConfig({ scope: 'project', projectPath: PROJECT, home: HOME, mode: 'json', text: '{"model":"x"}\n' });
  assert.equal(fixed.parseError, null);
  assert.equal(fixed.config.model, 'x');
});

test('a form save refuses a malformed agent section instead of deleting it', () => {
  const file = path.join(PROJECT, 'opencode.json');
  write(file, '{"agent":["bukan objek"]}\n');
  const view = readOpenCodeConfig({ scope: 'project', projectPath: PROJECT, home: HOME });
  assert.throws(() => mergeForm(view.config, { agents: [] }), /"agent" bukan objek/i);
  write(file, '{"agent":{"rusak":"bukan objek"}}\n');
  const view2 = readOpenCodeConfig({ scope: 'project', projectPath: PROJECT, home: HOME });
  assert.throws(() => mergeForm(view2.config, { agents: [] }), /Agent "rusak" bukan objek/i);
});

test('invalid JSON, non-objects and bad agent names are refused without changing the file', () => {
  const file = path.join(PROJECT, 'opencode.json');
  write(file, '{"model":"aman"}\n');
  assert.throws(() => saveOpenCodeConfig({ scope: 'project', projectPath: PROJECT, home: HOME, mode: 'json', text: '{"model":' }), /JSON/);
  assert.throws(() => saveOpenCodeConfig({ scope: 'project', projectPath: PROJECT, home: HOME, mode: 'json', text: '[]' }), /objek JSON/);
  assert.throws(() => mergeForm({}, { agents: [{ name: 'bad name' }] }), /nama agent/i);
  assert.throws(() => mergeForm({}, { agents: [{ name: 'a' }, { name: 'a' }] }), /ganda/i);
  assert.equal(readFileSync(file, 'utf8'), '{"model":"aman"}\n');
});
