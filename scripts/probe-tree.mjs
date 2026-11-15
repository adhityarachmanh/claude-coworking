// TEMPORARY diagnostic (removed after reading the log): why does a grandchild of execFileTree outlive the SIGKILL
// escalation on Ubuntu? Prints every process.kill the helper makes and the /proc state around it.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileTree } from '../src/proc.js';

const pidFile = '/tmp/probe-grandchild.pid';
const t0 = Date.now();
const at = () => `${Date.now() - t0}ms`;

const realKill = process.kill;
process.kill = (pid, signal) => {
  try {
    const out = realKill(pid, signal);
    console.log(`${at()} kill(${pid}, ${signal ?? 'SIGTERM'}) ok`);
    return out;
  } catch (err) {
    console.log(`${at()} kill(${pid}, ${signal ?? 'SIGTERM'}) FAILED ${err.code}`);
    throw err;
  }
};

const stat = (pid) => {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return `state=${fields[0]} ppid=${fields[1]} pgrp=${fields[2]}`;
  } catch (err) {
    return `gone (${err.code})`;
  }
};

const childCode = [
  "const { spawn } = require('node:child_process');",
  "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });",
  `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
  'setTimeout(() => {}, 60000);',
].join('');

const child = execFileTree(process.execPath, ['-e', childCode], { timeout: 2500 }, (err) => {
  console.log(`${at()} callback: killed=${err?.killed}`);
});
console.log(`${at()} direct child pid=${child.pid} self pgid=${process.getpgrp?.() ?? 'n/a'}`);

setTimeout(() => {
  const pid = Number(readFileSync(pidFile, 'utf8'));
  console.log(`${at()} grandchild pid=${pid} direct=${child.pid}`);
  console.log(`${at()} /proc/${child.pid}: ${stat(child.pid)}`);
  console.log(`${at()} /proc/${pid}: ${stat(pid)}`);
  try {
    process.kill(-child.pid, 'SIGKILL');
    console.log(`${at()} manual group SIGKILL sent to ${-child.pid}`);
  } catch (err) {
    console.log(`${at()} manual group SIGKILL FAILED ${err.code}`);
  }
  setTimeout(() => {
    console.log(`${at()} after manual SIGKILL /proc/${pid}: ${stat(pid)}`);
    process.exit(0);
  }, 1500);
}, 3500);
