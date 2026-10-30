// Read-mostly git helpers for the "Perubahan" (changes) panel: status, per-file diff, commit.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_DIFF = 200 * 1024;
const STATUS_LABEL = { M: 'diubah', A: 'baru', D: 'dihapus', R: 'diganti nama', C: 'disalin', U: 'konflik', '?': 'baru' };

function git(cwd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout, err: (stderr || err?.message || '').trim() });
    });
  });
}

export async function gitStatus(cwd) {
  const res = await git(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=all']);
  if (!res.ok) return { repo: false, error: /not a git repository/i.test(res.err) ? null : res.err };
  const lines = res.out.split('\n').filter(Boolean);
  const head = lines[0]?.startsWith('## ') ? lines.shift().slice(3) : '';
  const branch = head.split('...')[0].replace(/^No commits yet on /, '');
  const ahead = Number(head.match(/ahead (\d+)/)?.[1] ?? 0);
  const files = lines.map((line) => {
    const code = line.slice(0, 2);
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ')[1];
    file = file.replace(/^"(.*)"$/, '$1');
    const key = code.trim()[0] ?? '?';
    return { path: file, code, status: STATUS_LABEL[key] ?? code.trim(), untracked: code === '??' };
  });
  return { repo: true, branch, ahead, files };
}

/** Diff of one changed file against HEAD (untracked files are shown as all-new). */
export async function gitDiff(cwd, file) {
  const status = await gitStatus(cwd);
  const entry = status.files?.find((f) => f.path === file);
  if (!entry) return { diff: '', error: 'File tidak ada di daftar perubahan' }; // only files git reports
  if (entry.untracked) {
    try {
      const content = await readFile(path.join(cwd, file), 'utf8');
      const body = content.slice(0, MAX_DIFF).split('\n').map((l) => `+${l}`).join('\n');
      return { diff: `--- /dev/null\n+++ b/${file}\n${body}` };
    } catch (err) {
      return { diff: '', error: err.message };
    }
  }
  let res = await git(cwd, ['diff', 'HEAD', '--', file]);
  if (!res.ok) res = await git(cwd, ['diff', '--cached', '--', file]); // repo without commits yet
  return { diff: res.out.slice(0, MAX_DIFF), truncated: res.out.length > MAX_DIFF, error: res.ok ? undefined : res.err };
}

export async function gitCommit(cwd, message) {
  const add = await git(cwd, ['add', '-A']);
  if (!add.ok) return { ok: false, output: add.err };
  const commit = await git(cwd, ['commit', '-m', message]);
  return { ok: commit.ok, output: (commit.out || commit.err).trim() };
}
