// 🔊 Bacakan balasan (public/js/features/tts.js): markdown → speakable text, per-device toggle, no speech engine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerForResult, canSpeak, setTtsOn, speakAnswer, speechText, stopSpeaking, ttsOn } from '../public/js/features/tts.js';

const store = new Map();
const localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

test('speechText: markdown is cleaned, code blocks are skipped, links keep their label', () => {
  const md = '# Judul\n\nHalo **dunia** `npm test`.\n\n```js\nconst x = 1;\n```\n\n[lihat](https://x) ![gambar](a.png) <b>tebal</b>';
  assert.equal(speechText(md), 'Judul Halo dunia npm test. lihat tebal');
  assert.equal(speechText('   '), '');
  assert.equal(speechText(null), '');
  assert.equal(speechText('```\nhanya kode\n```'), '', 'a code-only answer would read nothing useful');
});

test('speechText: a very long answer stops at a word boundary with an ellipsis', () => {
  const out = speechText('kata '.repeat(2000));
  assert.ok(out.length <= 4001);
  assert.ok(out.endsWith('…'));
  assert.equal(out.includes('  '), false);
});

test('answerForResult: only the answer after the previous result is read (an empty turn reads nothing)', () => {
  const old = { kind: 'assistant', text: 'jawaban lama' };
  const firstResult = { kind: 'result', ok: true };
  const answer = { kind: 'assistant', text: 'jawaban baru' };
  const tool = { kind: 'tool', text: 'Bash' };
  const current = { kind: 'result', ok: true };
  assert.equal(answerForResult([old, firstResult, answer, tool, current], current), answer);
  assert.equal(answerForResult([old, firstResult, tool, current], current), null, 'tidak ada jawaban asisten di giliran ini');
  assert.equal(answerForResult([old, current], current), old, 'giliran pertama tanpa result sebelumnya');
  assert.equal(answerForResult([old], old), null, 'result belum ada di daftar');
  assert.equal(answerForResult(null, current), null);
});

test('setTtsOn/speakAnswer: opt-in per device, reads the answer once, cancels the previous one', () => {
  const calls = [];
  globalThis.localStorage = localStorage;
  globalThis.window = {
    speechSynthesis: {
      cancel: () => calls.push('cancel'),
      speak: (u) => calls.push(u),
      getVoices: () => [],
    },
    SpeechSynthesisUtterance: class {
      constructor(text) {
        this.text = text;
      }
    },
  };
  try {
    setTtsOn(false);
    assert.equal(ttsOn(), false);
    assert.equal(canSpeak(), true);
    assert.equal(speakAnswer('**Halo** [dunia](https://x)'), false, 'off by default');

    setTtsOn(true);
    assert.equal(ttsOn(), true);
    assert.equal(speakAnswer('**Halo** [dunia](https://x)'), true);
    const utterance = calls.find((c) => typeof c === 'object');
    assert.equal(utterance.text, 'Halo dunia');
    assert.equal(utterance.lang, 'id-ID');
    assert.equal(calls[0], 'cancel', 'a new answer cancels the old sentence first');

    calls.length = 0;
    assert.equal(speakAnswer('```\nhanya kode\n```'), false, 'nothing to read');
    stopSpeaking();
    assert.deepEqual(calls, ['cancel']);
  } finally {
    setTtsOn(false);
    delete globalThis.window;
    delete globalThis.localStorage;
  }
});
