// Read and write the user's own OpenCode config (opencode.json / opencode.jsonc): global and per project.
// Nothing here starts OpenCode. Writes are explicit, validated, and always leave a backup of the previous file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonc } from './opencode-bin.js';

export const OPENCODE_CONFIG_LIMITS = Object.freeze({ bytes: 512 * 1024, agents: 50, name: 64, description: 500, model: 200, prompt: 20_000 });
const AGENT_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
const AGENT_MODES = new Set(['primary', 'subagent', 'all']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
export class OpenCodeConfigError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The `opencode` folder inside the user's config root (XDG, HOME, or the test override). */
export function openCodeConfigRoot(env = process.env) {
  const base = env.OFFICE_OPENCODE_CONFIG_HOME || env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'opencode');
}

const configRoot = (home) => openCodeConfigRoot(home ? { OFFICE_OPENCODE_CONFIG_HOME: home } : process.env);
const existing = (dir, names) => names.map((name) => path.join(dir, name)).find((file) => existsSync(file));
const formatOf = (file, text) => {
  if (path.extname(file) === '.jsonc') return 'jsonc';
  try {
    JSON.parse(text);
    return 'json';
  } catch {
    return 'jsonc'; // comments or trailing commas: still valid for OpenCode, but a form save loses them
  }
};

/** The file this scope edits. Project root wins over `.opencode/`; an existing file is never silently replaced. */
export function configFile({ scope, projectPath, home } = {}) {
  if (scope === 'global') {
    const dir = configRoot(home);
    const file = existing(dir, ['opencode.json', 'opencode.jsonc', 'config.json']) ?? path.join(dir, 'opencode.json');
    return { path: file, exists: existsSync(file), format: path.extname(file) === '.jsonc' ? 'jsonc' : 'json' };
  }
  if (scope !== 'project') throw new OpenCodeConfigError(400, 'Cakupan config harus global atau project.');
  if (typeof projectPath !== 'string' || !projectPath) throw new OpenCodeConfigError(400, 'Project tidak valid.');
  const root = projectPath;
  const file = existing(root, ['opencode.json', 'opencode.jsonc'])
    ?? existing(path.join(root, '.opencode'), ['opencode.json', 'opencode.jsonc'])
    ?? path.join(root, 'opencode.json');
  return { path: file, exists: existsSync(file), format: path.extname(file) === '.jsonc' ? 'jsonc' : 'json' };
}

const validateObject = (config, where = 'Config') => {
  if (!isObject(config)) throw new OpenCodeConfigError(400, `${where} harus berupa objek JSON.`);
  const visit = (value, depth) => {
    if (depth > 30) throw new OpenCodeConfigError(400, 'Config terlalu dalam.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new OpenCodeConfigError(400, `Kunci config tidak diizinkan: ${key}.`);
      visit(child, depth + 1);
    }
  };
  visit(config, 0);
  return config;
};

const parseConfig = (text) => {
  let config;
  try {
    config = parseJsonc(String(text ?? ''));
  } catch (err) {
    throw new OpenCodeConfigError(400, `Config bukan JSON/JSONC yang valid: ${err.message}`);
  }
  return validateObject(config);
};

const agentsView = (config) => {
  const agents = isObject(config.agent) ? config.agent : {};
  return Object.entries(agents)
    .filter(([, a]) => isObject(a))
    .map(([name, a]) => ({
      name,
      mode: AGENT_MODES.has(a.mode) ? a.mode : '',
      model: typeof a.model === 'string' ? a.model : '',
      description: typeof a.description === 'string' ? a.description : '',
      prompt: typeof a.system === 'string' ? a.system : typeof a.prompt === 'string' ? a.prompt : '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

export function readOpenCodeConfig({ scope, projectPath, home } = {}) {
  const file = configFile({ scope, projectPath, home });
  let text = '';
  let config = {};
  let format = file.format;
  let parseError = null;
  if (file.exists) {
    text = readFileSync(file.path, 'utf8');
    if (Buffer.byteLength(text) > OPENCODE_CONFIG_LIMITS.bytes) throw new OpenCodeConfigError(413, 'Config OpenCode terlalu besar (maks 512 KB).');
    try {
      config = parseConfig(text);
    } catch (err) {
      if (!(err instanceof OpenCodeConfigError) || err.status !== 400) throw err;
      parseError = err.message; // keep the raw text so the JSON tab can fix a broken file
    }
    format = formatOf(file.path, text);
  }
  return { scope, path: file.path, exists: file.exists, format, text, config, agents: agentsView(config), parseError };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
const backupFile = (file) => {
  if (!existsSync(file)) return null;
  const backup = `${file}.bak-${stamp()}`;
  writeFileSync(backup, readFileSync(file));
  return backup;
};

/** The form's model/small-model/agents merged into the existing config; unknown keys stay untouched. */
export function mergeForm(base, form = {}) {
  const config = validateObject(JSON.parse(JSON.stringify(isObject(base) ? base : {})));
  if (!isObject(form)) throw new OpenCodeConfigError(400, 'Form config tidak valid.');
  for (const [key, field] of [['model', 'model'], ['small_model', 'smallModel']]) {
    const value = form[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new OpenCodeConfigError(400, `${field} harus berupa teks.`);
    const clean = value.trim();
    if (!clean) delete config[key];
    else if (clean.length > OPENCODE_CONFIG_LIMITS.model) throw new OpenCodeConfigError(400, `${field} maksimal ${OPENCODE_CONFIG_LIMITS.model} karakter.`);
    else config[key] = clean;
  }
  if (form.agents === undefined) return config;
  if (!Array.isArray(form.agents)) throw new OpenCodeConfigError(400, 'Daftar agent tidak valid.');
  if (form.agents.length > OPENCODE_CONFIG_LIMITS.agents) throw new OpenCodeConfigError(400, `Maksimal ${OPENCODE_CONFIG_LIMITS.agents} agent.`);
  if (config.agent !== undefined && !isObject(config.agent)) throw new OpenCodeConfigError(400, 'Bagian "agent" bukan objek. Perbaiki lewat tab JSON dulu.');
  const old = isObject(config.agent) ? config.agent : {};
  for (const [name, agent] of Object.entries(old)) {
    if (!isObject(agent)) throw new OpenCodeConfigError(400, `Agent "${name}" bukan objek. Perbaiki lewat tab JSON dulu.`);
  }
  const next = {};
  const seen = new Set();
  for (const item of form.agents) {
    if (!isObject(item)) throw new OpenCodeConfigError(400, 'Data agent tidak valid.');
    const name = String(item.name ?? '').trim();
    if (!AGENT_NAME.test(name)) throw new OpenCodeConfigError(400, 'Nama agent tidak valid (huruf/angka, -, _, titik; maks 64).');
    if (seen.has(name)) throw new OpenCodeConfigError(400, `Nama agent ganda: ${name}.`);
    seen.add(name);
    const agent = isObject(old[name]) ? old[name] : {};
    for (const [key, field, max] of [['description', 'description', OPENCODE_CONFIG_LIMITS.description], ['model', 'model', OPENCODE_CONFIG_LIMITS.model], ['mode', 'mode', 20]]) {
      const value = item[field];
      if (value === undefined) continue;
      if (typeof value !== 'string') throw new OpenCodeConfigError(400, `${field} agent ${name} harus berupa teks.`);
      const clean = value.trim();
      if (!clean) delete agent[key];
      else if (key === 'mode' && !AGENT_MODES.has(clean)) throw new OpenCodeConfigError(400, `Mode agent ${name} tidak dikenal.`);
      else if (clean.length > max) throw new OpenCodeConfigError(400, `${field} agent ${name} terlalu panjang.`);
      else agent[key] = clean;
    }
    if (item.prompt !== undefined) {
      if (typeof item.prompt !== 'string') throw new OpenCodeConfigError(400, `prompt agent ${name} harus berupa teks.`);
      const prompt = item.prompt.trim();
      const key = Object.hasOwn(agent, 'system') ? 'system' : Object.hasOwn(agent, 'prompt') ? 'prompt' : 'system';
      if (!prompt) delete agent[key];
      else if (prompt.length > OPENCODE_CONFIG_LIMITS.prompt) throw new OpenCodeConfigError(400, `Prompt agent ${name} maksimal ${OPENCODE_CONFIG_LIMITS.prompt} karakter.`);
      else agent[key] = prompt;
    }
    next[name] = agent;
  }
  if (Object.keys(next).length) config.agent = next;
  else delete config.agent;
  return validateObject(config);
}

/**
 * Save one scope. `mode: 'json'` writes the typed text (comments in JSONC stay); `mode: 'form'` merges the form.
 * The old file is copied to `<file>.bak-<timestamp>` first; an invalid request changes nothing.
 */
export function saveOpenCodeConfig({ scope, projectPath, home, mode = 'form', text, form } = {}) {
  const current = readOpenCodeConfig({ scope, projectPath, home });
  let config;
  let output;
  if (mode === 'json') {
    if (typeof text !== 'string' || !text.trim()) throw new OpenCodeConfigError(400, 'Isi config masih kosong.');
    if (Buffer.byteLength(text) > OPENCODE_CONFIG_LIMITS.bytes) throw new OpenCodeConfigError(413, 'Config OpenCode terlalu besar (maks 512 KB).');
    config = parseConfig(text);
    output = text;
  } else if (mode === 'form') {
    if (current.parseError) throw new OpenCodeConfigError(400, 'Config saat ini tidak valid. Perbaiki lewat tab JSON dulu.');
    config = mergeForm(current.config, form);
    output = `${JSON.stringify(config, null, 2)}\n`;
  } else throw new OpenCodeConfigError(400, 'Mode simpan tidak dikenal.');
  mkdirSync(path.dirname(current.path), { recursive: true });
  const backup = backupFile(current.path);
  writeFileSync(current.path, output, 'utf8');
  return { ...readOpenCodeConfig({ scope, projectPath, home }), backup };
}
