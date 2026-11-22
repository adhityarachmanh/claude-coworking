// 💬 Chat umum: the built-in "Chat umum" project — a project with the same engines as any other, but its folder is
// an app-owned sandbox under dataDir, so a general chat never touches a real project folder. It is always present
// (even after a rescan), its sandbox is recreated when missing, and the destructive routes refuse it.
// A throwaway data dir: nothing here touches your real data.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { buildHealth } from '../src/health.js';
import { GENERAL_ID, Hub } from '../src/hub.js';

const temps = [];
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-chatumum-'));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('Hub mendaftarkan entri "Chat umum" dengan sandbox-nya', () => {
  const dir = tempDir();
  const hub = new Hub({ dataDir: dir });
  const p = hub.projects.get(GENERAL_ID);
  assert.ok(p, 'entri chat-umum harus ada');
  assert.equal(p.name, 'Chat umum');
  assert.equal(p.system, true);
  assert.equal(p.path, path.join(dir, 'chat-umum'));
  assert.ok(existsSync(p.path), 'folder sandbox harus dibuat');
});

test('ensureSystemProjects membuat ulang sandbox yang dihapus', () => {
  const dir = tempDir();
  const hub = new Hub({ dataDir: dir });
  rmSync(hub.projects.get(GENERAL_ID).path, { recursive: true, force: true });
  hub.ensureSystemProjects();
  assert.ok(existsSync(hub.projects.get(GENERAL_ID).path), 'folder sandbox harus dibuat lagi');
});

test('ensureSystemProjects mengembalikan entri yang hilang (mis. pindai ulang)', () => {
  const dir = tempDir();
  const hub = new Hub({ dataDir: dir });
  hub.projects.delete(GENERAL_ID); // as if refreshProjects dropped it
  hub.ensureSystemProjects();
  assert.ok(hub.projects.get(GENERAL_ID), 'entri harus muncul lagi');
});

test('entri "Chat umum" selalu muncul di listProjects', () => {
  const dir = tempDir();
  const hub = new Hub({ dataDir: dir });
  assert.ok(hub.listProjects().some((p) => p.id === GENERAL_ID && p.system === true));
});

test('health tidak menghitung "Chat umum" sebagai project nyata', () => {
  const dir = tempDir();
  const hub = new Hub({ dataDir: dir });
  const health = buildHealth({ hub, dataDir: dir, projectRoots: () => [] });
  const line = health.checks.find((c) => c.id === 'projects');
  // No real projects: the line says so, rather than counting the built-in "Chat umum".
  assert.equal(line.detail, 'Belum ada folder project');
  assert.ok(!/\d+ project/.test(line.detail), `tak boleh menghitung chat-umum: ${line.detail}`);
});

test('entri system ditandai agar rute destruktif bisa menolaknya', () => {
  const dir = tempDir();
  const hub = new Hub({ dataDir: dir });
  assert.equal(hub.projects.get(GENERAL_ID).system, true); // the flag purge/archive read to refuse
  // and the id never passes the plain project purge pattern ([0-9a-f]{8,32})
  assert.equal(/^[0-9a-f]{8,32}$/.test(GENERAL_ID), false);
});