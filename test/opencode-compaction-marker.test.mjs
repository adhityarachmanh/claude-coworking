// OpenCode compaction marker (ACP): session_info_update._meta["opencode/compaction"] tells the app when a compaction
// starts, completes, or fails. The app shows the same "Memadatkan konteks…" state Claude already has.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactionMarker } from '../src/acp-session.js';

test('compactionMarker: started/completed/failed, status asing diabaikan', () => {
  assert.deepEqual(compactionMarker({ 'opencode/compaction': { status: 'started', reason: 'auto' } }), { compacting: true, note: '', failed: false });
  assert.deepEqual(compactionMarker({ 'opencode/compaction': { status: 'completed', reason: 'auto' } }), { compacting: false, note: 'Konteks dipadatkan otomatis.', failed: false });
  assert.equal(compactionMarker({ 'opencode/compaction': { status: 'completed', reason: 'manual' } }).note, 'Konteks dipadatkan.');
  const failed = compactionMarker({ 'opencode/compaction': { status: 'failed', error: { message: 'model mati' } } });
  assert.equal(failed.failed, true);
  assert.match(failed.note, /model mati/);
  assert.equal(compactionMarker({}), null);
  assert.equal(compactionMarker({ 'opencode/compaction': { status: 'aneh' } }), null);
});
