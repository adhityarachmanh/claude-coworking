#!/usr/bin/env node
// ⌨️ Local CLI for the Figma bridge: node tools/figma-bridge/cli.mjs status
// Token: FIGMA_BRIDGE_TOKEN, or %TEMP%/figma-bridge-token.txt (written by the person running the bridge).
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 3939);
const token = process.env.FIGMA_BRIDGE_TOKEN || readToken();
const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) {
  console.error('Pakai: node tools/figma-bridge/cli.mjs <status|selection|page|node|export|create_frame|create_rect|create_text|set_fill|move> [key=value ... | JSON]');
  process.exit(2);
}
const args = parseArgs(rest);
if (!args) {
  console.error('Argumen harus JSON valid atau pasangan key=value.');
  process.exit(2);
}
const res = await fetch(`http://127.0.0.1:${PORT}/exec`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Bridge-Token': token } : {}) },
  body: JSON.stringify({ cmd, args }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Error (${res.status}): ${body.error ?? 'tidak diketahui'}`);
  process.exit(1);
}
console.log(typeof body.data === 'string' ? body.data : JSON.stringify(body.data, null, 2));

/** "depth=3 name=Kartu" (numbers/booleans/strings), or one JSON object. */
function parseArgs(parts) {
  if (!parts.length) return {};
  if (parts[0].startsWith('@')) {
    try {
      return JSON.parse(readFileSync(parts[0].slice(1), 'utf8'));
    } catch {
      return null;
    }
  }
  const joined = parts.join(' ');
  if (joined.trim().startsWith('{')) {
    try {
      return JSON.parse(joined);
    } catch {
      return null;
    }
  }
  const out = {};
  for (const part of parts) {
    const at = part.indexOf('=');
    if (at < 1) return null;
    const key = part.slice(0, at);
    const raw = part.slice(at + 1);
    out[key] = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return out;
}

function readToken() {
  try {
    return readFileSync(path.join(os.tmpdir(), 'figma-bridge-token.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}
