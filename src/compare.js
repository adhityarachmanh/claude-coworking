// ⚖️ Compare two Claude models on the same prompt: two one-shot `claude -p` runs with tools off, no session saved.
// The user pays for both; the dialog says so. Pure parsing lives here so the route stays thin.
import { spawn } from 'node:child_process';
import { childEnv } from './child-env.js';
import { killTree } from './proc.js';

export class CompareError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MODEL = /^(?:best|opusplan|(?:opus|sonnet|haiku|fable)(?:\[1m\])?|claude-[\w.:[\]-]{1,76})$/;
export const PROMPT_MAX = 8000;

/** A model alias/id the app itself may pass; anything else never reaches the command line. */
export function cleanCompareModel(value) {
  const model = String(value ?? '').trim();
  if (!MODEL.test(model)) throw new CompareError(400, 'Model tidak valid (alias opus/sonnet/haiku/fable atau id claude-…).');
  return model;
}

/** The single JSON object `--output-format json` prints, validated into the fields the dialog shows. */
export function parseCompareOutput(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout ?? '').trim());
  } catch {
    throw new CompareError(502, 'Jawaban Claude tidak terbaca.');
  }
  if (!data || typeof data !== 'object') throw new CompareError(502, 'Jawaban Claude tidak terbaca.');
  const text = typeof data.result === 'string' ? data.result : '';
  if (data.is_error === true || !text.trim()) throw new CompareError(502, typeof data.result === 'string' && data.result.trim() ? data.result.slice(0, 400) : 'Claude tidak menjawab.');
  return {
    text,
    costUsd: Number.isFinite(data.total_cost_usd) ? data.total_cost_usd : null,
    durationMs: Number.isFinite(data.duration_ms) ? data.duration_ms : null,
    turns: Number.isFinite(data.num_turns) ? data.num_turns : null,
  };
}

function runOne(claude, model, prompt, cwd, timeout) {
  return new Promise((resolve) => {
    const args = [...claude.args, '-p', '--model', model, '--output-format', 'json', '--tools', '', '--no-session-persistence', '--permission-mode', 'plan'];
    const started = Date.now();
    const child = spawn(claude.command, args, { cwd, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      killTree(child.pid);
      resolve({ model, error: `Tidak selesai dalam ${Math.round(timeout / 1000)} detik.` });
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out = (out + chunk).slice(-2 * 1024 * 1024);
    });
    child.stderr.on('data', (chunk) => {
      err = (err + chunk).slice(-4000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ model, error: `Gagal menjalankan Claude Code: ${e.message}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = parseCompareOutput(out);
        resolve({ model, ...parsed, durationMs: parsed.durationMs ?? Date.now() - started });
      } catch (e) {
        resolve({ model, error: e instanceof CompareError ? e.message : err.split('\n').find((l) => l.trim()) ?? 'Claude tidak menjawab.' });
      }
    });
    child.stdin.on('error', () => {}); // EPIPE when the process dies early
    child.stdin.end(prompt);
  });
}

/**
 * Runs the same prompt on two models. Tools are off and plan mode is on: this compares answers, never touches files.
 * @returns {Promise<{results: Array<{model,text?,error?,costUsd?,durationMs?,turns?}>}>}
 */
export async function compareModels({ claude, cwd, prompt, models, timeout = 120_000 }) {
  if (!claude) throw new CompareError(404, 'Claude Code tidak ditemukan.');
  const text = String(prompt ?? '').trim();
  if (!text) throw new CompareError(400, 'Tulis pertanyaan yang mau dibandingkan.');
  if (text.length > PROMPT_MAX) throw new CompareError(400, `Pertanyaan maksimal ${PROMPT_MAX} karakter.`);
  if (!Array.isArray(models) || models.length !== 2) throw new CompareError(400, 'Pilih dua model.');
  const [a, b] = models.map(cleanCompareModel);
  if (a === b) throw new CompareError(400, 'Pilih dua model yang berbeda.');
  const results = await Promise.all([a, b].map((model) => runOne(claude, model, text, cwd, timeout)));
  return { results };
}
