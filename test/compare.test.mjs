// ⚖️ Bandingkan model: two tool-less one-shot runs, model validation, and the JSON the dialog reads.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { cleanCompareModel, compareModels, parseCompareOutput } from '../src/compare.js';

const fake = {
  command: process.execPath,
  args: ['-e', 'let d="";process.stdin.on("data",(c)=>(d+=c)).on("end",()=>console.log(JSON.stringify({result:`jawab: ${d}`,total_cost_usd:0.01,duration_ms:7,num_turns:1})))', '--'],
};

test('compareModels: pertanyaan sama ke dua model, jawaban dan biaya terbaca', async () => {
  const { results } = await compareModels({ claude: fake, cwd: tmpdir(), prompt: 'halo', models: ['opus', 'sonnet'] });
  assert.deepEqual(results.map((r) => r.model), ['opus', 'sonnet']);
  for (const r of results) {
    assert.match(r.text, /jawab: halo/);
    assert.equal(r.costUsd, 0.01);
    assert.equal(r.turns, 1);
  }
});

test('compareModels dan parseCompareOutput: input aneh ditolak, bukan dijalankan', async () => {
  await assert.rejects(compareModels({ claude: fake, cwd: tmpdir(), prompt: ' ', models: ['opus', 'sonnet'] }), (e) => e.status === 400);
  await assert.rejects(compareModels({ claude: fake, cwd: tmpdir(), prompt: 'x', models: ['opus', 'opus'] }), (e) => e.status === 400);
  await assert.rejects(compareModels({ claude: fake, cwd: tmpdir(), prompt: 'x', models: ['--evil', 'sonnet'] }), (e) => e.status === 400);
  assert.deepEqual(parseCompareOutput(JSON.stringify({ result: 'ok', total_cost_usd: 1, duration_ms: 2, num_turns: 1 })), { text: 'ok', costUsd: 1, durationMs: 2, turns: 1 });
  assert.equal(cleanCompareModel('claude-sonnet-5'), 'claude-sonnet-5');
  assert.throws(() => parseCompareOutput('bukan json'), (e) => e.status === 502);
  assert.throws(() => parseCompareOutput(JSON.stringify({ result: 'x', is_error: true })), (e) => e.status === 502);
});
