// OpenCode as a project's engine, over the Agent Client Protocol (`opencode acp`: JSON-RPC 2.0, one JSON per line on
// stdio). ACP updates are turned into Claude Code stream-json messages and fed to the same StreamTranslator, so the
// office, chat, approval cards, queue, notifications and reports work unchanged. See docs/design-opencode.md.
//
// The session class is built from ClaudeSession (acpSessionClass below) so the queue bookkeeping, `!` shell,
// "Lanjutkan" after a restart, idle shutdown and status come along; only the protocol parts are replaced.
import path from 'node:path';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mergePermission, readUserPermission, childOpenCodeEnv } from './opencode-bin.js';
import { childEnv } from './child-env.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { attachmentChips } from './attachments.js';
import { recordAudit } from './audit-log.js';
import { budgetStop, consumeBudgetOverride } from './budget.js';
import { checkTurn, overCapacity } from './concurrency.js';
import { MODE_CHOICE_MESSAGE, agentForMode } from './modes.js';
import { rememberEffortRefusal, refusalsFor } from './effort-memory.js';
import { OPENCODE_ACCOUNT } from './opencode-account.js';
import { describeTool, inferRole, ROLE_IDS } from './roles.js';
import { StreamTranslator } from './translator.js';
import { clip, truncate } from './util.js';

const HANDSHAKE_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 8000;
// A subagent step that starts after its turn ended can lose its final update (OpenCode stops relaying the child
// once the parent prompt resolved). After this grace the row is closed with an honest note instead of spinning
// forever; tests shorten it through the env var.
const CHILD_SETTLE_MS = (() => {
  const raw = Number(process.env.OFFICE_ACP_SETTLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();
// OpenCode's service cannot see the shells of an ACP-hosted session, and it writes no exit marker next to the output
// file: the only proof of life is the process tree. A background shell is judged every LIVENESS_EVERY_MS, once it is
// older than SHELL_GRACE_MS (the shell needs a moment to start). Tests shorten both through env vars.
const envMs = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};
const SHELL_LIVENESS_MS = envMs('OFFICE_SHELL_LIVENESS_MS', 10_000);
const SHELL_GRACE_MS = envMs('OFFICE_SHELL_GRACE_MS', 5_000);
// After a background task ends OpenCode resumes the session on its own ("you will be resumed automatically"): those
// frames belong to this conversation, but they arrive outside any prompt of ours. The window lets them in; the
// session's own `session.active` then tells us when that unsolicited turn is over.
const RESUME_WINDOW_MS = envMs('OFFICE_RESUME_WINDOW_MS', 10 * 60_000);
const RESUME_QUIET_MS = envMs('OFFICE_RESUME_QUIET_MS', 4_000);
const RESUME_POLL_MS = envMs('OFFICE_RESUME_POLL_MS', 5_000);
const RESUME_MAX_MS = envMs('OFFICE_RESUME_MAX_MS', 30 * 60_000);
// A delegation the parent is waiting to hear back from can outlast the fixed resume window (a heavy build). While
// such a task still runs, the liveness tick renews the window so OpenCode's eventual continuation is never dropped
// as a foreign frame. If no continuation ever comes while the session is idle (upstream #56314: a failed resumed
// turn leaves the parent silent), the user is told once instead of seeing the session stop with no explanation.
const RESUME_MISS_MS = envMs('OFFICE_RESUME_MISS_MS', RESUME_WINDOW_MS);
// A turn whose `session/prompt` never returns AND that sends no frame at all is the "silently stuck" case upstream
// acknowledges (issue #26350: a non-tool LLM call that fails after retries emits no ACP frame). `session/prompt` is
// sent with timeout 0 (no bound; see rpc), so without this nothing would ever close such a turn and the office would
// sit "busy" forever. Deliberately conservative (10 minutes): a slow provider that still streams frames is never cut
// off — only a turn with zero progress for this long is. The prompt RPC is still pending, so the stalled turn is
// cancelled first (session/cancel) to free the session before it is closed. Tests shorten it via env.
const TURN_STALL_MS = envMs('OFFICE_TURN_STALL_MS', 10 * 60_000);
// After the stalled turn is cancelled, how long its prompt reply may take before the turn is closed anyway. Short:
// the cancel is best effort, the honest closure must not depend on a wedged process answering.
const TURN_STALL_KILL_MS = envMs('OFFICE_TURN_STALL_KILL_MS', 20_000);
// ACP delegations (subagents) as ⧗ tasks: a child session that is no longer busy, with no new frame for this long,
// is done. The parent's own resume is the primary signal (see beginResumeTurn); this is the fallback.
const AGENT_QUIET_MS = envMs('OFFICE_AGENT_QUIET_MS', 20_000);
const AGENT_MAX_MS = envMs('OFFICE_AGENT_MAX_MS', 30 * 60_000);
// A model/mode/account change deferred for a background task is applied at the latest this long after it was asked:
// a delegation whose final frame never comes must not keep a project on the old mode forever (refina-smi).
const RESTART_MAX_WAIT_MS = envMs('OFFICE_RESTART_MAX_WAIT_MS', 10 * 60_000);
const STDERR_TAIL = 4000;
const OPENCODE_SESSION = /^ses_[\w-]{1,100}$/;
const POINTS_CACHE_MS = 5000; // ⏪ the rewind list is reused this long (see rewindPoints)
// A provider-login lookup on a failed turn must never hold the stop line: the turn is closed with an honest note even
// when OpenCode does not answer (see authErrorNote).
const AUTH_LOOKUP_TIMEOUT_MS = 2500;
/** What a prompt / `!` shell gets while a rewind runs (409 from the routes). */
export const REWINDING_MESSAGE = 'Rewind sedang berjalan. Tunggu sebentar, lalu kirim lagi.';

/**
 * A turn that stopped because the provider refused it reads only "Authentication required…". What it means depends on
 * what we know: with no stored credential the user must log in, while a stored key can still be refused because
 * OpenCode's service classifies EVERY HTTP 403 as an authentication error (upstream #55995/#48297) — an entitlement
 * or credit refusal, or a network/region block (an office proxy inspecting HTTPS) arrives as this same text. Point at
 * the plausible cause and the login path instead of always claiming the key is missing. Idempotent: the note is
 * appended once, so a pass-through that runs twice never stacks it.
 * @param {string} message the provider's own error text
 * @param {{ provider?: string|null, connected?: boolean|null, status?: number|null }} [context] `connected` comes from
 *   OpenCode's provider list: true (a credential is stored), false (the provider is known but has none), null/unknown.
 *   `status` is the HTTP status behind the error when one is known.
 */
export function authRequiredNote(message, { provider = null, connected = null, status = null } = {}) {
  const text = typeof message === 'string' ? message : '';
  if (!/authentication required/i.test(text) || /👤 Akun/.test(text)) return text;
  const name = typeof provider === 'string' && /^[\w.@-]{1,100}$/.test(provider) ? provider : '';
  const who = name ? `Provider «${name}»` : 'Provider ini';
  let note;
  if (connected === false) {
    note = `${who} belum punya API key tersimpan: buka 👤 Akun → OpenCode → ＋ Login provider, lalu coba lagi.`;
  } else if (connected === true) {
    note = `${who} sudah punya key tersimpan, tetapi provider menolak permintaannya. Kemungkinan utama: (1) HTTP 403 — model ini tidak berhak / kredit habis; (2) jaringan/region (proxy kantor) memblokir permintaan ke provider. Coba: Login ulang di 👤 Akun → OpenCode · Ganti model · jaringan lain.`;
  } else {
    note = `Status login ${name ? `provider «${name}»` : 'provider ini'} belum bisa dipastikan: periksa di 👤 Akun → OpenCode (Login provider / Login ulang bila perlu), lalu coba lagi.`;
  }
  // The status may arrive as data on the error or only in the text: a precise hint beats a generic one.
  const fromText = /(?:^|\D)(401|403|429)(?:\D|$)/.exec(text)?.[1];
  const given = status == null ? NaN : Number(status);
  const code = Number.isFinite(given) ? given : fromText ? Number(fromText) : null;
  const hint =
    code === 401
      ? 'HTTP 401: API key tidak dikenal atau sudah kedaluwarsa — login ulang provider ini.'
      : code === 403
        ? 'HTTP 403: key diterima tetapi model ini tidak berhak / kredit habis — atau jaringan (proxy/region) memblokirnya.'
        : code === 429
          ? 'HTTP 429: provider sedang sibuk atau kuota/rate limit tercapai — tunggu sebentar, lalu coba lagi.'
          : '';
  return `${text}\n${note}${hint ? `\n${hint}` : ''}`;
}

/**
 * OpenCode's OpenAI Chat parser discards an entire turn when an OpenAI-compatible host sends one trailing chunk
 * AFTER the `finish_reason` chunk (upstream anomalyco/opencode#56455). The reasoning/text case was fixed in #58851
 * (v2.2.0), but a trailing `tool_calls` chunk — a model issuing several tool calls at once — is still rejected in
 * v2.3.2, and the turn fails with "OpenAI Chat received content after the finish reason". This matches both the ACP
 * error message and, defensively, an upstream `errorName` that may travel beside it.
 */
export const LATE_STREAM_CHUNK_RE = /received content after the finish reason/i;
export const lateStreamChunkNote = (message) => {
  const text = typeof message === 'string' ? message : '';
  if (!LATE_STREAM_CHUNK_RE.test(text) || /bug parser OpenCode/.test(text)) return text;
  return `${text}\nProvider ini mengirim penutup stream yang tidak lazim (satu potongan tool setelah giliran selesai), lalu OpenCode membatalkan giliran itu — bug parser OpenCode (upstream #56455), bukan kesalahanmu. Coba kirim ulang pesan yang sama. Bila sering terjadi, provider ini sebaiknya disetel memanggil tool satu per satu (dimatikan otomatis untuk provider custom yang dibuat lewat ＋ Login provider).`;
}
/**
 * What the UI may offer for an OpenCode project (config.engines.opencode.caps, read by public/js/core/engine-caps.js).
 * Effort = OpenCode's per-model "effort" config option (thought level); Mode tim = the roles as OpenCode subagents.
 * Rewind = OpenCode's session.revert (conversation, with or without its file snapshots; no "code only").
 * Questions = OpenCode's `question` tool through ACP form elicitation; plan = our own card after a 📋 plan turn.
 * Long shells: found among the service's shells (src/opencode-shells.js) for live output, the stuck detector,
 * ⧗ Pindah ke latar, stop and the /tasks panel. /mcp: configured servers + live status/OAuth through the service
 * (src/opencode-mcp.js).
 * Not (yet): full session export, Claude transcript search, and Claude Code's permission/extension dialogs. Those
 * are Claude-only surfaces: the UI hides them and their routes refuse an OpenCode workspace.
 */
export const OPENCODE_CAPS = Object.freeze({
  effort: true,
  team: true,
  rewind: true,
  mcp: true, // configured servers + ＋ Tambah (opencode mcp add); live status/login through the service
  bgTasks: true, // the service's shells (src/opencode-shells.js): ⧗ Tugas latar, output, stop, Ctrl+B
  askQuestion: true,
  exportSession: false, // Claude transcripts only; OpenCode has its own JSON export in Riwayat Sesi
  permissions: false, // Claude settings files; OpenCode uses opencode.json
  extensions: false, // Claude plugins/agents/hooks; OpenCode manages its own
  search: true, // Claude transcripts + OpenCode sessions (src/opencode-search.js)
  mirror: true, // sessions opened in a terminal, from the shared background service (src/opencode-mirror.js)
  // The three native OpenCode modes: Build (normal work, auto-edit), Plan (read-only planning) and Auto (shell/web
  // without a permission card, like `opencode --auto`). The app's deny rules always win.
  modes: Object.freeze(['build', 'plan', 'autopilot']),
});

/**
 * What we offer at `initialize`. fs/terminal stay with OpenCode. `elicitation.form`: OpenCode 2.x then sends its
 * `question` tool (and other simple forms) as `elicitation/create`; without it the question is cancelled and the
 * model is told to continue without an answer.
 * Steering is NOT declared here: it is a SERVER capability (`result._meta.steering.supported`, probe of `opencode acp`
 * 2.3.0, 2026-11-19) and the client only calls `_session/steering` when the server advertised it — see steer().
 *
 * `_meta["opencode/child-session-updates"]`: OpenCode's OFFICIAL way to hear about a delegate's own session. Declared,
 * OpenCode sends `opencode/session/child_update` notifications (see onChildUpdate) whose `type:"status"` reports the
 * child `completed`/`failed`/`interrupted` — a signal that does NOT depend on the parent's own continuation, which can
 * be dropped (upstream #55760). Not declaring it leaves the app guessing from the parent's resumed turn alone.
 */
export const CLIENT_CAPABILITIES = Object.freeze({ fs: Object.freeze({ readTextFile: false, writeTextFile: false }), terminal: false, elicitation: Object.freeze({ form: Object.freeze({}) }), _meta: Object.freeze({ 'opencode/child-session-updates': true }) });

/** A steering instruction is one line of intent, not a new prompt: the cap keeps a stray paste out of the turn. */
const STEER_MAX = 2000;
/** The extension OpenCode 2.3.0 registers (upstream #54394); any other name answers "Method not found". */
const STEER_METHOD = '_session/steering';

/** 📋 Rencana dulu: what "Setujui" sends to OpenCode (now in build) after the plan turn. */
export const PLAN_APPROVED_PROMPT = 'Rencana disetujui. Kerjakan sekarang sesuai rencana di atas.';
/** The Auto tags that ride on a plan build/revision bubble (only the settings that were actually classified). */
const autoExtra = (auto) => ({ ...(auto?.autoEffort && { autoEffort: auto.autoEffort }), ...(auto?.autoModel && { autoModel: auto.autoModel }) });
/**
 * ✕ Tolak: Claude Code tells the model "denied" and the turn goes on; OpenCode ends the whole turn. So the app
 * continues it with this note (and the user's reason, when given): the model carries on without that step.
 */
export const rejectedPrompt = (label, reason) =>
  `Saya menolak izin untuk: ${label}.${reason ? ` Alasan: ${reason}` : ''} Jangan jalankan langkah itu. Lanjutkan pekerjaannya dengan cara lain, atau tanyakan dulu kalau tidak bisa tanpa langkah itu.`;

const MAX_FORM_FIELDS = 10;
const MAX_FORM_OPTIONS = 30;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * An `elicitation/create` form schema (flat JSON Schema object, MCP style) → the questions of our question card.
 * OpenCode's `question` tool: q0, q1… = one question each (string + oneOf = one choice, array + items.anyOf =
 * several), `<key>_custom` = its "type your own answer" companion. Unknown shapes are left out (unanswered).
 * @returns {{ key: string, custom: string|null, type: string, question: string, header: string,
 *   options: { value: string|boolean, label: string, description?: string }[], multiSelect: boolean }[]}
 */
export function elicitationFields(schema) {
  const props = schema?.type === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
  if (!props) return [];
  const fields = [];
  for (const [key, p] of Object.entries(props)) {
    if (!/^[\w.-]{1,64}$/.test(key) || !p || typeof p !== 'object') continue;
    if (key.endsWith('_custom') && props[key.slice(0, -'_custom'.length)]) continue; // the card's own typed answer
    if (!['string', 'array', 'boolean', 'number', 'integer'].includes(p.type)) continue;
    let options;
    if (p.type === 'boolean') options = [{ value: true, label: 'Ya' }, { value: false, label: 'Tidak' }];
    else {
      const raw = p.type === 'array' ? (p.items?.anyOf ?? p.items?.enum) : (p.oneOf ?? p.enum);
      options = (Array.isArray(raw) ? raw : []).slice(0, MAX_FORM_OPTIONS).flatMap((c, i) => {
        if (typeof c === 'string') return [{ value: c, label: str(p.enumNames?.[i], 200) || c.slice(0, 200) }];
        if (typeof c?.const !== 'string') return [];
        return [{ value: c.const, label: str(c.title, 200) || c.const.slice(0, 200), description: str(c.description, 500) || undefined }];
      });
      if (p.type === 'array' && !options.length) continue; // a list without choices can't be answered on the card
    }
    const custom = props[`${key}_custom`]?.type === 'string' ? `${key}_custom` : null;
    fields.push({ key, custom, type: p.type, question: str(p.description, 2000) || str(p.title, 2000) || key, header: str(p.title, 60), options, multiSelect: p.type === 'array' });
    if (fields.length >= MAX_FORM_FIELDS) break;
  }
  return fields;
}

/**
 * The card's answers (question text → the picked labels joined with ", ", a typed answer first) → the form's
 * `content`: option labels back to their values, a typed answer into `<key>_custom` (or the field itself when
 * it has no choices). An unanswered or unusable question is left out.
 */
export function elicitationContent(fields, answers = {}) {
  const content = {};
  for (const f of fields) {
    const text = typeof answers?.[f.question] === 'string' ? answers[f.question].trim().slice(0, 4000) : '';
    if (!text) continue;
    const byLabel = (label) => f.options.find((o) => o.label === label);
    if (f.type === 'boolean') {
      if (byLabel(text)) content[f.key] = byLabel(text).value;
    } else if (f.type === 'number' || f.type === 'integer') {
      const n = Number(text.replace(',', '.'));
      if (Number.isFinite(n) && (f.type === 'number' || Number.isInteger(n))) content[f.key] = n;
    } else if (f.type === 'array') {
      // labels may contain ", " themselves: the longest run of parts that is a label wins
      const parts = text.split(', ');
      const picked = [];
      const own = [];
      for (let i = 0; i < parts.length; ) {
        let j = parts.length;
        while (j > i && !byLabel(parts.slice(i, j).join(', '))) j--;
        if (j > i) {
          picked.push(byLabel(parts.slice(i, j).join(', ')).value);
          i = j;
        } else own.push(parts[i++]);
      }
      if (picked.length) content[f.key] = [...new Set(picked)];
      if (own.length && f.custom) content[f.custom] = own.join(', ');
    } else if (byLabel(text)) content[f.key] = byLabel(text).value;
    else if (!f.options.length) content[f.key] = text;
    else if (f.custom) content[f.custom] = text;
  }
  return content;
}

/** OpenCode's `question` tool input ({ question, header, options, multiple }) → AskUserQuestion's questions. */
const askQuestions = (list) =>
  (Array.isArray(list) ? list : []).slice(0, MAX_FORM_FIELDS).map((q) => ({
    question: str(q?.question, 2000),
    header: str(q?.header, 60),
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, MAX_FORM_OPTIONS).map((o) => ({ label: str(o?.label, 200), description: str(o?.description, 500) })),
    multiSelect: q?.multiple === true,
  }));

/** Ledger account for OpenCode turns; kept exported here for tests and the parity helper. */
export { OPENCODE_ACCOUNT };

/**
 * The app's permission mode → OpenCode `permission` config (passed per process in OPENCODE_CONFIG_CONTENT, so the
 * user's own OpenCode config files are never touched). "ask" makes OpenCode send session/request_permission.
 */
export function permissionConfig(mode, user = {}) {
  // Build = auto-edit: files may be written automatically; shell and network still ask. Plan is read-only: edit and
  // shell are denied outright, and even a user "allow" cannot open them (mergePermission's plan rule). Auto
  // (autopilot) = like `opencode --auto`: shell and network are allowed too, but explicit user denies still win and
  // the `read` tool is untouched (so OpenCode's own .env ask stays). 'dontAsk' stays deny-all as a defence in depth.
  const base =
    mode === 'dontAsk' || mode === 'plan' ? { edit: 'deny', bash: 'deny', webfetch: 'deny' }
    : mode === 'autopilot' ? { edit: 'allow', bash: 'allow', webfetch: 'allow' }
    : { edit: 'allow', bash: 'ask', webfetch: 'ask' }; // build (and any legacy mode normalized to it)
  // The user's own rules are kept, never loosened by the mode: see mergePermission (src/opencode-bin.js).
  return mergePermission(base, user, mode);
}

/**
 * OpenCode's primary agent: 📋 Rencana dulu = its read-only "plan" agent; otherwise the agent picked in
 * Pengaturan giliran (build, or a custom primary agent from the user's OpenCode config), "build" by default.
 */
/**
 * The per-process config OpenCode reads from OPENCODE_CONFIG_CONTENT (the user's own files are never touched).
 *
 * `experimental.todo` turns on OpenCode V2's `todowrite` tool, which is OFF by default ("Todos are off by default in
 * V2", opencode.ai/docs/migrate-v1). Without it OpenCode sends no `plan` updates, so the office's whiteboard stays
 * empty for every OpenCode project. The flag is experimental upstream, so a version that drops it must still start:
 * the risk is an empty whiteboard, never a refused process.
 */
export function openCodeConfigContent(settings, user = {}, todo = true) {
  return JSON.stringify({ ...(todo ? { experimental: { todo: true } } : {}), permission: permissionConfig(settings.mode, user) });
}

const agentMode = (s) => agentForMode(s.mode, s.agent);
/** Settings that only a fresh process can change (the permission config and the team are read at start). */
const processKey = (s) => JSON.stringify([permissionConfig(s.mode), Boolean(s.team)]);

/** OpenCode's slash commands (available_commands_update) for the app's autocomplete. */
const cleanCommands = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((c) => typeof c?.name === 'string' && /^[\w:.-]{1,60}$/.test(c.name))
    .slice(0, 200)
    .map((c) => ({ name: c.name, description: String(c.description ?? '').slice(0, 200), argumentHint: typeof c.input?.hint === 'string' ? c.input.hint.slice(0, 80) : undefined }));

/**
 * The app's effort → a value of OpenCode's `effort` option for the current model (its values differ per model, e.g.
 * low | high | max | default). Nearest offered level; '' (Default) → "default". null when the model has no effort.
 * `refused` holds the levels the provider already rejected for this model (src/effort-memory.js): they are never sent
 * again. A refused level goes straight to Default — guessing the neighbour risks another failed request.
 */
const EFFORT_CANDIDATES = { '': ['default'], none: ['none', 'minimal', 'low'], minimal: ['minimal', 'low', 'none'], low: ['low', 'minimal'], medium: ['medium', 'default'], high: ['high'], xhigh: ['xhigh', 'max', 'high'], max: ['max', 'xhigh', 'high'] };
export function effortValue(effort, configOptions, refused = null) {
  const values = (configOptions ?? []).find((o) => o.id === 'effort')?.options?.map((o) => o.value) ?? [];
  const allowed = (v) => values.includes(v) && !refused?.has(v);
  const fallback = () => (EFFORT_CANDIDATES[''] ?? []).find(allowed) ?? null;
  if (effort && values.includes(effort)) return refused?.has(effort) ? fallback() : effort; // the model's own level
  const nearest = (EFFORT_CANDIDATES[effort ?? ''] ?? []).find(allowed);
  if (nearest) return nearest;
  return effort ? fallback() : null; // an offered level was refused: Default, never a guess that may fail too
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .map((c) => c?.content?.text ?? c?.text ?? (c?.type === 'diff' ? `${c.path ?? ''} diubah` : ''))
    .filter(Boolean)
    .join('\n');

/**
 * An ACP tool call as a Claude Code tool (name + input), so roles.js (who in the office does it, which screen, the
 * label) and the approval card's preview work as for Claude. `kind`/`title`/`rawInput` as OpenCode sends them.
 */
export function mapTool({ kind, title = '', rawInput = {}, locations = [], content = [] } = {}) {
  const t = String(title).toLowerCase();
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const file = input.path ?? input.filePath ?? input.file_path ?? input.files?.[0]?.file ?? locations?.[0]?.path;
  const diff = (Array.isArray(content) ? content : []).find((c) => c?.type === 'diff');
  if (typeof input.command === 'string') return { name: 'Bash', input: { command: input.command, description: input.description } };
  if (t === 'question') return { name: 'AskUserQuestion', input: { questions: askQuestions(input.questions) } };
  if (t.startsWith('todo')) return { name: 'TodoWrite', input: { todos: Array.isArray(input.todos) ? input.todos : [] } };
  // OpenCode 2.x delegates with `subagent` ({ agent, prompt, description }); 1.x with `task` ({ subagent_type }).
  if (t === 'task' || t === 'agent' || t === 'subagent') return { name: 'Agent', input: { subagent_type: input.subagent_type ?? input.agent ?? 'general', description: input.description ?? title, prompt: input.prompt } };
  if (kind === 'read' || t === 'read') return { name: 'Read', input: { file_path: file } };
  if (kind === 'edit' || ['write', 'edit', 'patch', 'multiedit', 'apply_patch'].includes(t)) {
    const oldText = diff?.oldText ?? input.oldString ?? input.old_string;
    const newText = diff?.newText ?? input.newString ?? input.new_string ?? input.content;
    return oldText ? { name: 'Edit', input: { file_path: diff?.path ?? file, old_string: oldText, new_string: newText ?? '' } } : { name: 'Write', input: { file_path: diff?.path ?? file, content: newText ?? '' } };
  }
  if (kind === 'search' || ['grep', 'glob', 'list', 'codesearch'].includes(t)) return { name: t === 'glob' || t === 'list' ? 'Glob' : 'Grep', input: { pattern: input.pattern ?? input.query ?? title, path: input.path } };
  if (kind === 'fetch' || ['webfetch', 'fetch', 'websearch'].includes(t)) return t === 'websearch' ? { name: 'WebSearch', input: { query: input.query } } : { name: 'WebFetch', input: { url: input.url, prompt: input.prompt } };
  if (kind === 'execute' && !input.code) return { name: 'Bash', input: { command: title } };
  return { name: title || 'tool', input };
}

/** ACP `session/update` notifications → Claude Code stream-json messages for StreamTranslator. */
export class AcpAdapter {
  /** @param {(msg: object) => void} emit */
  constructor(emit) {
    this.emit = emit;
    this.tools = new Map(); // toolCallId -> { kind, title, rawInput, locations, content, started, done, parent }
    // Mode tim: a running `subagent` call's description -> its toolCallId. OpenCode streams the subagent's own tool
    // calls into the same session titled "<description>: <tool>"; they become that role's work (parent_tool_use_id).
    this.subagents = new Map(); // description -> [toolCallId, …] (several subagents may share one description)
    // A `subagent` call is only the LAUNCH: OpenCode resolves it at once ("working in the background") and the
    // child keeps working as its OWN session, streaming its steps here later. That session id is the authoritative
    // link (the call announced it in rawOutput.metadata.sessionID; its steps carry `_meta['opencode/child-session']`
    // or a `<sessionId>:` prefixed call id). Kept for the whole session, so a step that starts AND finishes long
    // after the turn still finds its delegation, keeps its role, and closes its own row.
    this.childSessions = new Map(); // child session id -> { call: the launching toolCallId, title: the child's own title }
    this.settleTimers = new Map(); // child toolCallId -> timer that closes a step whose final update never came
    // Child steps whose one-turn grace ran out (or whose turn was stopped): closed by the translator already, so a
    // late frame for one of them must NOT open a fresh row. Bounded like `childSessions`.
    this.droppedChildren = new Set();
    // Background shell calls (toolCallId -> info), kept after the turn's tools are cleared: OpenCode notifies the
    // session when such a shell finishes, and that late frame must still close its ⧗ task.
    this.backgroundShells = new Map();
    // ACP delegations (openCode `subagent`/`task`) as ⧗ tasks: launch call id -> liveness + detail of its child.
    this.agents = new Map();
    this.text = null; // { id, parts } — the assistant message being streamed
    this.lastText = ''; // the last finished assistant message of the turn (reset per turn by the session)
    this.planSeq = 0;
  }

  update(u) {
    switch (u?.sessionUpdate) {
      case 'agent_message_chunk': {
        const piece = u.content?.type === 'text' ? u.content.text : '';
        if (!piece) return;
        // A child session's own answer: keep the tail for the delegation's detail dialog (and keep its task alive).
        const childSid = this.childSessionId(u);
        if (childSid) {
          const agent = this.agentOfChild(childSid);
          if (agent) {
            agent.lastAt = Date.now();
            agent.lastText = `${agent.lastText ?? ''}${piece}`.slice(-4000);
          }
        }
        const id = u.messageId ?? 'acp-message';
        if (this.text?.id !== id) {
          this.flushText();
          this.text = { id, parts: [] };
          this.emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
        }
        this.text.parts.push(piece);
        this.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
        return;
      }
      case 'agent_thought_chunk':
        this.emit({ type: 'assistant', message: { id: 'acp-thinking', content: [{ type: 'thinking', thinking: '' }] } }); // the translator throttles
        return;
      case 'tool_call':
      case 'tool_call_update': {
        // Closed for us already (grace ran out, or the turn was stopped): a frame that slipped past the idle gate
        // (the turn is busy now) must not create a phantom row for it.
        if (this.droppedChildren.has(String(u.toolCallId ?? ''))) return;
        const info = this.toolInfo(u.toolCallId, u);
        if (u.status === 'in_progress' || u.status === 'completed' || u.status === 'failed') this.start(u.toolCallId);
        if ((u.status === 'completed' || u.status === 'failed') && info.done) {
          // A background shell's call was already "completed" when it was released to the background. A later
          // completed/failed frame for that same call is the real finish (OpenCode docs: background calls notify the
          // session when they finish) — close its ⧗ task from it, with the output it carries.
          if (this.backgroundShells.has(u.toolCallId)) {
            const text = textOf(u.content) || (u.rawOutput?.error ? String(u.rawOutput.error) : '');
            this.finishShellTask(info, u.status, text, { force: true });
          }
          return;
        }
        if (u.status === 'completed' || u.status === 'failed') {
          info.done = true;
          const text = textOf(u.content) || (u.rawOutput?.error ? String(u.rawOutput.error) : u.status === 'completed' ? 'ok' : 'gagal');
          this.emit({ type: 'user', parent_tool_use_id: info.parent ?? null, message: { content: [{ type: 'tool_result', tool_use_id: u.toolCallId, content: clip(text, 8000), is_error: u.status === 'failed' }] } });
          // Late metadata (only on the final update): the task still exists, already finished.
          this.adoptBackgroundShell(info, text);
          this.registerShellTask(u.toolCallId, info, mapTool(info).name, info.rawInput ?? {});
          this.finishShellTask(info, u.status, text);
          // A `subagent` call resolving this way is only its LAUNCH ("working in the background"): the child runs
          // on as its own session, so its description key stays — the late steps still need it to find their row.
          if (!this.launchesChild(u.toolCallId)) {
            for (const [desc, ids] of this.subagents) {
              const left = ids.filter((x) => x !== u.toolCallId);
              if (left.length) this.subagents.set(desc, left);
              else this.subagents.delete(desc);
            }
            // A delegation that reported INLINE (no child session of its own) is over with its call. Its ⧗ task must
            // close here: left running, it would keep `hasRunningTasks()` true forever and every deferred restart
            // (a model/mode/team change, a provider login) would wait for a task that will never end.
            this.finishInlineAgentTask(u.toolCallId, u.status);
          }
        }
        return;
      }
      case 'plan': {
        const todos = (u.entries ?? []).map((e) => ({ content: String(e.content ?? ''), status: ['pending', 'in_progress', 'completed'].includes(e.status) ? e.status : 'pending' }));
        const id = `acp-plan-${++this.planSeq}`;
        this.flushText();
        this.emit({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }] } });
        this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
        return;
      }
      default:
    }
  }

  /** OpenCode's child-session marker on a child's own frames: `{ id, parentID, depth, title }`. */
  childMarker(u = {}) {
    return u._meta?.['opencode/child-session'] ?? u.meta?.['opencode/child-session'];
  }

  /** The child session a call belongs to: the `_meta` marker OpenCode sends, else the `<sessionId>:` id prefix. */
  childSessionId(u = {}) {
    const meta = this.childMarker(u);
    if (typeof meta?.id === 'string' && meta.id) return meta.id;
    const head = String(u.toolCallId ?? '').split(':')[0];
    return OPENCODE_SESSION.test(head) ? head : null;
  }

  /** Records a child session (idempotent, bounded): its own title and the `subagent` call that launched it. */
  registerChild(sid, patch = {}) {
    if (!sid) return null;
    const entry = { ...(this.childSessions.get(sid) ?? {}), ...patch };
    this.childSessions.set(sid, entry);
    if (this.childSessions.size > 200) this.childSessions.delete(this.childSessions.keys().next().value);
    return entry;
  }

  /** Bounded tombstone: a call whose row was closed for us (its grace ran out, or its turn was stopped) never reopens. */
  dropChild(id) {
    this.droppedChildren.add(id);
    if (this.droppedChildren.size > 200) this.droppedChildren.delete(this.droppedChildren.values().next().value);
  }

  /** True when this call launched a child session OpenCode keeps running past the turn (its steps stay reachable). */
  launchesChild(callId) {
    for (const entry of this.childSessions.values()) if (entry.call === callId) return true;
    return false;
  }

  /**
   * A child step whose turn already ended may never get its final update (OpenCode stops relaying the child once
   * the parent prompt resolved). Give it one grace, then close the row with a note instead of a forever spinner.
   * Called for every frame: cheap when the call is not a child step or the turn is still busy.
   */
  armSettle(u, busy = false) {
    const id = String(u?.toolCallId ?? '');
    const info = id ? this.tools.get(id) : null;
    if (!info?.child) return;
    if (u.status === 'completed' || u.status === 'failed' || info.done) {
      this.clearSettle(id);
      return;
    }
    if (busy || !info.started || this.settleTimers.has(id)) return;
    const timer = setTimeout(() => this.settleChild(id), CHILD_SETTLE_MS);
    timer.unref?.();
    this.settleTimers.set(id, timer);
  }

  /** Turn ended: every child step still open gets the same grace (its real result may still arrive first). */
  armOpenChildren(isRunning = () => false) {
    for (const [id, info] of this.tools) {
      if (!info.child || info.done || !info.started || this.launchesChild(id) || this.settleTimers.has(id)) continue;
      // Its delegation task is still running: the row must stay open until that task ends (it may be a long build).
      const call = this.childSessions.get(info.child)?.call;
      if (call && isRunning(call)) continue;
      const timer = setTimeout(() => this.settleChild(id), CHILD_SETTLE_MS);
      timer.unref?.();
      this.settleTimers.set(id, timer);
    }
  }

  /** The grace ran out: close the row with an honest note (the ⧗ task, if any, keeps running on its own). */
  settleChild(id) {
    this.settleTimers.delete(id);
    const info = this.tools.get(id);
    if (!info || info.done) return;
    info.done = true;
    this.emit({
      type: 'user',
      parent_tool_use_id: info.parent ?? null,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: 'Tidak ada kabar lanjutan dari subagent setelah giliran selesai. Kalau pekerjaannya masih berjalan, buka ⧗.',
            is_error: false,
            stale: true,
          },
        ],
      },
    });
    this.dropChild(id);
  }

  clearSettle(id) {
    const timer = this.settleTimers.get(id);
    if (timer) clearTimeout(timer);
    this.settleTimers.delete(id);
  }

  clearSettles() {
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
    this.settleTimers.clear();
  }

  /** Merges what OpenCode said about a tool call so far (fields arrive spread over several updates). */
  toolInfo(id, u = {}) {
    const info = this.tools.get(id) ?? this.backgroundShells.get(id) ?? { kind: 'other', title: '', rawInput: {}, locations: [], content: [], started: false, done: false };
    if (u.kind) info.kind = u.kind;
    // OpenCode's shell tool tags its calls with metadata (shellID, background, command) while running AND in the
    // final one (rawOutput.metadata): kept here, so the session can register `oc:<shellID>` as a background task.
    const meta = { ...(u._meta && typeof u._meta === 'object' ? u._meta : {}), ...(u.meta && typeof u.meta === 'object' ? u.meta : {}), ...(u.rawOutput?.metadata?.shellID ? u.rawOutput.metadata : {}) };
    if (meta.shellID) info.meta = { ...info.meta, ...meta };
    // A `subagent` call's final update announces the child session it just started: the authoritative link to the
    // steps that will stream later (a title prefix is only a fallback).
    const announced = typeof u.rawOutput?.metadata?.sessionID === 'string' ? u.rawOutput.metadata.sessionID : null;
    if (announced) {
      this.registerChild(announced, { call: id });
      const agent = this.agents.get(id);
      if (agent) agent.sessionId = announced;
    }
    // A child session's own call carries the marker (or a `<sessionId>:` prefixed id): link it to its delegation.
    const sid = this.childSessionId(u);
    if (sid) {
      const marker = this.childMarker(u);
      const entry = this.registerChild(sid, typeof marker?.title === 'string' && marker.title ? { title: marker.title } : {});
      info.child = sid;
      if (entry?.title) info.childTitle ??= String(entry.title);
      if (!info.parent && entry?.call) info.parent = entry.call;
      const step = typeof u.rawInput?.command === 'string' ? u.rawInput.command : typeof u.title === 'string' ? u.title : null;
      this.touchAgent(sid, step);
    }
    if (u.title) {
      // "<subagent description>: <tool>" (the child session's own title, or the description it was launched with)
      // → the subagent's own call, under its Agent row. Longest prefix first (a description may itself contain ": ").
      const title = String(u.title);
      const names = [...this.subagents.keys(), ...(info.childTitle ? [info.childTitle] : [])];
      const desc = names.filter((d) => title.startsWith(`${d}: `)).sort((a, b) => b.length - a.length)[0];
      // The marker/prefix link (`info.parent`) always wins. The title is only a fallback, and then the NEWEST call
      // with that description: the oldest may be a launch that finished long ago (its key now survives the turn).
      const ids = desc ? (this.subagents.get(desc) ?? []) : [];
      const open = ids.filter((x) => this.tools.get(x)?.started && !this.tools.get(x)?.done);
      const parent = info.parent ?? (open.length ? open.at(-1) : ids.at(-1));
      if (parent && parent !== id) {
        info.parent = parent;
        info.title = desc ? title.slice(desc.length + 2) : title;
      } else if (!info.parent) {
        info.title = title;
        info.firstTitle ??= title; // a delegated step names its role here ("backend"); later updates rename the call
      }
    }
    if (u.rawInput && Object.keys(u.rawInput).length) info.rawInput = u.rawInput;
    if (u.locations?.length) info.locations = u.locations;
    if (u.content?.length) info.content = u.content;
    this.tools.set(id, info);
    return info;
  }

  /** The tool row (and the office's worker) starts once OpenCode knows what the tool does. */
  start(id) {
    const info = this.toolInfo(id);
    if (info.started) return mapTool(info);
    info.started = true;
    this.flushText(); // the text before a tool call ends there, as in Claude's messages
    const { name, input } = mapTool(info);
    // A delegated step names its role in its first title ("backend") even when a later update renames the call
    // to the step's own label: the block carries it so the translator attributes the work to that role.
    const stepRole = ROLE_IDS.includes(String(info.firstTitle ?? '').toLowerCase()) ? String(info.firstTitle).toLowerCase() : null;
    const block = { type: 'tool_use', id, name, input, ...(stepRole ? { stepRole } : {}) };
    // only a real description (not the "subagent" title fallback) can prefix the subagent's own calls
    const desc = info.rawInput?.description;
    if (name === 'Agent' && typeof desc === 'string' && desc) this.subagents.set(desc, [...(this.subagents.get(desc) ?? []), id]);
    if (name === 'Agent') this.registerAgentTask(id, info, input); // a delegation is background work: ⧗ Tugas latar
    this.emit({ type: 'assistant', parent_tool_use_id: info.parent ?? null, message: { id: `acp-tool-${id}`, content: [block] } });
    this.registerShellTask(id, info, name, input);
    return { name, input };
  }

  /**
   * OpenCode's `subagent`/`task` call is a DELEGATION, not a normal tool: it resolves at once ("working in the
   * background") and the child session keeps working after the parent's turn. Register it as a ⧗ task from the
   * start, so a long delegated job (e.g. `flutter build apk`) is visible with its duration and last step.
   */
  registerAgentTask(id, info, input) {
    if (info.agentTask) return;
    info.agentTask = true;
    const description = String(input?.description ?? info.title ?? 'Subagent').slice(0, 200) || 'Subagent';
    const agent = String(input?.subagent_type ?? 'general').slice(0, 40);
    this.agents.set(id, { taskId: `oc-agent-${id}`, call: id, sessionId: null, description, agent, steps: [], lastText: '', lastAt: Date.now(), sentAt: 0, done: false });
    // Bounded: a long session may launch many delegations; their steps and last answer must not pile up forever.
    if (this.agents.size > 50) {
      for (const [key, a] of this.agents) {
        if (a.done) {
          this.agents.delete(key);
          break;
        }
      }
      if (this.agents.size > 50) this.agents.delete(this.agents.keys().next().value);
    }
    this.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: `oc-agent-${id}`,
      subagent_type: agent,
      is_backgrounded: true,
      tool_use_id: id,
      description,
      startedAt: Date.now(),
      source: 'acp',
    });
  }

  /** The delegation whose child session this is (or null): used for its task's liveness and detail. */
  agentOfChild(sid) {
    const call = sid ? this.childSessions.get(sid)?.call : null;
    return call ? this.agents.get(call) : null;
  }

  /** The delegation's task is over: its record no longer needs to stay (the bounded map keeps the newest). */
  markAgentDone(callId) {
    const agent = this.agents.get(callId);
    if (agent) agent.done = true;
  }

  /**
   * A delegation that reported INLINE (its call completed without starting a child session) is over. Close its ⧗
   * task here: the translator deliberately leaves an ACP delegation "running" because the usual kind works on as a
   * child session, so an inline one would otherwise keep `hasRunningTasks()` true forever — and every deferred
   * restart (model/mode/team, provider login) would wait for a task that will never end.
   */
  finishInlineAgentTask(callId, status) {
    const agent = this.agents.get(callId);
    // Only a registered delegation has an `oc-agent-…` ⧗ task. Any other completed call (the parent's own read, a
    // child session's step whose id is `<sid>:<callId>`) must NOT emit a close for a task that never existed — the
    // translator would create a phantom "shell" row from that frame (kind defaults to 'shell') and every
    // task-output/stop action on it would 404 ("Tugas tidak ditemukan").
    if (!agent) return;
    agent.done = true;
    // Frames go through `emit`, exactly like every other update: the translator owns the ⧗ task list.
    this.emit({ type: 'system', subtype: 'task_updated', task_id: `oc-agent-${callId}`, patch: { status: status === 'failed' ? 'failed' : 'completed' } });
  }

  /**
   * Closes the child step rows of a delegation whose work is over (`callId` null = every delegation, on ■ Stop or a
   * process close). The note is honest: a command may have finished while its final frame never came.
   */
  closeChildRows(callId = null, note = 'Tugas delegasi selesai — lihat laporan di chat.') {
    for (const [id, info] of this.tools) {
      if (!info.child || info.done) continue;
      const owner = this.childSessions.get(info.child)?.call;
      if (callId && owner !== callId) continue;
      info.done = true;
      this.emit({ type: 'user', parent_tool_use_id: info.parent ?? null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: note, is_error: false }] } });
    }
  }

  /** One child frame: keeps the delegation's task alive and records the step for its detail dialog. */
  touchAgent(sid, step) {
    const agent = this.agentOfChild(sid);
    if (!agent) return;
    agent.lastAt = Date.now();
    if (step) {
      agent.steps.push({ ts: Date.now(), type: 'tool', text: String(step).slice(0, 200), status: 'running' });
      if (agent.steps.length > 60) agent.steps.splice(0, agent.steps.length - 60);
    }
    if (Date.now() - (agent.sentAt ?? 0) < 3000) return; // throttle: the task's lastActivityAt only needs a nudge
    agent.sentAt = Date.now();
    this.emit({ type: 'system', subtype: 'task_progress', task_id: agent.taskId, summary: agent.steps.at(-1)?.text ?? agent.description, last_tool_name: agent.steps.at(-1)?.text ?? null });
  }

  /**
   * OpenCode's shell tool announces a backgrounded command in its OUTPUT text, not in metadata (v2.2.5/2.3.0):
   * "Command moved to the background (shell ID: sh_…). PID: …". Adopt that as the call's metadata, so the ⧗ task
   * exists, its output file is readable, and its PID can be checked for completion. Metadata wins when present.
   *
   * Since 2.3.1 a command that hits its timeout is MOVED TO THE BACKGROUND instead of being killed ("Timed-Out Shell
   * Commands Keep Running"), and OpenCode words that differently — so the test covers the timeout wording too. The
   * pattern stays deliberately general: an unknown future wording with "shell ID" still lands here, and an
   * announcement without an id is ignored (never a task nobody can finish).
   */
  adoptBackgroundShell(info, text) {
    if (info.meta?.shellID) return;
    const body = String(text ?? '');
    // 2.3.1+: timeout → background, no longer "killed". Accept that sentence as well as the plain move.
    const moved = /moved to the background/i.test(body) || /(timed? ?out|timeout)[^.]{0,80}background/i.test(body);
    if (!moved) return;
    const shellId = /shell ID:\s*(sh_[\w-]{1,100})/i.exec(body)?.[1];
    if (!shellId) return;
    const pid = Number(/PID:\s*(\d{1,10})/.exec(body)?.[1]) || null;
    info.meta = { ...(info.meta ?? {}), shellID: shellId, background: true, ...(pid ? { pid } : {}) };
  }

  /**
   * OpenCode's shell tool names its shell in the call's metadata (shellID): the task `oc:<shellID>` exists from the
   * first update, so the ⧗ panel, the stuck chip and stop work from the very start (like Claude Code's tasks). Its
   * state later comes only from the tool call itself (never from the output file).
   */
  registerShellTask(id, info, name, input) {
    const shellId = String(info.meta?.shellID ?? '');
    if (info.shellTask || !/^sh_[\w-]{1,100}$/.test(shellId) || (name !== 'Bash' && name !== 'PowerShell')) return;
    info.shellTask = true;
    info.callId = id;
    const command = typeof input.command === 'string' ? input.command : info.title;
    this.emit({ type: 'system', subtype: 'task_started', task_id: `oc:${shellId}`, is_backgrounded: Boolean(info.meta.background), tool_use_id: id, description: command, startedAt: Date.now(), source: 'acp', pid: Number.isFinite(info.meta?.pid) ? info.meta.pid : undefined });
    // A background shell outlives its tool call: remember the call so a late `completed` frame (OpenCode notifies the
    // session when it finishes) still reaches this task after the turn's tools were cleared.
    if (info.meta?.background) {
      this.backgroundShells.set(id, info);
      if (this.backgroundShells.size > 20) this.backgroundShells.delete(this.backgroundShells.keys().next().value);
    }
  }

  /**
   * The call is over. A foreground shell's task ends with it. A BACKGROUND shell's first completion only means
   * "released to the background": OpenCode keeps it running and (docs: "notify the session when they finish") sends
   * a later update — `force` closes the task from that late frame. Without such a frame the process-tree sweep in the
   * session (reapBackgroundShells) is the fallback.
   */
  finishShellTask(info, status, text = '', { force = false } = {}) {
    const shellId = String(info.meta?.shellID ?? '');
    if (!info.shellTask || !/^sh_[\w-]{1,100}$/.test(shellId)) return;
    if (info.meta?.background && !force) return; // it keeps running past the call: not finished yet
    this.emit({
      type: 'system',
      subtype: 'task_updated',
      task_id: `oc:${shellId}`,
      patch: {
        status: status === 'failed' ? 'failed' : 'completed',
        ...(status === 'failed' && text ? { error: clip(text, 300) } : {}),
        ...(text ? { summary: clip(text, 300) } : {}), // the late frame carries the real output/exit
      },
    });
    if (info.meta?.background) this.backgroundShells.delete(info.callId);
  }

  flushText() {
    const t = this.text;
    this.text = null;
    if (!t?.parts.length) return;
    this.lastText = t.parts.join(''); // the turn's last answer: in 📋 plan mode, the plan on the approval card
    this.emit({ type: 'assistant', message: { id: t.id, content: [{ type: 'text', text: this.lastText }] } });
  }

  /** The turn's result line (what Claude Code's `result` message carries). */
  finish({ ok, interrupted = false, error = '', durationMs, usage = {}, costUsd = null }) {
    this.flushText();
    const outputTokens = (usage.outputTokens ?? 0) + (usage.thoughtTokens ?? 0);
    // A delegation OpenCode keeps running past the turn: its open calls — and the steps under them — stay known so
    // the late updates still find their parent and their results close the rows. Everything else is dropped.
    const snap = [...this.tools];
    const still = new Set();
    for (const [id, info] of snap) {
      if (!info.started || info.done) continue;
      // A ■ Stop ends the whole turn, subagents included: nothing stays open (a launch kept here would hang its row
      // and its role's "working" chip forever, since a stopped turn no longer accepts its frames). Every open call is
      // tombstoned, so a stray late frame cannot resurrect a row after the user cancelled.
      if (interrupted) {
        this.dropChild(id);
        continue;
      }
      // A depth-2+ delegation is itself a launch even though its own frame carries its parent's marker: it takes the
      // delegation branch below, never the child-step grace.
      if (info.child && !this.launchesChild(id)) {
        // A child session's own step: it outlives the turn that saw it (the child works on). One turn of grace — its
        // real (late) result closes the row; still open at the next turn's end, it is dropped (and tombstoned, so a
        // later frame cannot resurrect it): the translator closes the row with a synthetic note, never an endless spinner.
        if ((info.turnsOpen = (info.turnsOpen ?? 0) + 1) > 1) {
          this.dropChild(id);
          continue;
        }
        still.add(id);
      } else if (info.parent) {
        const agent = this.tools.get(info.parent);
        if (agent?.started && !agent.done) still.add(id); // a live delegation's step
      } else if (this.launchesChild(id) || this.subagents.has(String(info.rawInput?.description ?? ''))) still.add(id); // the delegation itself
    }
    this.emit({
      type: 'result',
      subtype: ok ? 'success' : interrupted ? 'interrupted' : 'error_during_execution',
      is_error: !ok,
      result: ok ? '' : error,
      duration_ms: durationMs,
      num_turns: 1,
      usage: { input_tokens: usage.inputTokens ?? 0, output_tokens: outputTokens, cache_read_input_tokens: usage.cachedReadTokens ?? 0 },
      total_cost_usd: costUsd ?? undefined,
      turnUsage: { costUsd: costUsd ?? 0, outputTokens },
      permission_denials: [],
      ...(still.size ? { stillDelegating: [...still] } : {}),
    });
    this.tools.clear();
    for (const id of still) {
      const info = snap.find(([sid]) => sid === id)?.[1];
      if (info) this.tools.set(id, info);
    }
    for (const [desc, ids] of this.subagents) {
      // A launch that started a child session keeps its key: the late steps find their delegation through it.
      const left = ids.filter((x) => still.has(x) || this.launchesChild(x));
      if (left.length) this.subagents.set(desc, left);
      else this.subagents.delete(desc);
    }
    return still.size; // the session opens its resume window when something of OpenCode keeps working
  }

  /**
   * A `tool_call` update after the turn's end still belongs to the conversation when it is a delegation OpenCode
   * keeps running (or resolves one of its calls): those pass the idle gate; anything else stays dropped.
   */
  continues(u) {
    if (u?.sessionUpdate !== 'tool_call' && u?.sessionUpdate !== 'tool_call_update') return false;
    const id = String(u.toolCallId ?? '');
    // A closed (grace-expired or stopped) child step never reopens — a fresh row would be a phantom.
    if (this.droppedChildren.has(id)) return false;
    if (this.tools.has(id)) return true;
    // A background shell outlives the turn: OpenCode's late "finished" frame must reach its task, not be dropped.
    if (this.backgroundShells.has(id)) return true;
    const sid = this.childSessionId(u);
    if (sid) {
      // The `_meta` marker is OpenCode's own statement that this frame belongs to a child session it is running:
      // trust it (and remember the child, so its later frames are known). A launch's frame can be swallowed during a
      // session/load replay, and the child's steps must still show.
      const marker = this.childMarker(u);
      if (marker) {
        this.registerChild(sid, typeof marker.title === 'string' && marker.title ? { title: marker.title } : {});
        return true;
      }
      // A bare `<sessionId>:` id is only a shape: a foreign session's replayed frame must not reopen the office, so
      // the child has to be one a launch actually announced.
      if (this.childSessions.has(sid)) return true;
    }
    const title = String(u.title ?? '');
    return [...this.subagents.keys()].some((d) => title.startsWith(`${d}: `));
  }
}

/** Prompt content for ACP: text plus 📎 images; text files ride along inside the text. */
/**
 * `@path` mentions of files inside the project → ACP resource_link blocks (the text keeps the mention), so OpenCode
 * knows the real file like in its own TUI. Only existing files below the project folder; at most 20.
 */
export function mentionLinks(text, projectPath) {
  if (!projectPath) return [];
  const root = path.resolve(projectPath);
  const links = [];
  const seen = new Set();
  for (const m of String(text).matchAll(/(?:^|\s)@([\w./\\:-]+[\w/\\])/g)) {
    const abs = path.resolve(root, m[1]);
    if (seen.has(abs) || !(abs + path.sep).startsWith(root + path.sep) || abs === root) continue;
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    seen.add(abs);
    links.push({ type: 'resource_link', uri: pathToFileURL(abs).href, name: path.relative(root, abs).replace(/\\/g, '/') });
    if (links.length >= 20) break;
  }
  return links;
}

function promptBlocks(text, attachments = [], projectPath = null) {
  const blocks = [];
  const extra = [];
  for (const a of attachments) {
    if (a.kind === 'image' && a.data) blocks.push({ type: 'image', mimeType: a.mediaType, data: a.data });
    else if (typeof a.text === 'string') extra.push(`<file name="${a.name}">\n${a.text}\n</file>`);
    else extra.push(`(lampiran ${a.name} tidak bisa dikirim ke OpenCode)`);
  }
  blocks.unshift({ type: 'text', text: [text, ...extra].filter(Boolean).join('\n\n') });
  blocks.push(...mentionLinks(text, projectPath));
  return blocks;
}

/**
 * Builds the OpenCode session class on top of ClaudeSession (passed in: a static import would be circular).
 * @param {typeof import('./session.js').ClaudeSession} ClaudeSession
 * @param {{ previewInput: Function, continuePrompt: string }} helpers
 */
export function acpSessionClass(ClaudeSession, { previewInput }) {
  return class AcpSession extends ClaudeSession {
    constructor(manager, project) {
      super(manager, project);
      this.engine = 'opencode';
      this.rpcSeq = 0;
      this.rpcPending = new Map(); // id -> { resolve, reject, timer }
      this.acpSessionId = null;
      this.ready = null;
      this.cost = null; // cumulative session cost from usage_update (per turn = difference)
      this.epoch = 0; // +1 whenever the process is let go (closeChild/kill): a late turn result is then ignored
      this.badEfforts = new Set(); // effort levels this provider refused (see fallBackEffort): never sent again
      this.stoppedTurn = false; // a turn the user stopped: its late frames must not reopen rows until the next prompt
      this.lastReapAt = 0; // last background-shell liveness check (throttled, see reapBackgroundShells)
      this.lastAgentReapAt = 0; // last delegation liveness check (see reapAgentTasks)
      this.agentReaping = false;
      this.reaping = false;
      this.steeringSupported = false; // _session/steering advertised at initialize (OpenCode 2.3+, see steer())
      this.resumeUntil = 0; // OpenCode may resume the session on its own after a background task (see onUpdate)
      this.lastFrameAt = 0; // last progress of the running turn: frames/cards; feeds the stalled-turn watchdog (watchStall)
      this.stallCancelAt = 0; // when the stalled turn was cancelled; 0 = not cancelled (see watchStall)
      this.resumeTurn = null; // { uuid, started, lastAt, costBefore, epoch, timer } while that turn is running
      this.awaitingResume = false; // a background end opened the resume window and no continuation has come yet
      this.autoSeq = 0;
      // Does this OpenCode build accept `_session/steering`? Only what `initialize` advertised
      // (`result._meta.steering.supported`) counts: an older build stays exactly as it is (no button, never a frame).
      this.steeringSupported = false;
    }

    get engineName() {
      return 'OpenCode';
    }

    // ---------- public ----------

    prompt(text, attachments = [], extra = {}) {
      // the routes answer 409 first and the queue waits for status.rewinding: this is the last guard
      if (this.rewinding) throw Object.assign(new Error(REWINDING_MESSAGE), { status: 409 });
      if (this.hub.settingsFor(this.id).modePendingChoice) {
        throw Object.assign(new Error(MODE_CHOICE_MESSAGE), { status: 409, code: 'mode-choice' });
      }
      this.pointsCache = null; // a new prompt joins the rewind list
      this.dropPlanCard(); // a new prompt instead of an answer: the plan card is stale
      this.hub.clearInterrupted(this.id);
      const uuid = randomUUID();
      const { queueChatId, ...fields } = extra ?? {};
      // A prompt queued at the global turn limit already has its bubble: fill that one in, never a second one.
      const queued = typeof queueChatId === 'string' ? this.hub.rt(this.id).chat.findLast((m) => m.id === queueChatId) : null;
      let chatId;
      if (queued) {
        chatId = queued.id;
        this.hub.updateChat(this.id, chatId, {
          queued: false,
          queuePosition: null,
          uuid,
          ...(fields.autoEffort && { autoEffort: fields.autoEffort }),
          ...(fields.autoModel && { autoModel: fields.autoModel }),
        });
      } else {
        chatId = this.hub.chat(this.id, { kind: 'user', text, source: 'web', attachments: attachments.length ? attachmentChips(attachments) : undefined, queued: this.busy || undefined, uuid, ...fields });
      }
      if (!this.m.opencode) {
        this.hub.updateChat(this.id, chatId, { queued: false, cancelled: true });
        this.hub.chat(this.id, { kind: 'error', text: 'OpenCode tidak ditemukan. Pasang dengan `npm i -g @opencode/cli`, atau set env OPENCODE_BIN.' });
        return { chatId };
      }
      this.syncSettings();
      if (!this.ensureChild()) {
        this.hub.updateChat(this.id, chatId, { queued: false, cancelled: true });
        return { chatId };
      }
      // The context-bridge note rides with this one prompt; the bubble still shows only what the user typed.
      const handoff = this.takeHandoffContext();
      const context = this.shellContext.splice(0).join('\n');
      const body = [handoff ? `[KONTEKS SESI — INFORMASI, BUKAN PERMINTAAN BARU]\n${handoff}\n[/KONTEKS SESI]` : '', context, text].filter(Boolean).join('\n\n');
      const item = { chatId, text, files: attachments.length, state: this.busy ? 'queued' : 'started', announced: false, blocks: promptBlocks(body, attachments, this.project.path) };
      this.inflight.set(uuid, item);
      clearTimeout(this.idleTimer);
      if (item.state === 'started') this.runTurn(uuid, item);
      this.afterProgress();
      return { chatId };
    }

    /** One prompt = one ACP turn; the next queued prompt starts when this one ends. */
    runTurn(uuid, item) {
      item.state = 'started';
      this.hub.updateChat(this.id, item.chatId, { queued: false });
      this.announce(item);
      this.rejectedThisTurn = false;
      this.rejection = null;
      this.stoppedTurn = false; // a new turn runs: a delegation's late frames pass the gate again
      if (this.adapter) this.adapter.lastText = '';
      const epoch = this.epoch;
      const started = Date.now();
      const costBefore = this.cost;
      // The stalled-turn watchdog (watchStall) judges progress from the last frame, not from the start: a slow but
      // live turn (heavy build) keeps sending frames and is never cut off; only total silence trips it.
      item.startedAt = started;
      item.costBefore = costBefore;
      item.epoch = epoch;
      this.lastFrameAt = started;
      // One retry: a provider that refuses the effort level (fallBackEffort) must not cost the user their turn.
      const send = () =>
        this.ready
          .then(() => this.rpc('session/prompt', { sessionId: this.acpSessionId, prompt: item.blocks }, 0))
          .then(
            (res) => this.endTurn(epoch, uuid, { ok: res?.stopReason !== 'cancelled' && res?.stopReason !== 'refusal', interrupted: res?.stopReason === 'cancelled', error: res?.stopReason === 'refusal' ? 'Model menolak permintaan ini.' : '', usage: res?.usage, started, costBefore }),
            async (err) => {
              // After a rejected permission OpenCode cancels the turn; a parallel request it still had open then
              // fails the whole prompt with PermissionNotFoundError: that is a stop, not a crash.
              let stopped = this.interrupting || this.rejectedThisTurn || /PermissionNotFound/i.test(`${err.data?.errorName ?? ''} ${err.message}`);
              // A refused effort level gets the turn one more try on Default: the provider failed the request before
              // running it, so re-sending the same prompt is safe (it may read twice in the session's own history —
              // a duplicate line beats losing the turn). A ■ Stop during the effort switch still wins, and then the
              // switch is NOT announced as a retry.
              const refused = !stopped && !item.effortRetried && this.effortRejected(err) ? await this.fallBackEffort() : null;
              if (refused) {
                stopped = this.interrupting || this.stoppedTurn;
                if (!stopped) {
                  // Only the first refusal for a model is news: after that the level is remembered and silently
                  // replaced by Default, so a chat never fills with the same provider quirk.
                  if (refused.first)
                    this.hub.chat(this.id, { kind: 'info', level: 'warning', text: `Provider menolak effort «${refused.level}» untuk model ini — giliran dicoba ulang dengan Default, dan level itu tidak dikirim lagi ke provider ini.` });
                  item.effortRetried = true;
                  send();
                  return;
                }
              }
              // A trailing tool_calls chunk after the finish reason (upstream #56455) fails the whole turn — a
              // provider stream quirk rather than a bad request, so re-sending once is worth it. Community reports
              // note it can recur for the same context, hence exactly one retry and an honest note.
              if (!stopped && !item.lateChunkRetried && LATE_STREAM_CHUNK_RE.test(`${err.data?.errorName ?? ''} ${err.message}`)) {
                item.lateChunkRetried = true;
                this.hub.chat(this.id, { kind: 'info', level: 'warning', text: 'Provider mengirim penutup stream yang tidak lazim — giliran dicoba ulang sekali (bug parser OpenCode #56455).' });
                send();
                return;
              }
              this.endTurn(epoch, uuid, { ok: false, interrupted: stopped, error: lateStreamChunkNote(await this.authErrorNote(err)), started, costBefore });
            },
          );
      send();
    }

    endTurn(epoch, uuid, { ok, interrupted, error, usage = {}, started, costBefore }) {
      if (epoch !== this.epoch || !this.translator) return; // the process was let go meanwhile (its queue is cleared)
      if (!this.inflight.has(uuid)) return; // already closed (e.g. the stalled-turn watchdog): never finish a turn twice
      const costUsd = Number.isFinite(this.cost) ? Math.max(0, this.cost - (Number.isFinite(costBefore) ? costBefore : 0)) : null;
      const stopNote = this.shuttingDown ? 'Server dihentikan — giliran terputus' : 'Dihentikan oleh kamu';
      const msg = { durationMs: Date.now() - started, usage: usage ?? {}, costUsd };
      // ✕ Tolak ended the turn (not ■ Stop): continued below with the rejection note, like Claude Code does.
      const rejection = this.rejection && !this.interrupting && !this.shuttingDown ? this.rejection : null;
      this.rejection = null;
      const stopped = (interrupted || this.interrupting) && !rejection;
      // A turn the user stopped reads "Dihentikan", like Claude's interrupted turns.
      const stillWorking = this.adapter.finish({ ...msg, ok: ok || Boolean(rejection), interrupted: stopped, error: stopped ? stopNote : error || 'OpenCode gagal menyelesaikan giliran.' });
      const agentsRunning = [...(this.translator?.bgTasks?.values() ?? [])].some((t) => t.source === 'acp' && t.kind === 'agent' && t.status === 'running');
      if (!stopped && (stillWorking || agentsRunning)) this.expectResume(); // OpenCode resumes this session when the child/background work ends
      if (!stopped) this.adapter.armOpenChildren((callId) => this.agentTaskRunning(callId)); // late child steps still open: close them if their report never comes
      this.recordTurnUsage(usage ?? {}, costUsd);
      this.interrupting = false;
      this.stallCancelAt = 0;
      this.inflight.delete(uuid);
      this.pointsCache = null;
      const next = [...this.inflight.entries()].find(([, i]) => i.state === 'queued');
      if (next) this.runTurn(next[0], next[1]);
      this.afterProgress();
      if (rejection && !next) {
        this.hub.chat(this.id, { kind: 'info', text: '✕ Izin ditolak: OpenCode menghentikan gilirannya, jadi dilanjutkan dengan catatan penolakan (seperti Claude Code).' });
        // after this turn has fully let go (busy cleared), so the note starts now instead of waiting in the queue
        setTimeout(() => {
          if (epoch !== this.epoch || this.shuttingDown) return;
          if (overCapacity(this.hub)) {
            this.hub.chat(this.id, { kind: 'info', level: 'warning', text: '⏸ Batas giliran bersamaan tercapai — catatan penolakan tidak dikirim otomatis. Kirim pesan lagi setelah satu giliran selesai.' });
            return;
          }
          this.prompt(rejectedPrompt(rejection.label, rejection.reason));
        }, 0);
      }
      // 📋 Rencana dulu: OpenCode's plan agent has no "exit plan" tool, so the finished plan turn gets the
      // approval card Claude's ExitPlanMode shows (not when more prompts are already waiting).
      if (ok && !stopped && !next && !this.shuttingDown && this.hub.settingsFor(this.id).mode === 'plan') this.offerPlan(this.adapter.lastText);
    }

    // ---------- 📋 plan card ----------

    /** The plan approval card for the turn's last answer (the plan); replaces an older card still open. */
    offerPlan(text) {
      const plan = String(text ?? '').trim();
      if (!plan) return;
      this.dropPlanCard();
      const id = `acp-plan-${this.id}-${randomUUID()}`;
      const input = { plan };
      const role = inferRole('ExitPlanMode', input, { projectPath: this.project.path });
      const label = describeTool('ExitPlanMode', input);
      const chatId = this.hub.chat(this.id, { kind: 'approval', role, text: label, approvalId: id, status: 'pending' });
      this.planCard = id;
      // The office gathers (and waits) before the card is broadcast: never after it, or an instant answer races it.
      this.hub.office(this.id, { kind: 'huddle', role: 'pm', roles: ['pm', 'architect'], label: 'Rencana siap, minta persetujuan' });
      this.hub.office(this.id, { kind: 'ask', role, label, ask: 'plan' });
      this.hub.requestApproval(
        this.id,
        { id, chatId, role, kind: 'plan', tool: 'ExitPlanMode', label, description: '', input: previewInput('ExitPlanMode', input), canAlways: false },
        (decision) => this.onPlanDecision(id, role, decision, plan),
      );
    }

    /**
     * Lanjut build = re-classify Model/Effort Auto on the approved plan, leave the plan agent, then
     * PLAN_APPROVED_PROMPT. Minta revisi with a note = that note as the next prompt, still in plan. Selesai =
     * cancelled: keep the plan, send nothing.
     */
    async onPlanDecision(id, role, decision, plan = '') {
      if (this.planCard === id) this.planCard = null;
      this.hub.office(this.id, { kind: 'ask_done', role, allowed: Boolean(decision.allow) });
      if (decision.cancelled) return;
      if (decision.allow) {
        // The web route checked the budget before resolving; a phone notification answers directly, so check here.
        if (!decision.autoPrepared) {
          const stop = budgetStop(this.m.hub, this.m.ledger, Date.now(), this.id);
          if (stop && !consumeBudgetOverride(this.m.hub)) {
            this.hub.chat(this.id, { kind: 'info', level: 'warning', text: stop.message });
            return;
          }
        }
        // Defence in depth for a decision that arrives outside the web route (the concurrency limit still applies).
        const gate = checkTurn(this.hub, this.id, this);
        if (gate) {
          this.hub.chat(this.id, { kind: 'info', level: 'warning', text: gate.body.error });
          if (plan) this.offerPlan(plan); // keep the card, so the build is not lost
          return;
        }
        // The web route already classified this plan (preparedAuto); a phone notification answers directly, so only
        // then does this path classify. Never both: that would cost two classifier calls and print two info lines.
        let auto = decision.preparedAuto ?? null;
        if (!decision.autoPrepared) {
          try {
            auto = await this.m.preparePlanTurn(this.id, plan, 'build');
          } catch {
            // A classifier/apply failure must never block the approved build: keep the old model/effort.
          }
        }
        const mode = 'build';
        this.hub.updateSettings(this.id, { mode, modeChosen: true });
        this.prompt(PLAN_APPROVED_PROMPT, [], autoExtra(auto)); // syncSettings switches the agent (or the process) before it is sent
      } else if (decision.message?.trim()) {
        // A revision is a new prompt to the plan agent: classify it too, so the bubble carries the same Auto tags.
        const stop = budgetStop(this.m.hub, this.m.ledger, Date.now(), this.id);
        if (stop && !consumeBudgetOverride(this.m.hub)) {
          this.hub.chat(this.id, { kind: 'info', level: 'warning', text: stop.message });
          return;
        }
        const gate = checkTurn(this.hub, this.id, this);
        if (gate) {
          this.hub.chat(this.id, { kind: 'info', level: 'warning', text: gate.body.error });
          if (plan) this.offerPlan(plan);
          return;
        }
        const note = `Revisi rencananya: ${decision.message.trim()}`;
        let auto = null;
        try {
          auto = await this.m.preparePlanTurn(this.id, note, 'revisi');
        } catch {
          // Same as build: a classifier failure leaves the old model/effort and never blocks the revision.
        }
        this.prompt(note, [], autoExtra(auto));
      }
    }

    dropPlanCard() {
      const id = this.planCard;
      this.planCard = null;
      if (id) this.hub.resolveApproval(id, { allow: false, cancelled: true });
    }

    /**
     * ↪ Redirect the turn that is running right now (OpenCode 2.3+ `_session/steering`, announced at initialize as
     * `_meta.steering.supported`). Verified against `opencode acp` 2.3.0 on this machine: the method is
     * `_session/steering`, `prompt` must be an ARRAY of content blocks (a plain string is refused with
     * `-32602 Expected array`), and a session with no running turn answers
     * `{ outcome: 'promptRequired', reason: 'noRunningTurn' }` — so it is only worth sending mid-turn.
     * Steering is an EXTRA path, never a replacement: anything sent while busy still joins the queue. A prompt that
     * is steered is dropped from that queue (`chatId`), so it does not run a second time after this turn.
     * Never throws: the caller (a route) turns the reason into a message.
     * @param {string} text the instruction to inject into the running turn
     * @param {{ chatId?: string }} [context] the queued bubble this steer replaces, when it came from one
     * @returns {Promise<{ ok: boolean, reason?: string, steered?: boolean }>}
     */
    async steer(text, { chatId } = {}) {
      const instruction = String(text ?? '').trim().slice(0, STEER_MAX);
      if (!instruction) return { ok: false, reason: 'empty' };
      if (!this.child || !this.acpSessionId) return { ok: false, reason: 'no-turn' };
      if (!this.steeringSupported) return { ok: false, reason: 'unsupported' };
      if (!this.busy) return { ok: false, reason: 'no-turn' }; // do not send a frame the server will refuse anyway
      try {
        const res = await this.rpc(STEER_METHOD, { sessionId: this.acpSessionId, prompt: [{ type: 'text', text: instruction }] });
        if (res?.outcome === 'promptRequired' || res?.reason === 'noRunningTurn') return { ok: false, reason: 'no-turn' };
        const steered = typeof chatId === 'string' && chatId ? this.dropQueuedPrompt(chatId) : false;
        return { ok: true, ...(steered ? { steered: true } : {}) };
      } catch (err) {
        return { ok: false, reason: String(err?.message ?? 'gagal').slice(0, 120) };
      }
    }

    /**
     * A prompt that was steered into the running turn leaves this session's queue: it must never run again as its
     * own turn (the instruction is already inside the running one). Its bubble says "diarahkan", not "dibatalkan".
     */
    dropQueuedPrompt(chatId) {
      for (const [uuid, item] of this.inflight) {
        if (item.chatId !== chatId || item.state === 'started') continue;
        this.inflight.delete(uuid);
        this.hub.updateChat(this.id, chatId, { queued: false, steered: true, queuePosition: null });
        this.afterProgress();
        return true;
      }
      return false;
    }

    /** Esc: queued prompts are dropped, the running turn is cancelled (session/cancel), killed if it won't stop. */
    stop() {
      for (const [uuid, item] of this.inflight) {
        if (item.state === 'started') continue;
        this.inflight.delete(uuid);
        this.hub.updateChat(this.id, item.chatId, { queued: false, cancelled: true });
      }
      this.hub.cancelApprovals(this.id);
      // session/cancel ends the whole turn, subagents included (OpenCode runs them inside the turn)
      if (this.child && (this.busy || [...this.inflight.values()].some((i) => i.state === 'started'))) {
        this.interrupting = true;
        this.stoppedTurn = true; // the cancelled turn is over: its frames must not reopen a row before the next prompt
        this.notify('session/cancel', { sessionId: this.acpSessionId });
        clearTimeout(this.killTimer);
        this.killTimer = setTimeout(() => this.busy && this.kill(), INTERRUPT_GRACE_MS);
      }
      // ■ Stop also ends this project's shells still running in the background (as it does for Claude Code)
      for (const id of this.translator?.runningTaskIds?.() ?? []) if (String(id).startsWith('oc:')) this.stopTask(id).catch(() => {});
      this.stopAgentTasks(); // delegations/subagents: no task may spin after its turn was cancelled
      this.resumeUntil = 0; // a stopped turn drops the pending-continuation watch too
      this.awaitingResume = false;
      if (this.resumeTurn) this.finishResumeTurn({ interrupted: true }).catch(() => {}); // the continuation OpenCode started: ended too
      this.afterProgress();
    }

    beginShutdown() {
      this.shuttingDown = true;
      this.hub.interruptTurn(this.id, 'shutdown');
      this.hub.cancelApprovals(this.id);
      this.interrupting = true;
      this.notify('session/cancel', { sessionId: this.acpSessionId });
    }

    /**
     * The base closes the process when the account or settings changed. A delegation/shell still working must
     * survive that: the restart waits until the last background task ends (applyPendingRestart).
     */
    becameIdle() {
      this.interrupting = false;
      clearTimeout(this.killTimer);
      if ((this.staleAccount || this.restartPending) && this.translator?.hasRunningTasks?.()) {
        clearTimeout(this.idleTimer);
        return;
      }
      super.becameIdle();
    }
    /** The last background task ended: apply a restart that was deferred for it (if any). */
    applyPendingRestart() {
      if (!this.restartPending || this.busy) return;
      const running = Boolean(this.translator?.hasRunningTasks?.());
      // A task that never reports keeps `hasRunningTasks()` true forever. Remember since when the restart waits (some
      // requests come from the base session's account/settings hooks and never stamp it) and, past the wait limit,
      // the restart wins: staying on the old model/mode forever is worse than closing a ghost task.
      if (running) this.restartPendingAt ||= Date.now();
      const overdue = running && this.restartPendingAt > 0 && Date.now() - this.restartPendingAt >= RESTART_MAX_WAIT_MS;
      if (running && !overdue) return;
      if (overdue) {
        this.hub.chat(this.id, { kind: 'info', level: 'warning', text: 'Perubahan model/mode diterapkan setelah tugas latar terlalu lama tidak melapor. Tugas itu ditutup; jalankan ulang kalau masih perlu.' });
        this.translator?.closeAcpTasks?.();
      }
      this.restartPending = false;
      this.restartPendingAt = 0;
      this.closeChild();
    }

    /**
     * The stop line for a provider error. Only "Authentication required" needs the extra context (and the provider
     * lookup): every other error passes through untouched. The lookup is bounded and never throws, so a failure to
     * read the provider list cannot delay or lose the turn's closing line.
     */
    async authErrorNote(err) {
      const message = String(err?.message ?? '');
      if (!/authentication required/i.test(message)) return authRequiredNote(message);
      const status = Number(err?.data?.statusCode ?? err?.httpStatus) || null;
      // The model that was actually sent (applied) — falling back to the requested one while a switch is pending.
      const model = String(this.applied?.model || this.hub.settingsFor?.(this.id)?.model || '');
      const provider = model.includes('/') ? model.slice(0, model.indexOf('/')) : '';
      const connected = provider ? await this.providerCredentials(provider) : null;
      return authRequiredNote(message, { provider: provider || null, connected, status });
    }

    /** Does the model's provider hold a credential, per OpenCode? true / false / null (unknown). Bounded, no throw. */
    async providerCredentials(provider) {
      const bin = this.m?.opencode;
      if (!bin || !provider) return null;
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), AUTH_LOOKUP_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        const { openCodeProviders } = await import('./opencode-auth.js');
        const view = await Promise.race([openCodeProviders(bin), timeout]);
        if (!view) return null;
        if ((view.connected ?? []).some((p) => p.id === provider)) return true;
        if ((view.available ?? []).some((p) => p.id === provider)) return false;
        return null; // OpenCode does not know this id: no claim either way
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    /** Model and plan/build switch in the running process; another permission mode needs a fresh one. */
    syncSettings() {
      if (!this.child || !this.applied) return;
      const s = this.hub.settingsFor(this.id);
      const a = this.applied;
      if (processKey(s) !== processKey(a)) {
        const enteringPlan = s.mode === 'plan' && a.mode !== 'plan';
        if (enteringPlan) this.autoApprove = false; // "allow all" from Build must never carry into Plan
        // Remember when the change was first deferred: a task that never reports must not hold it forever.
        if ((this.busy || this.translator?.hasRunningTasks?.()) && !this.restartPending) this.restartPendingAt = Date.now();
        if (this.busy) {
          this.restartPending = true;
          if (enteringPlan) this.hub.chat(this.id, { kind: 'info', text: 'Mode Plan berlaku setelah giliran ini selesai.' });
        } else if (this.translator?.hasRunningTasks?.()) {
          // A delegated subagent/background shell is still working: changing the model/mode must not kill it.
          // The restart is applied on the next prompt (or when the background turn ends).
          if (!this.restartPending) this.hub.chat(this.id, { kind: 'info', text: 'Model/mode baru berlaku setelah tugas latar selesai.' });
          this.restartPending = true;
        } else this.closeChild();
        return;
      }
      if (agentMode(s) !== agentMode(a)) {
        a.mode = s.mode;
        a.agent = s.agent;
        // chained into `ready`: the next session/prompt waits for the switch (an approved plan must reach build)
        const switched = this.ready.then(() => this.setOption('mode', agentMode(s)).catch((err) => this.controlFailed('mode', err)));
        switched.catch(() => {}); // a failed start is handled where `ready` was made
        this.ready = switched;
      } else Object.assign(a, { mode: s.mode, agent: s.agent });
      if (s.model !== a.model) {
        a.model = s.model;
        a.effort = s.effort;
        // a model has its own effort levels: the chosen effort is applied again after the switch, and BOTH are
        // chained into `ready` so the next session/prompt waits for them (a prompt sent while the model is still
        // switching hangs on a real provider, e.g. Auto → kimi-k3.1-pro).
        if (s.model)
          this.ready = this.ready.then(async () => {
            try {
              await this.setOption('model', s.model);
              await this.applyEffort(s.effort);
            } catch (err) {
              this.controlFailed('model', err);
            }
          });
        else if (!this.busy) this.closeChild(); // back to OpenCode's own default: a fresh session picks it
      } else if (s.effort !== a.effort) {
        a.effort = s.effort;
        // Chain it into `ready`: the next session/prompt must wait for the effort switch, not race it.
        this.ready = this.ready.then(() => this.applyEffort(s.effort)).catch((err) => this.controlFailed('effort', err));
      }
    }

    /** 🕘 Riwayat sesi lists Claude Code transcripts: only OpenCode's own sessions (ses_…) can continue here. */
    resume(sessionId, history) {
      if (!String(sessionId).startsWith('ses_')) throw Object.assign(new Error('Sesi ini milik Claude. Pilih model Claude untuk melanjutkannya.'), { status: 409 });
      super.resume(sessionId, history);
    }

    // ---------- shells of a turn (src/opencode-shells.js): live output, stuck detector, ⧗ Pindah ke latar ----------

    /** Every 15 s while a bash call has run 8 s+: finds it among the service's running shells and links it. */
    watchShells() {
      if (this.shellTimer) return;
      const ms = Math.max(50, Number(process.env.OFFICE_SHELL_WATCH_MS) || 15_000); // test hook (300 in tests); ≥50 ms so 0/negative cannot spin
      this.shellTimer = setInterval(() => {
        this.syncAcpShellActivity(); // the output files of this session's own shells feed the stuck chip
        this.linkShells().catch(() => {});
        this.reapBackgroundShells().catch(() => {});
        this.reapAgentTasks().catch(() => {});
        this.watchResume();
        this.watchStall();
        // A restart deferred for a task that never reports must still land (RESTART_MAX_WAIT_MS), even when the
        // reapers above return early: this is the only timer that keeps running while the session is idle.
        if (this.restartPending) this.applyPendingRestart();
      }, ms);
      this.shellTimer.unref?.();
    }

    /**
     * OpenCode sends no "background shell finished" event and its service cannot see an ACP session's shells. Once a
     * background shell is old enough, its process tree is the judge: gone → completed (and the user is told, once).
     * An unreadable process list leaves the task alone — a failed lookup must never close running work.
     */
    async reapBackgroundShells() {
      const t = this.translator;
      if (!t || this.reaping) return;
      const now = Date.now();
      if (now - (this.lastReapAt ?? 0) < SHELL_LIVENESS_MS) return;
      const due = [...t.bgTasks.values()].filter((x) => x.source === 'acp' && x.kind === 'shell' && x.status === 'running' && x.background && now - (Number(x.startedAt) || 0) >= SHELL_GRACE_MS);
      if (!due.length) return;
      const pid = this.child?.pid;
      if (!pid) return;
      this.reaping = true;
      this.lastReapAt = now;
      try {
        const { listShellProcesses, pidLiveness, shellLiveness } = await import('./opencode-shells.js');
        const list = await listShellProcesses().catch(() => []);
        for (const task of due) {
          if (task.status !== 'running') continue; // closed meanwhile (turn end, user stop)
          // A real OpenCode background shell prints its PID; its process is a child of OpenCode's service, so the
          // ACP-ancestry rule cannot judge it. Without a PID, keep the old rule (older fakes, service shells).
          const alive = task.pid ? pidLiveness(task.pid, task.command ?? task.description, list) : shellLiveness(task.command ?? task.description, pid, list);
          if (alive !== 'done') continue;
          this.translator.handle({ type: 'system', subtype: 'task_updated', task_id: task.id, patch: { status: 'completed' } });
        }
      } finally {
        this.reaping = false;
        this.applyPendingRestart(); // a deferred model/mode/account restart can happen once the shells are gone
      }
    }

    /**
     * ACP delegations (subagents) outlive the parent turn as child sessions. Their ⧗ task stays running while the
     * child is busy; `session.list` says when it is idle, and only then (plus a quiet window) is it done. The
     * parent's own resume closes it first in the usual path (beginResumeTurn), so this is the fallback.
     */
    async reapAgentTasks() {
      const t = this.translator;
      if (!t || this.agentReaping) return;
      const now = Date.now();
      if (now - (this.lastAgentReapAt ?? 0) < SHELL_LIVENESS_MS) return;
      const running = [...t.bgTasks.values()].filter((x) => x.source === 'acp' && x.kind === 'agent' && x.status === 'running');
      if (!running.length) return;
      this.lastAgentReapAt = now;
      this.agentReaping = true;
      try {
        let sessions = null;
        try {
          const { openCodeApi } = await import('./opencode-auth.js');
          const list = await openCodeApi(this.m.opencode, 'session.list', { timeout: 15_000 });
          sessions = new Map((Array.isArray(list) ? list : []).map((s) => [s.id, s]));
        } catch {
          // Cannot ask the service: the age rule below still applies, everything else waits for the parent's resume.
          sessions = null;
        }
        for (const task of running) {
          if (task.status !== 'running') continue;
          const info = this.adapter?.agents.get(String(task.toolUseId));
          const endless = now - (Number(task.startedAt) || now) > AGENT_MAX_MS;
          // An endless task is a leftover no matter what the service says (its frame never came): close it.
          if (endless) {
            this.closeAgentTask(task);
            continue;
          }
          // No adapter record and no service answer: nothing to judge by — never guess a task is dead.
          if (!info || !sessions) continue;
          const rec = info.sessionId ? sessions.get(info.sessionId) : null;
          // A running child has time.busy newer than time.idle; an idle one has time.idle >= time.busy.
          const idle = rec ? (Number(rec.time?.idle) || 0) >= (Number(rec.time?.busy) || 0) : false;
          const quiet = now - (info.lastAt ?? 0);
          if ((rec && idle && quiet >= AGENT_QUIET_MS) || (!rec && quiet >= Math.max(AGENT_QUIET_MS, 60_000))) {
            this.closeAgentTask(task);
          }
        }
      } finally {
        this.agentReaping = false;
        this.applyPendingRestart(); // no delegation left: a model/mode/account restart can happen now
      }
    }

    /** ⏳ While a turn runs: the provider's refusals OpenCode is retrying (rate limits), once per attempt. */
    async checkRetries() {
      const id = this.openCodeSessionId();
      if (!id || !this.busy || this.retryLookup) return;
      this.retryLookup = true;
      try {
        const { openCodeApi } = await import('./opencode-auth.js');
        const { retryNote } = await import('./opencode-mirror.js');
        const list = await openCodeApi(this.m.opencode, 'session.message.list', { params: { sessionID: id, limit: '3', order: 'desc' }, timeout: 15_000 });
        this.retriesSeen ??= new Set();
        for (const m of Array.isArray(list) ? list : []) {
          const note = m?.type === 'assistant' ? retryNote(m.retry) : null;
          const key = `${m?.id}:${m?.retry?.attempt}`;
          if (!note || this.retriesSeen.has(key)) continue;
          this.retriesSeen.add(key);
          if (this.retriesSeen.size > 200) this.retriesSeen.clear();
          this.hub.chat(this.id, { kind: 'info', text: note });
          this.hub.office(this.id, { kind: 'say', role: 'claude', text: 'Provider membatasi, OpenCode mencoba lagi…' });
        }
      } finally {
        this.retryLookup = false;
      }
    }

    async linkShells() {
      this.checkRetries().catch(() => {});
      const t = this.translator;
      const waiting = t?.unlinkedShells?.().filter((s) => Date.now() - s.startedAt >= 8000) ?? [];
      // looked at while a turn runs, a bash call waits for its shell, or a shell of ours may still be running
      // (only the service's own tasks — an acp shell's task lives on its tool call, not in the service list)
      const tracking = t?.runningTaskIds?.().some((id) => String(id).startsWith('oc:') && t.bgTasks.get(id)?.source !== 'acp');
      if ((!waiting.length && !this.busy && !tracking) || !this.m.opencode || this.shellLookup) return;
      this.shellLookup = true;
      try {
        const { matchShell, runningShells } = await import('./opencode-shells.js');
        const shells = await runningShells(this.m.opencode, this.project.path);
        const taken = new Set([...t.linkedTaskIds()].map((id) => String(id).replace(/^oc:/, '')));
        for (const s of waiting) {
          const sh = matchShell(shells, s.command, taken);
          if (!sh) continue;
          taken.add(sh.id);
          t.linkShellTask(s.toolUseId, `oc:${sh.id}`);
        }
        // ⧗ Tugas latar: only shells linked to one of this session's bash calls (now or earlier). The service also
        // runs the shells of OpenCode sessions opened in a terminal in the same folder: never shown, read or stopped.
        const byTask = new Map([...t.tools.entries()].filter(([, i]) => i.taskId).map(([id, i]) => [i.taskId, id]));
        const ours = shells.filter((sh) => byTask.has(`oc:${sh.id}`) || t.bgTasks.has(`oc:${sh.id}`));
        t.syncShellTasks(ours.map((sh) => ({ id: `oc:${sh.id}`, command: sh.command, startedAt: sh.time?.started, toolUseId: byTask.get(`oc:${sh.id}`) ?? null })));
      } finally {
        this.shellLookup = false;
      }
    }

    /**
     * Live state of this session's own shell tasks (source 'acp'): OpenCode writes each one's output to
     * <data>/opencode/shell/<project.id>/<sh_id>.out — its mtime moves the task's "no output for 3 min" stuck chip.
     */
    syncAcpShellActivity() {
      import('./opencode-shells.js').then(({ shellFileMtime }) => {
        const t = this.translator;
        if (!t || !t.bgTasks.size) return;
        let changed = false;
        for (const task of t.bgTasks.values()) {
          if (task.source !== 'acp' || task.kind !== 'shell' || task.status !== 'running') continue;
          const mtime = shellFileMtime(String(task.id).replace(/^oc:/, ''));
          if (mtime != null && Math.abs((task.lastActivityAt ?? 0) - mtime) > 1500) {
            task.lastActivityAt = mtime;
            changed = true;
          }
        }
        if (changed) t.emitBgTasks();
      }).catch(() => {});
    }

    /** The shell of a task id from the browser: only one of this session's own (linked to its bash call). */
    async ownShell(taskId) {
      const { OC_TASK } = await import('./opencode-shells.js');
      const m = OC_TASK.exec(String(taskId));
      const t = this.translator;
      const own = m && t && (t.bgTasks.has(taskId) || t.linkedTaskIds().has(taskId));
      if (!own) throw Object.assign(new Error('Tugas tidak ditemukan.'), { status: 404 });
      return m[1];
    }

    /** ⧗ detail for this session's own tasks: an ACP delegation reads its child's steps (no Claude transcript). */
    taskDetail(task) {
      if (task?.source !== 'acp' || task.kind !== 'agent') return null;
      const info = this.adapter?.agents.get(String(task.toolUseId ?? ''));
      return {
        taskId: task.id,
        kind: 'agent',
        status: task.status ?? null,
        found: Boolean(info),
        agentType: info?.agent ?? task.agent ?? null,
        prompt: null,
        steps: (info?.steps ?? []).map((s) => ({ ...s })),
        truncated: false,
        result: info?.lastText || null,
        note: 'Langkah lengkap ada di chat.',
      };
    }

    async taskOutput(taskId) {      const id = String(taskId);
      const task = this.translator?.bgTasks.get(id);
      // This session's own shell (ACP-hosted): the service cannot see it — the output is read from its file.
      if (task?.source === 'acp') {
        const { shellFileTail } = await import('./opencode-shells.js');
        const tail = shellFileTail(id.replace(/^oc:/, ''));
        if (!tail) return { output: '(belum ada output)', truncated: false };
        task.lastActivityAt = Math.max(task.lastActivityAt ?? 0, tail.mtimeMs); // the file feeds the stuck chip
        return { output: tail.output, truncated: tail.truncated };
      }
      const shell = await this.ownShell(taskId);
      const { shellOutput } = await import('./opencode-shells.js');
      return shellOutput(this.m.opencode, this.project.path, shell);
    }

    async stopTask(taskId) {
      const task = this.translator?.bgTasks.get(String(taskId));
      // This session's own shell (ACP-hosted): `shell.remove` cannot reach it — a guarded kill instead.
      if (task?.source === 'acp') return this.stopAcpShell(task);
      const shell = await this.ownShell(taskId);
      const { stopShell } = await import('./opencode-shells.js');
      await stopShell(this.m.opencode, this.project.path, shell);
      return { ok: true };
    }

    /**
     * Stops one of this session's own shells by finding its process: only a process whose command line carries the
     * exact command text AND whose ancestry reaches this session's ACP child is killed. Anything ambiguous fails
     * closed (409, nothing killed) — a user's own look-alike process is never touched.
     */
    async stopAcpShell(task) {
      const { listShellProcesses, matchShellProcess, processByPid } = await import('./opencode-shells.js');
      const { killTree } = await import('./proc.js');
      const list = await listShellProcesses();
      // A real background shell carries the PID OpenCode printed: verify it is still the process running this
      // command (or its parent), else fall back to the ancestry rule. Ambiguous → nothing is killed.
      const known = task.pid ? processByPid(task.pid, task.command ?? '', list) : null;
      const pid = known?.pid ?? matchShellProcess(task.command ?? '', this.child?.pid, list);
      if (!pid) throw Object.assign(new Error('Proses shell tidak ditemukan secara unik (mungkin sudah selesai, atau perintah yang sama berjalan di tempat lain). Tidak ada yang dihentikan.'), { status: 409 });
      killTree(pid);
      recordAudit(this.m.hub?.dataDir, { action: 'opencode-shell-kill', detail: `${task.id} pid ${pid} · ${truncate(task.command ?? '', 120)}` });
      // A background shell's tool call already returned: nothing will close the task — this stop is the end.
      if (!(task.toolUseId && this.translator.tools.has(task.toolUseId))) {
        Object.assign(task, { status: 'killed', endedAt: Date.now() });
        this.translator.emitBgTasks();
      }
      return { ok: true, pid };
    }

    /** ⧗ Pindah ke latar (Ctrl+B): OpenCode's session.background; the turn goes on, the shell keeps running. */
    async backgroundTasks() {
      const id = this.openCodeSessionId();
      if (!id) throw Object.assign(new Error('Belum ada sesi OpenCode.'), { status: 409 });
      const { backgroundSession } = await import('./opencode-shells.js');
      await backgroundSession(this.m.opencode, id);
      return { ok: true };
    }

    /** /rename and the session bar title: OpenCode's session.update. */
    async rename(title) {
      const id = this.hub.sessionIdFor(this.id);
      if (!id) throw Object.assign(new Error('Belum ada sesi. Kirim pesan dulu.'), { status: 409 });
      const { renameOpenCodeSession } = await import('./session-admin.js');
      const clean = await renameOpenCodeSession({ opencode: this.m.opencode, projectPath: this.project.path, sessionId: id, title });
      this.hub.setStatus(this.id, { title: clean });
      return { title: clean };
    }

    // ---------- ⏪ rewind (Esc Esc): OpenCode's session.revert, see src/session-admin.js ----------

    /** The OpenCode session of this project, or null (none yet / a Claude id). */
    openCodeSessionId() {
      const id = this.hub.sessionIdFor(this.id);
      return this.m.opencode && OPENCODE_SESSION.test(String(id ?? '')) ? id : null;
    }

    /**
     * The session's prompts, newest first (`uuid` = OpenCode's message id `msg_…`), without empty ones. Kept for
     * POINTS_CACHE_MS (a read-only phone reopening the list must not start `opencode` every time); a prompt, a turn's
     * end or a rewind drops it.
     */
    async rewindPoints() {
      const sessionId = this.openCodeSessionId();
      if (!sessionId) return [];
      const c = this.pointsCache;
      const points = c?.sessionId === sessionId && Date.now() - c.at < POINTS_CACHE_MS ? c.points : await this.rewindPointsFull(sessionId);
      this.pointsCache = { sessionId, at: c?.points === points ? c.at : Date.now(), points };
      return points.filter((p) => p.text.trim()).map((p) => ({ ...p, text: truncate(p.text, 400) }));
    }

    /** Dry run: the files a rewind to just before this prompt would put back. OpenCode has no "code only". */
    async rewindPreview(uuid) {
      const sessionId = this.openCodeSessionId();
      if (!sessionId) throw Object.assign(new Error('Belum ada sesi OpenCode.'), { status: 409 });
      const { openCodeRevertPlan, rewindDeadline } = await import('./session-admin.js');
      const plan = await openCodeRevertPlan({ opencode: this.m.opencode, sessionId, messageId: String(uuid), budget: rewindDeadline() });
      return {
        canRewind: true,
        filesChanged: plan.files,
        filesUnknown: !plan.found, // older than the scanned messages: OpenCode still puts its files back
        codeOnly: false,
        note: 'OpenCode: pesan ini dan semua sesudahnya dihapus dari sesi OpenCode. Dengan “Kode & percakapan”, file yang diubah OpenCode sejak pesan ini dikembalikan dari snapshot-nya (perubahanmu sendiri di file itu ikut tertimpa).',
      };
    }

    /**
     * Back to just before one of your prompts: the conversation (OpenCode deletes that prompt and everything after
     * it), with or without the file changes since (its snapshots). Refused (409) while a turn runs or is queued, or
     * another rewind runs; while it runs, prompts, `!` shell and the queue wait (`rewinding`, see prompt()).
     * Everything within one deadline (src/session-admin.js rewindDeadline).
     */
    async rewind(uuid, { code = false, conversation = false } = {}) {
      if (!code && !conversation) throw Object.assign(new Error('Pilih kode, percakapan, atau keduanya.'), { status: 400 });
      if (!conversation) throw Object.assign(new Error('OpenCode tidak bisa mengembalikan kode saja. Pilih “Kode & percakapan” atau “Percakapan saja”.'), { status: 400 });
      if (this.rewinding) throw Object.assign(new Error('Rewind lain sedang berjalan. Tunggu sampai selesai.'), { status: 409 });
      const busy = () => this.turnActive() || this.inflight.size > 0;
      if (busy()) throw Object.assign(new Error('Hentikan dulu pekerjaan yang sedang berjalan (Esc).'), { status: 409 });
      const { revertOpenCodeSession, rewindDeadline, validMessageId } = await import('./session-admin.js');
      if (!validMessageId(uuid)) throw Object.assign(new Error('Pesan tidak dikenal.'), { status: 400 });
      if (this.rewinding) throw Object.assign(new Error('Rewind lain sedang berjalan. Tunggu sampai selesai.'), { status: 409 }); // came in during the import
      if (busy()) throw Object.assign(new Error('Hentikan dulu pekerjaan yang sedang berjalan (Esc).'), { status: 409 });
      this.setRewinding(true); // from here on no prompt can slip in between the checks and the revert
      this.dropPlanCard(); // its Setujui would send a prompt into the rewind
      try {
        const budget = rewindDeadline();
        const sessionId = this.openCodeSessionId();
        const points = sessionId ? await this.rewindPointsFull(sessionId, budget) : [];
        const point = points.find((p) => p.uuid === uuid);
        if (!point) throw Object.assign(new Error('Pesan itu tidak ada di percakapan ini.'), { status: 400 });
        const chatId = this.chatEntryFor(points, uuid); // before the revert: the chat still matches OpenCode's list
        // The ACP process holds the old conversation: the next prompt starts a fresh one that loads the shortened session.
        this.closeChild();
        const { files } = await revertOpenCodeSession({ opencode: this.m.opencode, projectPath: this.project.path, sessionId, messageId: uuid, files: code, budget });
        this.hub.clearInterrupted(this.id); // a cut-short turn after this point is gone
        this.shellContext = [];
        this.hub.setStatus(this.id, { todos: null, context: null, tasks: null });
        const text = (chatId && this.hub.markRewound(this.id, null, null, chatId)) ?? point.text;
        const what = code ? `Kode & percakapan${files.length ? ` (${files.length} file)` : ''}` : 'Percakapan';
        this.hub.chat(this.id, { kind: 'divider', text: `⏪ ${what} dikembalikan ke sebelum: “${truncate(text, 60)}”` });
        return { ok: true, text, filesRestored: files };
      } finally {
        this.pointsCache = null;
        this.setRewinding(false);
      }
    }

    /** `rewinding` on the session and in the status (the 📋 queue doesn't dispatch while it is set). */
    setRewinding(on) {
      this.rewinding = on;
      this.hub.setStatus(this.id, { rewinding: on });
    }

    /**
     * The chat entry of one of OpenCode's prompts. OpenCode's ids are not known when a prompt is sent (ACP returns
     * none), so: the same place counted from the newest, among the chat prompts that reached OpenCode (not
     * cancelled, not rewound before), if OpenCode's text contains it (OpenCode keeps `!` output and text attachments
     * around the prompt); else the nearest entry that fits. null = none fits (nothing is greyed out).
     */
    chatEntryFor(points, uuid) {
      const k = points.findIndex((p) => p.uuid === uuid);
      const want = String(points[k]?.text ?? '');
      const prompts = this.hub.rt(this.id).chat.filter((m) => m.kind === 'user' && !m.rewound && !m.cancelled).reverse();
      const fits = (m) => Boolean(m?.text?.trim()) && want.includes(m.text.trim());
      if (fits(prompts[k])) return prompts[k].id;
      let best = null;
      prompts.forEach((m, i) => {
        if (fits(m) && (!best || Math.abs(i - k) < Math.abs(best.i - k))) best = { i, id: m.id };
      });
      return best?.id ?? null;
    }

    /** The prompts with their full text (matching the chat entry needs more than the list's 400 characters). */
    async rewindPointsFull(sessionId, budget) {
      const { openCodeRewindPoints } = await import('./session-admin.js');
      return openCodeRewindPoints({ opencode: this.m.opencode, sessionId, budget });
    }

    /** /mcp: configured servers + their live state from OpenCode's service (src/opencode-mcp.js). */
    async mcpStatus() {
      const { openCodeMcpStatus } = await import('./opencode-mcp.js');
      return openCodeMcpStatus(this.m.opencode, this.project.path);
    }

    /** ↻ / ▶ / ⏸ / 🔑 login / pasted callback, through OpenCode's service. */
    async mcpAction(name, action, callbackUrl) {
      const { openCodeMcpAction } = await import('./opencode-mcp.js');
      return openCodeMcpAction(this.m.opencode, this.project.path, name, action, callbackUrl);
    }

    refreshContext() {} // usage_update keeps the context meter current

    // ---------- process ----------

    /**
     * ▶ The statusline's "Mulai ulang" after the process died on its own: start it again with the same session and no
     * prompt (the handshake clears status.openCodeDown; a failure writes its own chat row). False = no binary.
     */
    startEngine() {
      if (this.m.stopping || this.shuttingDown) return false;
      return this.ensureChild();
    }

    spawn(settings) {
      const bin = this.m.opencode;
      if (!bin) return false;
      let child;
      try {
        child = spawn(bin.command, [...bin.args, 'acp'], {
          cwd: this.project.path,
          windowsHide: true,
          env: childEnv({
            ...childOpenCodeEnv(process.env),
            OFFICE_MANAGED: '1',
            OPENCODE_DISABLE_AUTOUPDATE: '1',
            // Per-process config: the user's ~/.config/opencode stays untouched.
            // The user's own rules are merged in (a deny stays a deny): see permissionConfig.
            OPENCODE_CONFIG_CONTENT: openCodeConfigContent(settings, readUserPermission(this.project.path)),
            // Mode tim: the roles as subagents + the Lead's prompt, from a file (17 prompts pass Windows' 32 KB env limit).
            ...(settings.team && Object.keys(this.m.agents).length ? { OPENCODE_CONFIG: this.m.openCodeTeamConfig() } : {}),
          }),
        });
      } catch (err) {
        this.hub.chat(this.id, { kind: 'error', text: `Gagal menjalankan OpenCode: ${err.message}` });
        this.hub.setStatus(this.id, { openCodeDown: true, openCodeExit: null });
        return false;
      }
      this.child = child;
      this.applied = { mode: settings.mode, agent: settings.agent, model: settings.model, effort: settings.effort, team: settings.team };
      this.stderr = '';
      this.cost = null;
      this.translator = new StreamTranslator({
        office: (evt) => this.hub.office(this.id, evt),
        chat: (msg) => this.hub.chat(this.id, msg),
        updateChat: (chatId, patch) => this.hub.updateChat(this.id, chatId, patch),
        status: (patch) => this.hub.setStatus(this.id, patch),
        resume: () => this.expectResume(), // OpenCode may continue the session after a background task (see onUpdate)
        gitPushed: () => this.hub.ciWatch?.(this.id),
      }, { projectPath: this.project.path });
      this.adapter = new AcpAdapter((msg) => this.translator.handle(msg));
      this.spawnedAt = Date.now();
      this.watchShells();

      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          this.onRpc(msg, child);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
      });
      child.stdin.on('error', () => {});
      child.on('error', (err) => this.hub.chat(this.id, { kind: 'error', text: `Gagal menjalankan OpenCode: ${err.message}` }));
      child.on('exit', (code) => this.onExit(child, code));
      this.handshaking = true;
      this.ready = this.handshake(settings).catch((err) => {
        if (child !== this.child) throw err;
        // Cold start: the first `opencode` call may still be bringing up its background service. One fresh
        // process, same queue (nothing was sent yet), before telling the user.
        if (!this.startRetried) {
          this.startRetried = true;
          this.child = null; // not detach(): the queued prompts and approvals stay
          child.removeAllListeners('exit');
          this.killTree(child.pid);
          this.spawn(settings);
          return this.ready;
        }
        this.hub.chat(this.id, { kind: 'error', text: `OpenCode gagal dimulai: ${err.message}${this.stderrTail()}` });
        this.hub.setStatus(this.id, { openCodeDown: true, openCodeExit: null });
        throw err;
      });
      this.ready
        .then(() => {
          this.startRetried = false;
          this.handshaking = false;
          // The engine answers again: ⚠ "OpenCode berhenti" (statusline) goes away.
          if (child === this.child) this.hub.setStatus(this.id, { openCodeDown: false, openCodeExit: null });
        })
        .catch(() => child === this.child && this.closeChild());
      this.updateStatus();
      return true;
    }

    /**
     * Continues an existing conversation. `session/resume` is preferred: OpenCode 2.3.0 advertises it under
     * `agentCapabilities.sessionCapabilities.resume` and it does NOT replay the saved messages (probe 2026-11-19,
     * docs: "session/load replays the saved messages; session/resume and session/fork don't replay them"). The app
     * keeps its own chat on disk, so replayed updates were pure overhead — they had to be swallowed by `loading`.
     * `session/load` stays as the fallback for a build that lacks `resume`.
     * @returns the handshake result, or null when the conversation is gone (deleted elsewhere): start a new one.
     */
    async reopen(sessionId, cwd, init) {
      const caps = init?.agentCapabilities?.sessionCapabilities ?? {};
      const replay = !('resume' in caps);
      if (replay) this.loading = true; // session/load replays the old conversation as updates: the chat already has it
      try {
        const method = replay ? 'session/load' : 'session/resume';
        return (await this.rpc(method, { sessionId, cwd, mcpServers: [] }, HANDSHAKE_TIMEOUT_MS)) ?? {};
      } catch {
        return null; // gone (deleted, other machine), or the method was refused: start a new one
      } finally {
        this.loading = false;
      }
    }

    /** initialize, then continue the project's session (session/resume) or start one, then model + mode. */
    async handshake(settings) {
      const init = await this.rpc('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES }, HANDSHAKE_TIMEOUT_MS);
      // OpenCode 2.3+ advertises `_meta.steering.supported`: a running turn can be redirected (see steer()).
      // Older builds omit it, and then the affordance stays off — never send a frame the server does not know.
      this.steeringSupported = init?._meta?.steering?.supported === true;
      const cwd = this.project.path;
      const known = this.hub.sessionIdFor(this.id);
      let res = null;
      if (known?.startsWith('ses_')) {
        res = await this.reopen(known, cwd, init);
        if (res) this.acpSessionId = known;
      }
      if (!res) {
        res = await this.rpc('session/new', { cwd, mcpServers: [] }, HANDSHAKE_TIMEOUT_MS);
        this.acpSessionId = res.sessionId;
        this.hub.setSessionId(this.id, res.sessionId);
      }
      let options = res.configOptions ?? [];
      const has = (id, value) => options.some((o) => o.id === id && (o.options ?? []).some((v) => v.value === value));
      if (settings.model && has('model', settings.model)) options = (await this.setOption('model', settings.model)) ?? options;
      // a custom agent that is gone (renamed in opencode.json): back to build, never an error at every start
      const agent = has('mode', agentMode(settings)) ? agentMode(settings) : agentMode({ mode: settings.mode });
      if (has('mode', agent)) options = (await this.setOption('mode', agent)) ?? options;
      this.configOptions = options;
      this.publishAgents();
      await this.applyEffort(settings.effort); // '' = OpenCode's default level, same as a later change back to Default
      const model = options.find((o) => o.id === 'model')?.currentValue ?? null;
      // ↪ steering: the UI offers "arahkan sekarang" only when this build can do it (see steer()).
      this.hub.setStatus(this.id, { activeModel: model, steering: Boolean(this.steeringSupported) });
    }

    /** Apply Auto's model/effort now; `ready` is chained, so the next prompt waits for both switches. */
    async applyAutoSettings() {
      if (!this.child || !this.applied) return;
      this.syncSettings();
      await this.ready.catch(() => {});
    }

    async setOption(configId, value) {
      const res = await this.rpc('session/set_config_option', { sessionId: this.acpSessionId, configId, value }, RPC_TIMEOUT_MS);
      // Another model may well accept what this one refused (effort levels differ per model): forget the refusals.
      if (configId === 'model') {
        this.badEfforts.clear();
        this.hub.setStatus(this.id, { activeModel: value });
      }
      if (res?.configOptions) this.configOptions = res.configOptions;
      else if (configId === 'model') this.configOptions = null; // the new model's effort levels are unknown: none sent
      this.publishAgents();
      return res?.configOptions ?? null;
    }

    /** OpenCode's primary agents (the `mode` option: build, plan and the user's own) for the Agent picker. */
    publishAgents() {
      const opt = (this.configOptions ?? []).find((o) => o.id === 'mode');
      if (!opt) return;
      const agents = (opt.options ?? []).filter((o) => typeof o.value === 'string' && /^[\w.-]{1,60}$/.test(o.value)).map((o) => ({ value: o.value, name: String(o.name ?? o.value).slice(0, 60), description: String(o.description ?? '').slice(0, 200) }));
      this.hub.setStatus(this.id, { agents, activeAgent: opt.currentValue ?? null });
    }

    /** The effort value OpenCode currently has set (what a provider would have refused), or null. */
    currentEffort() {
      const current = (this.configOptions ?? []).find((o) => o.id === 'effort')?.currentValue;
      return typeof current === 'string' && current ? current : null;
    }

    /** The model the effort levels belong to ("provider/model"): the one the app picked, else OpenCode's own. */
    effortModel() {
      const current = (this.configOptions ?? []).find((o) => o.id === 'model')?.currentValue;
      return String(this.applied?.model || current || '');
    }

    /** Refused levels for this model: what this process saw (fast) plus what the data folder remembers (a restart). */
    refusedEfforts() {
      const refused = new Set(this.badEfforts);
      for (const level of refusalsFor(this.m.hub?.dataDir, this.effortModel())) refused.add(level);
      return refused;
    }

    /** What to use instead of a level the provider refused: OpenCode's Default (the model's own thinking level). */
    safeEffort(bad) {
      const safe = effortValue('', this.configOptions, this.refusedEfforts());
      return safe && safe !== bad ? safe : null;
    }

    /** A prompt the provider refused over its reasoning-effort value (river AI: "supports reasoning effort low…"). */
    effortRejected(err) {
      return /reasoning[\s_-]?effort/i.test(`${err?.data?.errorName ?? ''} ${err?.message ?? ''}`);
    }

    /**
     * The provider refused the level OpenCode offered (river AI rejects "medium" while OpenCode advertises it). Remember
     * it — in this process and in the data folder, so a restart does not send it again — and drop to Default: the
     * caller re-sends the prompt, so the turn is never lost to a cryptic error. The caller also announces the switch
     * (only on the first refusal for a model: after that it is known and noise), because only it knows whether the
     * retry actually still runs.
     * @returns {Promise<{level: string, first: boolean}|null>} the refused level + whether it is the first one for this
     * model; null when the switch did not work (only then is a retry worth it)
     */
    async fallBackEffort() {
      const bad = this.currentEffort();
      const first = this.refusedEfforts().size === 0;
      const safe = bad ? this.safeEffort(bad) : null;
      if (!safe) return null;
      this.badEfforts.add(bad);
      rememberEffortRefusal(this.m.hub?.dataDir, this.effortModel(), bad);
      try {
        await this.setOption('effort', safe);
      } catch {
        return null; // the switch itself failed: a retry would only send the refused level again
      }
      return { level: bad, first };
    }

    /** The app's effort on the current model (skipped when the model has no effort levels, or already has it). */
    async applyEffort(effort) {
      // A level this provider already refused is never sent again: Default (or nothing) instead. Auto effort lands
      // here too, so a classifier pick that is known to fail costs no failed request.
      const value = effortValue(effort, this.configOptions, this.refusedEfforts());
      const current = (this.configOptions ?? []).find((o) => o.id === 'effort')?.currentValue;
      if (value && value !== current) await this.setOption('effort', value);
    }

    stderrTail() {
      const tail = this.stderr.trim().split('\n').slice(-4).join('\n');
      return tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : '';
    }

    detach() {
      this.epoch++;
      if (this.resumeTurn) {
        clearInterval(this.resumeTurn.timer);
        this.resumeTurn = null;
      }
      this.resumeUntil = 0;
      this.awaitingResume = false;
      this.stallCancelAt = 0;
      for (const p of this.rpcPending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('OpenCode berhenti.'));
      }
      this.rpcPending.clear();
      this.acpSessionId = null;
      this.ready = null;
      return super.detach();
    }

    closeChild() {
      const busy = this.busy;
      this.adapter?.clearSettles?.(); // the adapter exists only after the process spawned
      this.adapter?.closeChildRows?.(null, 'Ditutup bersama proses OpenCode.');
      this.translator?.closeAcpTasks?.(); // its shells die with the process: no task may keep spinning
      const child = this.detach();
      if (!child) return;
      if (busy) this.killTree(child.pid);
      else {
        child.stdin.end();
        // `opencode acp` may keep its server alive after stdin closes: make sure it goes.
        setTimeout(() => child.exitCode === null && this.killTree(child.pid), 3000).unref?.();
      }
      this.updateStatus();
    }

    onExit(child, code) {
      if (child !== this.child) return;
      this.adapter?.closeChildRows?.(null, 'Proses OpenCode berhenti.');
      this.translator?.closeAcpTasks?.(); // a crashed/killed process takes its shells with it
      if (this.handshaking && !this.startRetried) {
        // Died while starting (cold start): fail the handshake only; its retry keeps the queue (spawn above).
        for (const [id, p] of this.rpcPending) {
          clearTimeout(p.timer);
          this.rpcPending.delete(id);
          p.reject(new Error(`OpenCode berhenti saat mulai (exit ${code ?? '?'}).`));
        }
        return;
      }
      const wasBusy = this.busy;
      // Died on its own (not Stop, not the app closing): the statusline offers ▶ Mulai ulang. A deliberate close
      // (closeChild) detaches first, so it never reaches this point.
      const crashed = !this.interrupting && !this.m.stopping && !this.shuttingDown;
      if (this.turnActive() && !this.interrupting && !this.m.stopping) this.hub.interruptTurn(this.id, 'exit', { announced: true });
      this.detach();
      if (wasBusy) {
        this.hub.chat(this.id, { kind: 'error', text: `OpenCode berhenti (exit ${code ?? '?'}).${this.stderrTail()}` });
        this.hub.office(this.id, { kind: 'error', role: 'claude', label: 'Proses berhenti' });
      }
      this.updateStatus(); // busy/queue first, so the ⚠ frame below carries the settled status
      if (crashed) this.hub.setStatus(this.id, { openCodeDown: true, openCodeExit: Number.isInteger(code) ? code : null });
    }

    // ---------- JSON-RPC ----------

    send(obj) {
      if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
    }

    notify(method, params) {
      if (this.child) this.send({ method, params });
    }

    /** A request to OpenCode; `timeout` 0 = none (a turn may take long; the process exiting rejects it). */
    rpc(method, params, timeout = RPC_TIMEOUT_MS) {
      if (!this.child) return Promise.reject(new Error('OpenCode tidak berjalan.'));
      const id = ++this.rpcSeq;
      return new Promise((resolve, reject) => {
        const timer = timeout ? setTimeout(() => {
          this.rpcPending.delete(id);
          reject(new Error(`OpenCode tidak menjawab (${method}).`));
        }, timeout) : null;
        this.rpcPending.set(id, { resolve, reject, timer });
        this.send({ id, method, params });
      });
    }

    onRpc(msg, child) {
      if (child !== this.child) return;
      if (msg.id != null && !msg.method) {
        const p = this.rpcPending.get(msg.id);
        if (!p) return;
        this.rpcPending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? 'OpenCode menolak permintaan ini.'), { data: msg.error.data }));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === 'session/update') return this.onUpdate(msg.params?.update ?? {});
      if (msg.method === 'opencode/session/child_update') return this.onChildUpdate(msg.params ?? {});
      if (msg.method === 'session/request_permission' && msg.id != null) return this.onPermission(msg);
      if (msg.method === 'elicitation/create' && msg.id != null) return this.onElicitation(msg);
      // fs/* and terminal/* are not offered in initialize; anything else gets "method not found".
      if (msg.id != null) this.send({ id: msg.id, error: { code: -32601, message: `Tidak didukung: ${msg.method}` } });
    }

    onUpdate(u) {
      if (this.loading && u?.sessionUpdate !== 'available_commands_update') return;
      this.lastFrameAt = Date.now(); // progress: the stalled-turn watchdog (watchStall) counts from the last frame
      if (u.sessionUpdate === 'usage_update') {
        if (Number.isFinite(u.cost?.amount)) this.cost = u.cost.amount;
        if (Number.isFinite(u.used) && Number.isFinite(u.size) && u.size > 0) this.hub.setStatus(this.id, { context: { used: u.used, window: u.size, autoCompactAt: null } });
        return;
      }
      if (u.sessionUpdate === 'available_commands_update') {
        this.hub.setStatus(this.id, { commands: cleanCommands(u.availableCommands) }); // autocomplete (suggest.js)
        return;
      }
      // Only during one of our turns: a late update after a stop must not reopen it (the office would stay "busy").
      // A delegation that outlived the turn is the exception: OpenCode keeps streaming its steps and their results
      // must close the rows (1.0.27 resolves the prompt while a subagent still runs in the background). A turn the
      // user STOPPED keeps nothing: its late frames are dropped until the next prompt. OpenCode's own continuation
      // after a background task ends is the other exception (see acceptsResume): no prompt of ours started it.
      if (!this.busy && (this.stoppedTurn || !this.adapter.continues(u))) {
        if (this.stoppedTurn || !this.acceptsResume(u)) return;
        this.beginResumeTurn();
      }
      this.adapter.update(u);
      this.adapter.armSettle(u, this.busy || this.agentTaskRunningFor(u));
      if (this.resumeTurn) this.resumeTurn.lastAt = Date.now();
    }

    /**
     * OpenCode's OFFICIAL per-child-session notification (`opencode/session/child_update`), sent only because we declared
     * `opencode/child-session-updates` at initialize. `type:"update"` carries a child's own session/update; `type:"status"`
     * reports the child's lifecycle (created/running/completed/failed/interrupted). That status is the signal that closes
     * a delegation's ⧗ task WITHOUT waiting for the parent's own continuation — which upstream #55760 shows can emit
     * nothing at all. Frames from a child we cannot match to a launch are ignored (a nested delegation is not ours).
     */
    onChildUpdate(p) {
      const sid = typeof p?.childSessionId === 'string' ? p.childSessionId : null;
      const call = sid ? this.adapter?.childSessions.get(sid)?.call : null;
      if (p?.type === 'update' && p.update) {
        // Same path as a session/update that already carries the child marker; add it when OpenCode left it off.
        const u = sid && !this.adapter?.childMarker(p.update) ? { ...p.update, _meta: { ...(p.update._meta ?? {}), 'opencode/child-session': { id: sid, parentID: p.parentSessionId, depth: p.depth, ...(p.title ? { title: p.title } : {}) } } } : p.update;
        return this.onUpdate(u);
      }
      if (p?.type !== 'status' || !call) return;
      const task = this.taskForCall(call);
      if (p.status === 'created' || p.status === 'running') {
        // The child is working: keep its ⧗ task and the pending-continuation window alive (its own frames may still come).
        const info = this.adapter?.agents.get(String(call));
        if (info) info.lastAt = Date.now();
        if (task) this.expectResume({ quiet: true });
        return;
      }
      // completed / failed / interrupted: the delegation's work is over — close its task now, honestly. The official
      // status already IS the report's trigger, so do NOT expect the parent's own continuation (upstream #55760: it may
      // never come). The honesty watch is cleared with it, but the window stays open so a late parent frame is still
      // modeled as its turn rather than dropped as a foreign one.
      this.awaitingResume = false;
      if (task) this.closeAgentTask(task, { status: p.status === 'failed' ? 'failed' : p.status === 'interrupted' ? 'stopped' : 'completed', expectResume: false });
      if (!this.busy) this.resumeUntil = Date.now() + RESUME_WINDOW_MS;
    }

    /** The ⧗ task of a delegation's launch call (`callId`), or null when it is not (or no longer) registered. */
    taskForCall(callId) {
      if (!callId) return null;
      for (const t of this.translator?.bgTasks?.values() ?? []) {
        if (t.kind === 'agent' && t.toolUseId === callId) return t;
      }
      return null;
    }

    // ---------- the turn OpenCode starts by itself after a background task ----------

    /** Frames of an unsolicited continuation: agent text/tools/plan, inside the window a background finish opened. */
    acceptsResume(u) {
      if (Date.now() >= this.resumeUntil) return false;
      return ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(u?.sessionUpdate);
    }

    /** A background task ended (src/translator.js calls this sink): OpenCode may now resume the session by itself. */
    expectResume({ quiet = false } = {}) {
      // A renewal from the liveness tick must NOT restart the honesty clock below: a real continuation past a long
      // build has to arrive after the click's own quiet window, and a premature "no continuation" line would be wrong.
      if (!quiet) this.resumeExpectAt = Date.now();
      this.resumeUntil = Date.now() + RESUME_WINDOW_MS;
      this.awaitingResume = true;
    }

    /**
     * The liveness tick: while a delegation/shell of this session still runs, renew the resume window so a heavy job
     * is not cut off by the fixed window; once nothing is left to hear back from, tell the user honestly if OpenCode
     * never sent the continuation it promised (upstream #56314 leaves the parent silent after a failed resumed turn).
     */
    watchResume() {
      const t = this.translator;
      if (!t) return;
      const working = [...t.bgTasks.values()].some((x) => x.source === 'acp' && x.status === 'running');
      if (working) {
        if (!this.busy) this.expectResume({ quiet: true }); // keep the window alive for the eventual continuation
        return;
      }
      if (!this.awaitingResume || this.busy) return;
      if (Date.now() - (this.resumeExpectAt ?? 0) < RESUME_MISS_MS) return;
      this.awaitingResume = false;
      this.resumeUntil = 0;
      this.hub.chat(this.id, {
        kind: 'info',
        level: 'warning',
        text: 'OpenCode tidak melanjutkan sesi ini setelah tugas latar selesai — kemungkinan bug upstream (#56314). Kirim pesan apa pun untuk memicu ulang.',
      });
    }

    /**
     * The stalled-turn watchdog: OpenCode's `session/prompt` has no timeout of ours (see rpc: a turn may run long),
     * and upstream #26350/#26379 acknowledge a non-tool LLM failure after retries can emit NO frame at all — the
     * prompt never returns and the office would sit "busy" forever. A turn that makes no progress (no frame, no
     * permission/elicitation) for TURN_STALL_MS is first CANCELLED (session/cancel): a wedged turn must free the
     * session, and a live-but-slow one is left alone because any frame resets the clock. If the prompt still has not
     * returned a short grace later, the turn is closed here so nothing keeps spinning. A pending card counts as
     * progress: a turn waiting for the user is never cut.
     */
    watchStall() {
      const entry = [...this.inflight.entries()].find(([, i]) => i.state === 'started');
      if (!entry) {
        this.stallCancelAt = 0;
        return;
      }
      // A pending card IS progress: never close a turn that is waiting for the user.
      if ([...(this.hub.approvals?.values?.() ?? [])].some(({ approval }) => approval.project === this.id && approval.status === 'pending')) {
        this.stallCancelAt = 0;
        return;
      }
      const [uuid, item] = entry;
      const now = Date.now();
      const last = Math.max(this.lastFrameAt ?? 0, item.startedAt ?? 0);
      if (now - last < TURN_STALL_MS) {
        this.stallCancelAt = 0;
        return;
      }
      if (!this.stallCancelAt) {
        this.stallCancelAt = now;
        this.hub.chat(this.id, {
          kind: 'info',
          level: 'warning',
          text: `OpenCode belum mengirim kemajuan apa pun selama ${Math.round(TURN_STALL_MS / 60_000)} menit — giliran dibatalkan (kemungkinan bug upstream #26350). Kirim pesan lagi untuk mencoba ulang.`,
        });
        if (this.acpSessionId) this.notify('session/cancel', { sessionId: this.acpSessionId });
        return;
      }
      if (now - this.stallCancelAt < TURN_STALL_KILL_MS) return; // give the cancel a moment: its reply ends the turn normally
      this.stallCancelAt = 0;
      // The cancel was not honoured in time: close the turn ourselves so the office stops spinning. Not `interrupting`
      // (the user did not press Stop), so the result row carries this message instead of "Dihentikan oleh kamu".
      this.endTurn(item.epoch ?? this.epoch, uuid, { ok: false, interrupted: false, error: 'OpenCode tidak menjawab dan tidak mengirim kemajuan; giliran ditutup otomatis.', started: item.startedAt ?? now, costBefore: item.costBefore ?? 0 });
    }

    /** The first frame of that continuation: model it as a turn (no user bubble) so busy/queue/result stay honest. */
    beginResumeTurn() {
      if (this.resumeTurn) return;
      this.awaitingResume = false; // the continuation is here: the honesty watch below is done
      // OpenCode only resumes the parent after its delegations reported back: their tasks are done now.
      for (const task of [...(this.translator?.bgTasks?.values() ?? [])]) {
        if (task.source === 'acp' && task.kind === 'agent' && task.status === 'running') this.closeAgentTask(task);
      }
      const uuid = `auto-${++this.autoSeq}`;
      this.inflight.set(uuid, { chatId: null, text: '', state: 'started', announced: true, auto: true, blocks: [] });
      const turn = { uuid, started: Date.now(), lastAt: Date.now(), costBefore: this.cost, epoch: this.epoch, timer: null };
      turn.timer = setInterval(() => this.pollResumeTurn().catch(() => {}), RESUME_POLL_MS);
      turn.timer.unref?.();
      this.resumeTurn = turn;
      this.resumeUntil = Date.now() + RESUME_WINDOW_MS;
      this.afterProgress(); // busy: a prompt sent meanwhile waits in the queue until this turn ends
    }

    /** Is OpenCode still working on the continuation? `session.active` answers; a failed lookup never closes it fast. */
    async pollResumeTurn() {
      const turn = this.resumeTurn;
      if (!turn) return;
      const now = Date.now();
      if (turn.epoch !== this.epoch || !this.child || !this.m.opencode) return this.finishResumeTurn({ interrupted: true });
      if (now - turn.started > RESUME_MAX_MS) return this.finishResumeTurn({});
      if (now - turn.lastAt < RESUME_QUIET_MS) return;
      let active = false;
      try {
        const { openCodeApi } = await import('./opencode-auth.js');
        const list = await openCodeApi(this.m.opencode, 'session.active', { timeout: 15_000 });
        active = Boolean(list && typeof list === 'object' && Object.keys(list).includes(this.acpSessionId));
      } catch {
        active = now - turn.lastAt < 60_000; // cannot ask: keep it open for a little while, never forever
      }
      if (!active && this.resumeTurn === turn) this.finishResumeTurn({});
    }

    /** Ends the continuation turn: one result row (with its duration/cost), then the queued prompt, if any. */
    async finishResumeTurn({ interrupted = false } = {}) {
      const turn = this.resumeTurn;
      if (!turn) return;
      this.resumeTurn = null;
      clearInterval(turn.timer);
      this.resumeUntil = 0;
      this.awaitingResume = false;
      if (turn.epoch !== this.epoch) {
        this.inflight.delete(turn.uuid); // the process was let go: nothing to end in it
        this.updateStatus();
        return;
      }
      const usage = await this.resumeUsage(turn).catch(() => ({}));
      if (turn.epoch !== this.epoch) {
        this.inflight.delete(turn.uuid);
        this.updateStatus();
        return;
      }
      this.endTurn(turn.epoch, turn.uuid, { ok: !interrupted, interrupted, error: '', started: turn.started, costBefore: turn.costBefore, usage });
    }

    /** Token usage of the messages this continuation created (its cost comes from the session's cumulative counter). */
    async resumeUsage(turn) {
      if (!this.m.opencode || !this.acpSessionId) return {};
      const { openCodeApi } = await import('./opencode-auth.js');
      const list = await openCodeApi(this.m.opencode, 'session.message.list', { params: { sessionID: this.acpSessionId, limit: 10, order: 'desc' }, timeout: 15_000 });
      const fresh = (Array.isArray(list) ? list : []).filter((m) => m?.type === 'assistant' && m.tokens && (Number(m.time?.created) || 0) >= turn.started - 1000);
      const sum = (pick) => fresh.reduce((n, m) => n + (Number(pick(m)) || 0), 0);
      const usage = {
        inputTokens: sum((m) => m.tokens.input),
        outputTokens: sum((m) => m.tokens.output),
        thoughtTokens: sum((m) => m.tokens.reasoning),
        cachedReadTokens: sum((m) => m.tokens.cache?.read),
      };
      return usage.inputTokens || usage.outputTokens || usage.thoughtTokens || usage.cachedReadTokens ? usage : {};
    }

    /** Is this child frame's delegation still a running ⧗ task? Its step rows stay open (no premature "tanpa kabar"). */
    agentTaskRunningFor(u) {
      const sid = this.adapter?.childSessionId(u);
      const call = sid ? this.adapter.childSessions.get(sid)?.call : null;
      return this.agentTaskRunning(call);
    }

    /** `callId` (a delegation's launch call) has a running ⧗ task. */
    agentTaskRunning(callId) {
      if (!callId) return false;
      for (const t of this.translator?.bgTasks?.values() ?? []) {
        if (t.kind === 'agent' && t.toolUseId === callId && t.status === 'running') return true;
      }
      return false;
    }

    /** Ends one ACP delegation task: close its child rows first, then let the translator announce it. */
    closeAgentTask(task, { status = 'completed', note, expectResume } = {}) {
      if (!task || task.source !== 'acp' || task.kind !== 'agent' || task.status !== 'running') return false;
      this.adapter?.closeChildRows(task.toolUseId, note);
      this.adapter?.markAgentDone(task.toolUseId);
      this.translator.handle({ type: 'system', subtype: 'task_updated', task_id: task.id, patch: { status, ...(expectResume === false ? { expectResume: false } : {}) } });
      return true;
    }

    /** ■ Stop / shutdown: no delegation may keep spinning after its turn was cancelled. */
    stopAgentTasks() {
      const t = this.translator;
      if (!t) return;
      let changed = false;
      for (const task of t.bgTasks.values()) {
        if (task.source !== 'acp' || task.kind !== 'agent' || task.status !== 'running') continue;
        // Best effort: cancel the CHILD's own turn too. The parent's cancel may already cover it, but a subagent is
        // its own session in OpenCode, and a long build must not keep running after the user pressed ■ Stop.
        const childSid = this.adapter?.agents.get(String(task.toolUseId ?? ''))?.sessionId;
        if (childSid) this.notify('session/cancel', { sessionId: childSid });
        this.adapter?.closeChildRows(task.toolUseId, 'Dihentikan bersama giliran.');
        this.adapter?.markAgentDone(task.toolUseId);
        Object.assign(task, { status: 'stopped', endedAt: Date.now() });
        this.hub.chat(this.id, { kind: 'info', text: `⏹ Tugas latar dihentikan — ${truncate(String(task.description ?? task.id), 120)}` });
        changed = true;
      }
      if (changed) {
        t.emitBgTasks();
        t.emitWorking();
        this.applyPendingRestart(); // ■ Stop ended the background work: a deferred restart may apply now
      }
    }

    // ---------- permissions ----------

    onPermission(msg) {
      const { toolCall = {}, options = [] } = msg.params ?? {};
      const pick = (...kinds) => options.find((o) => kinds.includes(o.kind));
      const reply = (outcome) => this.send({ id: msg.id, result: { outcome } });
      const id = toolCall.toolCallId ?? `acp-perm-${msg.id}`;
      this.adapter.toolInfo(id, toolCall);
      const { name, input } = this.adapter.start(id);
      const role = this.translator.roleOf(id) ?? inferRole(name, input, { projectPath: this.project.path });
      const reject = pick('reject_once', 'reject_always');
      // Plan is read-only: a tool that needs permission (edit, shell, network) is refused here, never shown as a card.
      if (this.hub.settingsFor(this.id).mode === 'plan') return reply(reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' });
      // After a "Tolak" OpenCode cancels the turn: its other requests are stale, answering "allow" would fail it.
      if (this.rejectedThisTurn || this.interrupting) return reply(reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' });
      if (this.autoApprove && this.hub.settingsFor(this.id).mode !== 'plan') {
        const once = pick('allow_once', 'allow_always');
        if (once) return reply({ outcome: 'selected', optionId: once.optionId });
      }
      const approvalId = `acp-${this.id}-${msg.id}-${this.rpcSeq}`;
      const label = describeTool(name, input);
      const chatId = this.hub.chat(this.id, { kind: 'approval', role, text: label, approvalId, status: 'pending' });
      // Before the card is broadcast: an instant answer must never reach the office before the question does.
      this.hub.office(this.id, { kind: 'ask', role, label: truncate(label, 120), ask: 'tool' });
      this.hub.requestApproval(
        this.id,
        { id: approvalId, chatId, role, kind: 'tool', tool: name, label, description: '', input: previewInput(name, input), canAlways: Boolean(pick('allow_always')) },
        (decision) => {
          let option;
          if (decision.allow) {
            option = (decision.always && pick('allow_always')) || pick('allow_once', 'allow_always');
            if (decision.allowAll) this.autoApprove = true;
          } else {
            option = reject;
            if (!decision.cancelled) {
              this.rejectedThisTurn = true;
              this.rejection ??= { label: truncate(label, 200), reason: String(decision.message ?? '').trim().slice(0, 1000) };
              this.hub.cancelApprovals(this.id); // the turn ends: close its other cards too
            }
          }
          reply(option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' });
          this.hub.office(this.id, { kind: 'ask_done', role, allowed: Boolean(decision.allow) });
          this.updateStatus();
        },
      );
    }

    /**
     * `elicitation/create` (form): OpenCode's `question` tool asking the user. Shown as the same question card as
     * Claude's AskUserQuestion; Kirim jawaban → accept + content, Lewati → decline, Stop/closed → cancel.
     * Never auto-answered by "Izinkan semua" (that is for tools only, as with Claude).
     */
    onElicitation(msg) {
      const p = msg.params ?? {};
      const reply = (result) => this.send({ id: msg.id, result });
      const fields = (p.mode ?? 'form') === 'form' ? elicitationFields(p.requestedSchema) : [];
      if (!fields.length) return reply({ action: 'decline' }); // a URL elicitation (never offered) or an empty form
      if (this.rejectedThisTurn || this.interrupting) return reply({ action: 'cancel' });
      const input = { questions: fields.map(({ question, header, options, multiSelect }) => ({ question, header, multiSelect, options: options.map(({ label, description }) => ({ label, description })) })) };
      const toolId = typeof p.toolCallId === 'string' ? p.toolCallId : null;
      const role = (toolId && this.translator?.roleOf(toolId)) || inferRole('AskUserQuestion', input, { projectPath: this.project.path });
      const label = describeTool('AskUserQuestion', input);
      const message = str(p.message, 300);
      const approvalId = `acp-ask-${this.id}-${randomUUID()}`;
      const chatId = this.hub.chat(this.id, { kind: 'approval', role, text: label, approvalId, status: 'pending' });
      // The office reacts BEFORE its card is broadcast: requestApproval sends the card at once, and a client that
      // answers instantly would otherwise see "ask_done" (and the card) before "ask" — the room never waits.
      this.hub.office(this.id, { kind: 'ask', role, label: truncate(label, 120), ask: 'question' });
      this.hub.requestApproval(
        this.id,
        // OpenCode's question tool titles every form "Questions": the first question says more
        { id: approvalId, chatId, role, kind: 'question', tool: 'AskUserQuestion', label, description: message && message !== 'Questions' ? message : '', input: previewInput('AskUserQuestion', input), canAlways: false },
        (decision) => {
          if (decision.allow) reply({ action: 'accept', content: elicitationContent(fields, decision.answers) });
          else reply({ action: decision.cancelled ? 'cancel' : 'decline' });
          this.hub.office(this.id, { kind: 'ask_done', role, allowed: Boolean(decision.allow) });
          this.updateStatus();
        },
      );
    }

    // ---------- usage ----------

    recordTurnUsage(usage, costUsd) {
      if (!this.m.ledger) return;
      const input = usage.inputTokens ?? 0;
      const output = (usage.outputTokens ?? 0) + (usage.thoughtTokens ?? 0);
      const cacheRead = usage.cachedReadTokens ?? 0;
      if (!input && !output && !cacheRead) return;
      this.m.ledger.record({
        account: OPENCODE_ACCOUNT,
        engine: 'opencode',
        source: 'web',
        project: this.project,
        sessionId: this.hub.sessionIdFor(this.id),
        agent: agentMode(this.applied ?? this.hub.settingsFor(this.id)),
        model: this.hub.settingsFor(this.id).model || this.hub.statusFor?.(this.id)?.activeModel || 'opencode',
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        costUsd,
        turns: 1,
      });
    }
  };
}
