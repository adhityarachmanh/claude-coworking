// 🦙 Ollama status (src/ollama.js): the HTTP API only, bounded, and never a thrown error when Ollama is off.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ollamaBaseUrl, ollamaStatus } from '../src/ollama.js';

const reply = (body) => ({ ok: true, json: async () => body });

test('ollamaBaseUrl: OLLAMA_HOST tanpa skema, OFFICE_OLLAMA_URL menang, trailing slash dibuang', () => {
  assert.equal(ollamaBaseUrl({ OLLAMA_HOST: '127.0.0.1:11434' }), 'http://127.0.0.1:11434');
  assert.equal(ollamaBaseUrl({ OLLAMA_HOST: '0.0.0.0:1234', OFFICE_OLLAMA_URL: 'https://gpu.local:11434/' }), 'https://gpu.local:11434');
  assert.equal(ollamaBaseUrl({ OLLAMA_HOST: 'http://box:11434/' }), 'http://box:11434');
  assert.equal(ollamaBaseUrl({ OLLAMA_HOST: 'ftp://nope' }), 'http://127.0.0.1:11434');
  assert.equal(ollamaBaseUrl({}), 'http://127.0.0.1:11434');
});

test('ollamaStatus: versi, model terpasang, dan model berjalan dengan persen VRAM', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/api/version')) return reply({ version: '0.12.0' });
    if (url.endsWith('/api/tags'))
      return reply({
        models: [
          { name: 'qwen2.5-coder:7b', size: 4_700_000_000, modified_at: '2026-01-01', details: { parameter_size: '7B', quantization_level: 'Q4_K_M', family: 'qwen2' } },
          { model: 'gpt-oss:20b', size: 14_000_000_000, details: {} },
          { size: 1 },
        ],
      });
    if (url.endsWith('/api/ps')) return reply({ models: [{ name: 'gpt-oss:20b', size: 14_000_000_000, size_vram: 7_000_000_000, expires_at: 'soon' }] });
    throw new Error('unexpected');
  };
  const data = await ollamaStatus({ fetchImpl, baseUrl: 'http://box:11434' });
  assert.equal(data.available, true);
  assert.equal(data.version, '0.12.0');
  assert.deepEqual(data.models.map((m) => m.name), ['qwen2.5-coder:7b', 'gpt-oss:20b']);
  assert.equal(data.models[0].parameterSize, '7B');
  assert.equal(data.models[0].quantization, 'Q4_K_M');
  assert.equal(data.running[0].name, 'gpt-oss:20b');
  assert.equal(data.running[0].gpuPercent, 50);
  assert.ok(calls.every((u) => u.startsWith('http://box:11434/api/')));
});

test('ollamaStatus: Ollama mati atau error → available false tanpa melempar', async () => {
  const down = await ollamaStatus({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down.available, false);
  assert.match(down.error, /tidak menjawab/i);
  assert.deepEqual(down.models, []);
  const notOk = await ollamaStatus({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(notOk.available, false);
});
