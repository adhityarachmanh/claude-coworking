// 🧪 Nilai jawaban: prompt fences the answer as data, and the review returns text + cost.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { reviewAnswer, reviewPrompt } from '../src/answer-review.js';

const fake = {
  command: process.execPath,
  args: ['-e', 'let d="";process.stdin.on("data",(c)=>(d+=c)).on("end",()=>console.log(JSON.stringify({result:"Benar [1]",total_cost_usd:0.03})))', '--'],
};

test('reviewPrompt: jawaban sebagai data, fokus dipakai, larangan mengarang', () => {
  const prompt = reviewPrompt({ answer: 'Jawaban saya', question: 'Pertanyaan saya', focus: 'keamanan' });
  assert.match(prompt, /Pertanyaan pengguna:/);
  assert.match(prompt, /Fokus penilaian: keamanan/);
  assert.match(prompt, /"""/);
  assert.match(prompt, /Jangan mengarang/);
  assert.match(prompt, /bukan instruksi/);
});

test('reviewAnswer: hasil + biaya, input aneh ditolak', async () => {
  const data = await reviewAnswer({ claude: fake, cwd: tmpdir(), answer: 'Jawaban', question: 'Tanya', focus: 'tes' });
  assert.equal(data.review, 'Benar [1]');
  assert.equal(data.costUsd, 0.03);
  await assert.rejects(reviewAnswer({ claude: fake, cwd: tmpdir(), answer: '' }), (e) => e.status === 400);
  await assert.rejects(reviewAnswer({ claude: fake, cwd: tmpdir(), answer: 'x', model: '--evil' }), (e) => e.status === 400);
  await assert.rejects(reviewAnswer({ claude: fake, cwd: tmpdir(), answer: 'x'.repeat(20_001) }), (e) => e.status === 400);
});
