// Effort Auto's model router: one small, tool-free classification call before a turn. The user explicitly accepts
// the extra tokens; a local fallback keeps the prompt usable when the classifier is unavailable.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileTree } from './proc.js';
import { openCodeModels } from './opencode-bin.js';
import { classifierPrompt, classifyEffortLocally, cleanAutoLevel, parseEffortClassification, pickClassifierModel } from './effort.js';

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_OUTPUT = 32 * 1024;

const strip = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
const mentionsOf = (text) => [...String(text ?? '').matchAll(/@([\w./-]{1,200})/g)].map((m) => m[1]);
const tempDir = (tag) => mkdtempSync(path.join(os.tmpdir(), `office-effort-${tag}-`));
const rmDir = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may still hold the temp file; the next call gets a fresh folder.
  }
};

function run(bin, args, { cwd, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFileTree(bin.command, [...bin.args, ...args], { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: MAX_OUTPUT, env: { ...process.env, CI: '1', NO_COLOR: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' } }, (error, out, err) => {
      resolve({ ok: !error, timedOut: Boolean(error?.killed), text: strip(`${out ?? ''}\n${err ?? ''}`).slice(0, MAX_OUTPUT) });
    });
  });
}

/** Claude Code: `claude -p` with Haiku, no tools, in a throwaway folder (no project context). */
export async function runClaudeClassifier(bin, prompt, timeout = DEFAULT_TIMEOUT_MS) {
  const dir = tempDir('claude');
  try {
    const r = await run(bin, ['-p', '--model', 'haiku', '--output-format', 'json', '--tools', '', '--restricted', '--permission-mode', 'manual', '--strict-mcp-config', prompt], { cwd: dir, timeout });
    return r.text;
  } finally {
    rmDir(dir);
  }
}

/** Best-effort removal of the throwaway OpenCode session created by `opencode run` in the temp folder. */
async function cleanupOpenCode(bin, dir) {
  try {
    const list = await run(bin, ['session', 'list', '--format', 'json', '-n', '10'], { cwd: dir, timeout: 8_000 });
    if (!list.ok) return;
    const parsed = JSON.parse(list.text);
    for (const s of Array.isArray(parsed) ? parsed : []) {
      if (!/^ses_[\w-]{1,100}$/.test(String(s?.id ?? ''))) continue;
      if (s.title !== 'Adhit effort classifier' && s.directory !== dir) continue;
      await run(bin, ['session', 'delete', s.id], { cwd: dir, timeout: 8_000 }).catch(() => {});
    }
  } catch {
    // the temp session is harmless; never hide the classifier answer because cleanup failed
  }
}

/** OpenCode: `opencode run` with a cheap/free model, no project mutations, in a throwaway folder. */
export async function runOpenCodeClassifier(bin, model, prompt, timeout = DEFAULT_TIMEOUT_MS) {
  const dir = tempDir('opencode');
  try {
    const r = await run(bin, ['run', '--format', 'json', '--model', model, '--agent', 'plan', '--title', 'Adhit effort classifier', prompt], { cwd: dir, timeout });
    await cleanupOpenCode(bin, dir);
    return r.text;
  } finally {
    rmDir(dir);
  }
}

/**
 * Classifies one prompt. Always resolves: an unavailable/broken model returns the local fallback instead of blocking
 * the user's turn. `runClaude` / `runOpenCode` are injectable for tests (no real model calls there).
 */
export async function classifyEffort({
  engine,
  claude = null,
  opencode = null,
  currentModel = '',
  text = '',
  attachments = [],
  mentions = mentionsOf(text),
  models = null,
  timeout = DEFAULT_TIMEOUT_MS,
  runClaude = runClaudeClassifier,
  runOpenCode = runOpenCodeClassifier,
} = {}) {
  const fallback = () => ({ ...classifyEffortLocally({ text, attachments, mentions }), model: null });
  // Integration tests set this to avoid spawning a model; production never does.
  const fake = cleanAutoLevel(process.env.OFFICE_EFFORT_FAKE);
  if (fake) return { level: fake, reason: 'classifier palsu (test)', source: 'llm', model: 'fake' };

  const prompt = classifierPrompt({ text, attachments, mentions });
  try {
    let answer = '';
    let model = 'haiku';
    if (engine === 'opencode') {
      if (!opencode) return fallback();
      const list = models ?? (await openCodeModels(opencode));
      model = pickClassifierModel(list, currentModel);
      if (!model) return fallback();
      answer = await runOpenCode(opencode, model, prompt, timeout);
    } else {
      if (!claude) return fallback();
      answer = await runClaude(claude, prompt, timeout);
    }
    const parsed = parseEffortClassification(answer);
    if (parsed) return { ...parsed, source: 'llm', model };
  } catch {
    // fall through: a failed classifier must never block the prompt
  }
  return fallback();
}
