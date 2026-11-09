#!/usr/bin/env node
// 🌉 PreToolUse hook spawned by `office claude`. Reads one JSON payload from stdin, asks the local office, and
// prints a decision. Any failure (no token, server down, timeout, bad shape) writes nothing: Claude Code then
// falls back to its normal terminal prompt. It never auto-allows and never logs tool content.
import { readFileSync } from 'node:fs';
import { hookDecision, sanitizeToolInput } from '../../src/cli-bridge.js';

const BASE = String(process.env.OFFICE_CLI_BASE ?? 'http://127.0.0.1:4317').replace(/\/+$/, '');
const TOKEN_FILE = process.argv[2] ?? '';
const MAX_WAIT_MS = 118_000; // below the settings timeout (120 s), above the server's 115 s
const MAX_STDIN_BYTES = 512 * 1024;

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (!TOKEN_FILE) return;
  let token = '';
  try {
    token = readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return;
  }
  if (!token) return;
  const raw = await readStdin();
  if (!raw?.trim()) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (payload?.hook_event_name !== 'PreToolUse') return;
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name.trim() : '';
  if (!tool) return;
  let response;
  try {
    response = await fetch(`${BASE}/api/cli-bridge/ask`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Cli-Token': token, Origin: BASE },
      body: JSON.stringify({ tool, input: sanitizeToolInput(payload.tool_input), cwd: payload.cwd }),
      signal: AbortSignal.timeout(MAX_WAIT_MS),
    });
  } catch {
    return; // server down/timeout: the terminal prompt takes over
  }
  if (!response.ok) return; // denied/timeout/not a project: terminal prompt takes over
  const answer = await response.json().catch(() => null);
  const output = hookDecision(answer?.decision);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`); // let stdout drain (process.exit truncates it)
}

main().catch(() => {}).finally(() => {
  process.exitCode = 0;
});
