// TEMPORARY diagnostic (removed after reading the log): does `detached` actually put the child in its own process
// group under execFile vs spawn on this Node/Linux? Prints the pgrp from /proc for each case.
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SLEEP = ['-e', 'setTimeout(() => {}, 60000)'];

const stat = (pid) => {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return `state=${fields[0]} ppid=${fields[1]} pgrp=${fields[2]}`;
  } catch (err) {
    return `gone (${err.code})`;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`node ${process.version} self pid=${process.pid} self stat: ${stat(process.pid)}`);

const withDetachedSpawn = spawn(process.execPath, SLEEP, { detached: true, stdio: 'ignore', windowsHide: true });
const withDetachedExecFile = execFile(process.execPath, SLEEP, { detached: true, windowsHide: true }, () => {});
const withDetachedExecFileNoCallback = execFile(process.execPath, SLEEP, { detached: true });
const plainSpawn = spawn(process.execPath, SLEEP, { stdio: 'ignore' });

await sleep(300);
console.log(`spawn detached      pid=${withDetachedSpawn.pid} ${stat(withDetachedSpawn.pid)}`);
console.log(`execFile detached   pid=${withDetachedExecFile.pid} ${stat(withDetachedExecFile.pid)}`);
console.log(`execFile detached#2 pid=${withDetachedExecFileNoCallback.pid} ${stat(withDetachedExecFileNoCallback.pid)}`);
console.log(`spawn plain         pid=${plainSpawn.pid} ${stat(plainSpawn.pid)}`);
for (const [label, pid] of [['spawn detached', withDetachedSpawn.pid], ['execFile detached', withDetachedExecFile.pid]]) {
  try {
    process.kill(-pid, 'SIGKILL');
    console.log(`group SIGKILL to -${pid} (${label}) ok`);
  } catch (err) {
    console.log(`group SIGKILL to -${pid} (${label}) FAILED ${err.code}`);
  }
}
for (const p of [withDetachedExecFileNoCallback, plainSpawn]) p.kill('SIGKILL');
withDetachedExecFileNoCallback.unref?.();
