// openCodeModels parses `opencode models` output. Custom OpenAI-compatible providers legitimately name models with
// slashes (river/Qwen/Qwen3.5-9B, river/deepseek-ai/DeepSeek-V4.1-Flash — the OpenRouter shape too), so the parser
// must keep them: only the FIRST slash splits provider from model. A fake bin prints what the real CLI printed.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { clearModelCache, openCodeModels } from '../src/opencode-bin.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-opencode-models-'));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

test('openCodeModels: model ids dengan slash tetap masuk, duplikat didedup, baris kotor dibuang', async () => {
  clearModelCache();
  const fake = path.join(TMP, 'fake-opencode-models.mjs');
  // The real output shape (opencode models, a custom provider + a catalog provider).
  writeFileSync(
    fake,
    `const lines = ${JSON.stringify([
      'river/GLM-5.3',
      'river/Qwen/Qwen3.5-9B',
      'river/deepseek-ai/DeepSeek-V4.1-Flash',
      'river/deepseek-ai/DeepSeek-V4.1-Flash-1017',
      'river/moonshotai/Kimi-K3',
      'river/moonshotai/Kimi-K3.1-Pro',
      'river/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4',
      'river/Qwen/Qwen3.8-27B-FP8',
      'river/zai-org/GLM-5.3-Flash',
      'river/Qwen/Qwen3.5-9B', // same line twice: the list dedups
      'opencode-go/beam-free',
      'opencode-go/glm-5.3#high', // a variant suffix stays
      'tanpa-slash', // not a provider/model line: dropped
      'river/ ada spasi', // invalid: dropped
    ])};\nconsole.log(lines.join('\\n'));\n`,
  );
  const list = await openCodeModels({ command: process.execPath, args: [fake] });
  assert.ok(list.includes('river/GLM-5.3'));
  for (const id of ['river/Qwen/Qwen3.5-9B', 'river/deepseek-ai/DeepSeek-V4.1-Flash', 'river/moonshotai/Kimi-K3', 'river/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4', 'river/zai-org/GLM-5.3-Flash']) {
    assert.ok(list.includes(id), `${id} harus tetap terdaftar`);
  }
  assert.equal(list.filter((v) => v === 'river/Qwen/Qwen3.5-9B').length, 1, 'duplikat didedup');
  assert.ok(list.includes('opencode-go/beam-free'));
  assert.ok(list.includes('opencode-go/glm-5.3#high'), 'varian #high tetap masuk');
  assert.ok(!list.includes('tanpa-slash'), 'baris tanpa prefix dibuang');
  assert.ok(!list.includes('river/ ada spasi'), 'id dengan spasi dibuang');
});
