// Effort/Model Auto's router: one small, tool-free classification call before a turn. It returns a model level
// plus a separate thinking effort; the user explicitly accepts the extra tokens. A local fallback keeps the prompt
// usable when the classifier is unavailable.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileTree } from './proc.js';
import { childOpenCodeEnv } from './opencode-bin.js';
import { classifierPrompt, classifyEffortLocally, cleanAutoLevel, effectiveEffort, parseEffortClassification } from './effort.js';

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
    execFileTree(bin.command, [...bin.args, ...args], { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: MAX_OUTPUT, env: { ...childOpenCodeEnv(process.env), CI: '1', NO_COLOR: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' } }, (error, out, err) => {
      resolve({ ok: !error, timedOut: Boolean(error?.killed), text: strip(`${out ?? ''}\n${err ?? ''}`).slice(0, MAX_OUTPUT) });
    });
  });
}

/** Claude Code: `claude -p` with the project's active model, no tools, in a throwaway folder. */
export async function runClaudeClassifier(bin, model, prompt, timeout = DEFAULT_TIMEOUT_MS) {
  const dir = tempDir('claude');
  try {
    const args = ['-p', '--output-format', 'json', '--tools', '', '--restricted', '--permission-mode', 'manual', '--strict-mcp-config'];
    if (model) args.push('--model', model);
    args.push(prompt);
    const r = await run(bin, args, { cwd: dir, timeout });
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
    const args = ['run', '--format', 'json', '--agent', 'plan', '--title', 'Adhit effort classifier'];
    if (model) args.push('--model', model);
    args.push(prompt);
    const r = await run(bin, args, { cwd: dir, timeout });
    await cleanupOpenCode(bin, dir);
    return r.text;
  } finally {
    rmDir(dir);
  }
}

/**
 * Recent conversation + the current plan/todo list, for the classifier: a short follow-up ("kerjakan", "lanjut")
 * must be judged against the plan the agent just wrote, not by its own few words.
 */
export function autoContext(hub, projectId) {
  const messages = (hub?.chatOf?.(projectId) ?? []).filter((m) => (m.kind === 'user' || m.kind === 'assistant') && String(m.text ?? '').trim()).slice(-8);
  const todos = hub?.statusFor?.(projectId)?.todos ?? [];
  const lines = messages.map((m) => `${m.kind === 'user' ? 'Saya' : 'Agen'}: ${String(m.text).slice(0, 600)}`);
  if (Array.isArray(todos) && todos.length) {
    const items = todos
      .slice(0, 12)
      .map((t) => `${t.status ?? ''} ${t.content ?? t.text ?? t.activeForm ?? ''}`.trim())
      .filter(Boolean);
    if (items.length) lines.push(`Rencana/todo: ${items.join('; ')}`);
  }
  return lines.join('\n').slice(-3500);
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
  classifierModel = '',
  text = '',
  attachments = [],
  mentions = mentionsOf(text),
  context = '',
  timeout = DEFAULT_TIMEOUT_MS,
  runClaude = runClaudeClassifier,
  runOpenCode = runOpenCodeClassifier,
} = {}) {
  const fallback = () => {
    const local = classifyEffortLocally({ text, attachments, mentions });
    return { ...local, effort: effectiveEffort(local.level, null), model: null };
  };
  // Integration tests set this to avoid spawning a model; production never does.
  const fake = cleanAutoLevel(process.env.OFFICE_EFFORT_FAKE);
  if (fake) return { level: fake, effort: effectiveEffort(fake, null), reason: 'classifier palsu (test)', source: 'llm', model: 'fake' };

  const prompt = classifierPrompt({ text, attachments, mentions, context });
  // Routing must not burn pro tokens: the Auto classifier uses the project's Seimbang tier. `currentModel` stays a
  // fallback only for an older caller or a test that does not pass classifierModel.
  const model = classifierModel || currentModel || '';
  try {
    let answer = '';
    if (engine === 'opencode') {
      if (!opencode) return fallback();
      answer = await runOpenCode(opencode, model, prompt, timeout);
    } else {
      if (!claude) return fallback();
      answer = await runClaude(claude, model, prompt, timeout);
    }
    const parsed = parseEffortClassification(answer);
    if (parsed) return { ...parsed, effort: effectiveEffort(parsed.level, parsed.effort), source: 'llm', model: model || 'default' };
  } catch {
    // fall through: a failed classifier must never block the prompt
  }
  return fallback();
}
