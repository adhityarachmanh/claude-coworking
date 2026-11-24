// 🎼 Mode Orkestra: the music rules (always consonant, on the beat, capped) and the score from the chat
// (public/js/core/orchestra-feed.js). Pure logic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BPM, chordAt, NoteScheduler, noteFor, scoreNotes, VOICES, voiceOf } from '../public/js/core/orchestra-feed.js';

const pc = (midi) => ((midi % 12) + 12) % 12;
const BEAT = 60000 / BPM;

test('every note a role plays is a tone of the chord playing at that moment (major or minor mood): never dissonant', () => {
  const roles = ['pm', 'backend', 'frontend', 'qa', 'dba', 'ba', 'writer', 'devops', 'security', 'unknown-role'];
  for (const mood of ['major', 'minor', 'bright']) {
    for (let bar = 0; bar < 16; bar++) {
      const chord = chordAt(bar * 4 * BEAT, mood);
      for (const [i, role] of roles.entries()) {
        for (const kind of ['step', 'cue', 'done']) {
          const midi = noteFor({ role, kind, seq: i * 7 + bar }, chord);
          assert.ok(chord.tones.includes(pc(midi)), `${mood} bar ${bar} ${role} ${kind}: ${midi} not in ${chord.name}`);
          assert.ok(midi >= 36 && midi <= 96, 'a comfortable range');
        }
      }
    }
  }
});

test('the progression changes every two bars; the minor mood uses the relative minor progression', () => {
  const names = (mood) => [0, 1, 2, 3].map((k) => chordAt(k * 8 * BEAT + 1, mood).name);
  assert.deepEqual(names('major'), ['C', 'Am', 'F', 'G']);
  assert.deepEqual(names('minor'), ['Am', 'F', 'Dm', 'E']);
  assert.equal(chordAt(7 * BEAT, 'major').name, 'C', 'still the first chord at the end of bar 2');
});

test('roles have their own register and timbre; an unknown role still gets a voice', () => {
  assert.ok(voiceOf('backend').octave < voiceOf('pm').octave, 'backend low, PM melody high');
  assert.equal(voiceOf('qa').timbre, 'perc');
  assert.deepEqual(voiceOf('nope'), VOICES.default);
  for (const v of Object.values(VOICES)) assert.ok(v.emoji && v.timbre && Number.isInteger(v.octave));
});

test('scheduler: notes wait for the next beat, at most N per beat, the rest are dropped, nothing while held', () => {
  const s = new NoteScheduler({ maxPerBeat: 2 });
  for (const role of ['backend', 'frontend', 'qa', 'pm', 'ba', 'dba']) s.push({ role, kind: 'step' }, 10);
  s.push({ role: 'backend', kind: 'step' }, 11); // the same role twice in one beat counts once
  assert.deepEqual(s.tick(BEAT - 1), [], 'not before the beat');
  const first = s.tick(BEAT + 5);
  assert.equal(first.length, 2);
  assert.ok(first.every((n) => n.at === BEAT), 'played exactly on the beat');
  assert.deepEqual(s.tick(BEAT * 2 + 5), [], 'the surplus of a burst was dropped, not queued forever');
  s.hold = true;
  s.push({ role: 'qa', kind: 'step' }, BEAT * 2 + 10);
  assert.deepEqual(s.tick(BEAT * 3 + 5), [], 'a fermata (approval waiting) holds every note');
  s.hold = false;
  s.push({ role: 'qa', kind: 'step' }, BEAT * 3 + 10);
  assert.equal(s.tick(BEAT * 4 + 5).length, 1);
});

test('score: one note per real step of the current mission, on its role, failures marked', () => {
  const chat = [
    { id: 'o', kind: 'user', text: 'lama', ts: 0 },
    { id: 'ot', kind: 'tool', role: 'qa', tool: 'Bash', status: 'ok', ts: 5 },
    { id: 'u', kind: 'user', text: 'baru', ts: 100 },
    { id: 'd', kind: 'delegate', role: 'backend', from: 'claude', status: 'running', ts: 110 },
    { id: 't1', kind: 'tool', role: 'backend', tool: 'Edit', status: 'ok', ts: 120 },
    { id: 't2', kind: 'tool', role: 'claude', tool: 'TodoWrite', status: 'ok', ts: 130 },
    { id: 't3', kind: 'tool', role: 'qa', tool: 'Bash', status: 'fail', ts: 140 },
  ];
  const s = scoreNotes(chat, { coordinator: 'pm', now: 200 });
  assert.equal(s.start, 100);
  assert.deepEqual(s.lanes.map((l) => [l.role, l.notes.map((n) => `${n.t}${n.fail ? '✖' : ''}`)]), [
    ['backend', ['110', '120']],
    ['pm', ['130']],
    ['qa', ['140✖']],
  ]);
});
