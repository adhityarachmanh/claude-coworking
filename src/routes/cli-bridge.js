// 🌉 CLI bridge: a terminal PreToolUse hook asks the office for a permission decision. Laptop-only, token and
// origin enforced by server.js; this route only validates the payload, finds the project, and waits for the same
// approval card a web session would show. A timeout is a fallback to the terminal prompt, never an allow.
import { randomUUID } from 'node:crypto';
import { recordAudit } from '../audit-log.js';
import { projectForCwd, sanitizeToolInput, tooLongForCard } from '../cli-bridge.js';
import { describeTool } from '../roles.js';
import { json } from './http.js';

const TOOL = /^[A-Za-z0-9_.:-]{1,100}$/;
const DEFAULT_WAIT_MS = 115_000; // the hook's own timeout is 120 s: the server answers first, never the reverse
const MAX_WAIT_MS = 115_000;
const MAX_BODY = 64 * 1024;
const MAX_CLI_PENDING = 10;
const MAX_CLI_PENDING_PER_PROJECT = 3;

export function register(router) {
  // The launcher mints the narrow CLI token here instead of scraping the office token out of index.html.
  // Laptop-only (server.js LOCAL_ONLY) and limited to asking for an approval: it cannot control the office.
  router.post('/api/cli-bridge/token', issueToken, { noToken: true });
  router.post('/api/cli-bridge/ask', ask, { maxBody: MAX_BODY, token: 'cli' });
}

function issueToken({ cliToken }, req, res) {
  if (!cliToken) return json(res, 503, { error: 'CLI bridge belum siap.' });
  return json(res, 200, { token: cliToken });
}

async function ask({ hub, dataDir, cliBridgeTimeoutMs }, req, res, params, body) {
  const tool = typeof body?.tool === 'string' ? body.tool.trim() : '';
  if (!TOOL.test(tool)) return json(res, 400, { error: 'Tool tidak valid.' });
  const project = projectForCwd(hub?.projects?.values?.() ?? [], body?.cwd);
  if (!project) return json(res, 404, { error: 'Folder kerja ini bukan project Adhitron.' });
  if (typeof hub?.requestApproval !== 'function') return json(res, 503, { error: 'Kartu izin tidak tersedia.' });

  const pendingCli = [...(hub.approvals?.values?.() ?? [])].filter((entry) => entry?.approval?.status === 'pending' && entry.approval.source === 'cli');
  const pendingHere = pendingCli.filter((entry) => entry.approval.project === project.id).length;
  if (pendingCli.length >= MAX_CLI_PENDING || pendingHere >= MAX_CLI_PENDING_PER_PROJECT) {
    return json(res, 429, { error: 'Terlalu banyak izin terminal yang menunggu jawaban.' });
  }

  // A shell command too long to show in full cannot be approved honestly: the hidden middle could hold anything.
  // Fail closed to the terminal instead of showing a head+tail preview that invites a blind "allow".
  const SHELLS = new Set(['Bash', 'PowerShell', 'pwsh', 'sh', 'shell']);
  if (SHELLS.has(tool) && tooLongForCard(body?.input)) {
    recordAudit(dataDir, { action: 'cli-approval', detail: `${tool} · ${project.name ?? project.id} · fallback (perintah terlalu panjang)` });
    return json(res, 200, { decision: 'fallback', reason: 'Perintah terlalu panjang untuk diperiksa dari aplikasi; putuskan di terminal.' });
  }

  const input = sanitizeToolInput(body?.input);
  let label = tool;
  try {
    label = describeTool(tool, input) || tool;
  } catch {
    // A tool with an unexpected shape still gets a card: its name is enough.
  }
  const id = `cli_${randomUUID()}`;
  const requested = Number(cliBridgeTimeoutMs);
  const waitMs = requested > 0 ? Math.min(requested, MAX_WAIT_MS) : DEFAULT_WAIT_MS;

  // A chat row makes the same approval card (and its notification deep-link) work for a terminal session.
  let chatId = null;
  try {
    chatId = hub.chat?.(project.id, { kind: 'approval', role: 'claude', text: label, approvalId: id, status: 'pending' }) ?? null;
  } catch {
    // Without a chat row the approval still exists; the card just cannot be deep-linked.
  }

  const decision = await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let onClose = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onClose) res.off?.('close', onClose);
      resolve(value ?? { allow: false, cancelled: true });
    };
    timer = setTimeout(() => {
      done({ allow: false, cancelled: true, timedOut: true });
      hub.resolveApproval?.(id, { allow: false, cancelled: true });
    }, waitMs);
    // The hook died or gave up: do not leave a card waiting for an answer that can never arrive.
    onClose = () => {
      if (!res.writableEnded) {
        done({ allow: false, cancelled: true, aborted: true });
        hub.resolveApproval?.(id, { allow: false, cancelled: true });
      }
    };
    res.on?.('close', onClose);
    try {
      const created = hub.requestApproval(
        project.id,
        {
          id,
          chatId,
          role: 'claude',
          kind: 'tool',
          tool,
          label,
          description: 'Dari terminal (CLI bridge)',
          input,
          canAlways: false,
          source: 'cli',
        },
        (value) => done(value),
      );
      if (created === null) done({ allow: false, cancelled: true, aborted: true });
    } catch {
      done({ allow: false, cancelled: true });
      hub.resolveApproval?.(id, { allow: false, cancelled: true });
    }
  });

  const result = decision.allow ? 'allow' : decision.timedOut ? 'timeout' : decision.aborted ? 'aborted' : 'deny';
  recordAudit(dataDir, { action: 'cli-approval', detail: `${tool} · ${project.name ?? project.id} · ${result}` });
  return json(res, 200, {
    decision: decision.timedOut || decision.aborted ? 'fallback' : decision.allow ? 'allow' : 'deny',
    reason: decision.allow
      ? 'Disetujui dari Adhitron'
      : decision.timedOut
        ? 'Tidak dijawab sebelum batas waktu; lanjutkan di terminal'
        : decision.aborted
          ? 'Hook berhenti; lanjutkan di terminal'
          : 'Ditolak dari Adhitron',
  });
}
