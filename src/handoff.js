// 🔁 Lanjutkan dari mesin lain: the context of a project's conversation in one engine's workspace (Claude Code or
// OpenCode) carried to the other as an opening message the user reviews before sending. Two ways:
//   quick — built here from what the app already has: the other workspace's chat (your prompts and the answers,
//           shortened), the to-do list it ended with, and `git diff --stat`. Free and instant.
//   smart — the source engine itself writes a handoff note from its full conversation, on a FORK of that session
//           (Claude --fork-session / opencode run --fork) in read-only mode (plan): the original session is never
//           changed and nothing in the project is edited. Uses a few thousand tokens of the source engine's account.
import { ChatStore } from './chat-store.js';
import { readOnlyOpenCodeEnv, readUserPermission } from './opencode-bin.js';
import { execFileTree } from './proc.js';

const MAX_MESSAGES = 30;
const MAX_PER_MESSAGE = 700;
const MAX_TOTAL = 14_000;
export const ENGINE_LABEL = { claude: 'Claude Code', opencode: 'OpenCode' };

export class HandoffError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+\n/g, '\n').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function run(command, args, { cwd, timeout, env }) {
  return new Promise((resolve) => {
    execFileTree(command, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env } }, (err, out, errOut) =>
      resolve({ ok: !err, out: String(out ?? ''), err: String(errOut ?? ''), timedOut: Boolean(err?.killed) }),
    );
  });
}

/** The other workspace's chat for this project (read straight from its folder: that engine is parked). */
export function otherChat(hub, from, projectId) {
  const store = new ChatStore(hub.chatDir(from), { limit: 250 });
  try {
    return store.read(projectId).messages;
  } catch {
    return [];
  }
}

const HEADER = (from) => `🔁 Konteks dari ${ENGINE_LABEL[from]} (sesi sebelumnya di project ini). Lanjutkan pekerjaan dari sini; tanyakan dulu kalau ada yang belum jelas.`;

/** quick: the conversation's gist from the stored chat + the working tree's changes. */
export async function quickHandoff({ hub, project, from }) {
  const chat = otherChat(hub, from, project.id);
  const talk = chat.filter((m) => (m.kind === 'user' || m.kind === 'assistant') && String(m.text ?? '').trim());
  if (!talk.length) throw new HandoffError(404, `Belum ada percakapan ${ENGINE_LABEL[from]} di project ini.`);
  const firstGoal = talk.find((m) => m.kind === 'user');
  const recent = talk.slice(-MAX_MESSAGES);
  const lines = [];
  let total = 0;
  for (const m of recent) {
    const who = m.kind === 'user' ? 'Saya' : ENGINE_LABEL[from];
    const line = `**${who}:** ${clip(m.text, MAX_PER_MESSAGE)}`;
    if (total + line.length > MAX_TOTAL) break;
    lines.push(line);
    total += line.length;
  }
  const tools = chat.filter((m) => m.kind === 'tool' && m.text && !m.sub).slice(-12).map((m) => `- ${clip(m.text, 120)}`);
  const diff = await run('git', ['diff', '--stat', 'HEAD'], { cwd: project.path, timeout: 20_000, env: { GIT_TERMINAL_PROMPT: '0' } });
  const parts = [
    HEADER(from),
    '',
    `## Tujuan awal`,
    clip(firstGoal?.text ?? '-', 600),
    '',
    `## Percakapan terakhir (${lines.length} pesan, dipadatkan)`,
    ...lines,
  ];
  if (tools.length) parts.push('', '## Langkah terakhir yang dijalankan', ...tools);
  if (diff.ok && diff.out.trim()) parts.push('', '## Perubahan file yang belum di-commit (git diff --stat)', '```', clip(diff.out, 2500), '```');
  return parts.join('\n');
}

const SMART_PROMPT =
  'Tulis CATATAN HANDOFF untuk agen AI lain yang akan melanjutkan pekerjaan di project ini (ia tidak melihat percakapan kita). ' +
  'Bahasa Indonesia, ringkas, berformat Markdown dengan bagian: ## Tujuan, ## Yang sudah dikerjakan (file & perubahan penting), ' +
  '## Keputusan & alasannya, ## Status saat ini (apa yang belum selesai / masalah terbuka), ## Langkah berikutnya (urut). ' +
  'Jangan mengubah file apa pun dan jangan menjalankan perintah; cukup tulis catatannya.';

/** smart: the source engine writes the note on a read-only fork of its own session. */
export async function smartHandoff({ hub, project, from, claude, opencode }) {
  const sessionId = hub.persisted.workspaces?.[from]?.sessions?.[project.id];
  if (!sessionId) throw new HandoffError(404, `Belum ada sesi ${ENGINE_LABEL[from]} untuk project ini (atau sudah direset). Pakai mode Cepat.`);
  let r;
  if (from === 'claude') {
    if (!claude) throw new HandoffError(404, 'Claude Code tidak ditemukan.');
    r = await run(claude.command, [...claude.args, '-p', SMART_PROMPT, '--resume', sessionId, '--fork-session', '--output-format', 'text', '--permission-mode', 'plan', '--disallowedTools', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'], { cwd: project.path, timeout: 240_000 });
  } else {
    if (!opencode) throw new HandoffError(404, 'OpenCode tidak ditemukan.');
    r = await run(opencode.command, [...opencode.args, 'run', '--session', sessionId, '--fork', '--agent', 'plan', SMART_PROMPT], { cwd: project.path, timeout: 240_000, env: readOnlyOpenCodeEnv(process.env, readUserPermission(project.path)) });
  }
  const text = r.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
  if (!r.ok || !text) throw new HandoffError(502, r.timedOut ? `${ENGINE_LABEL[from]} tidak selesai dalam 4 menit.` : `${ENGINE_LABEL[from]} gagal menulis catatan: ${(r.err || r.out).trim().split('\n').at(-1)?.slice(0, 200) ?? ''}`);
  return `${HEADER(from)}\n\n${clip(text, 20_000)}`;
}

/** For the dialog: is there anything to carry over from `from` for this project? */
export function handoffInfo(hub, project, from) {
  const chat = otherChat(hub, from, project.id);
  const messages = chat.filter((m) => m.kind === 'user' || m.kind === 'assistant').length;
  const sessionId = hub.persisted.workspaces?.[from]?.sessions?.[project.id] ?? null;
  const last = chat.findLast?.((m) => m.ts)?.ts ?? null;
  return { from, label: ENGINE_LABEL[from], messages, hasSession: Boolean(sessionId), lastAt: last };
}

export const otherEngine = (engine) => (engine === 'opencode' ? 'claude' : 'opencode');
