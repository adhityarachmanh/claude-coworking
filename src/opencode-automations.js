// ⏰ OpenCode automations (2.4, experimental): schedule a prompt or a Code Mode script for a project. The app only
// wraps the server API; OpenCode itself decides when to fire and records the outcome.
import { openCodeApi } from './opencode-auth.js';

export class AutomationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ID = /^aut_[A-Za-z0-9_-]{1,80}$/;
const SESSION = /^ses_[A-Za-z0-9_-]{1,100}$/;
const TRIGGERS = new Set(['at', 'every', 'cron', 'event']);
const ACTIONS = new Set(['prompt', 'code']);

const text = (value, field, max) => {
  if (typeof value !== 'string') throw new AutomationError(400, `${field} harus berupa teks.`);
  const clean = value.trim();
  if (!clean) throw new AutomationError(400, `${field} tidak boleh kosong.`);
  if (clean.length > max) throw new AutomationError(400, `${field} maksimal ${max} karakter.`);
  if (/[\u0000-\u001f\u007f]/.test(clean)) throw new AutomationError(400, `${field} tidak boleh memuat karakter kontrol.`);
  return clean;
};

/** `at`/`every`/`cron`/`event` as the API takes it; a timezone is optional. */
export function cleanTrigger(raw) {
  if (!raw || typeof raw !== 'object' || !TRIGGERS.has(raw.type)) throw new AutomationError(400, 'Jenis jadwal tidak dikenal.');
  const trigger = { type: raw.type };
  if (raw.type === 'at') trigger.at = text(raw.at, 'Waktu', 120);
  else if (raw.type === 'every') trigger.every = text(raw.every, 'Interval', 60);
  else if (raw.type === 'cron') trigger.cron = text(raw.cron, 'Cron', 120);
  else {
    trigger.server = text(raw.server, 'Server MCP', 100);
    trigger.event = text(raw.event, 'Event MCP', 120);
    if (raw.args !== undefined && raw.args !== null && raw.args !== '') {
      if (typeof raw.args !== 'object' || Array.isArray(raw.args)) throw new AutomationError(400, 'Args event harus objek JSON.');
      trigger.args = raw.args;
    }
  }
  if (raw.tz !== undefined && raw.tz !== null && raw.tz !== '') trigger.tz = text(raw.tz, 'Zona waktu', 60);
  return trigger;
}

/** A prompt sent to the project's session, or Code Mode JavaScript (which OpenCode authorizes once at creation). */
export function cleanAction(raw) {
  if (!raw || typeof raw !== 'object' || !ACTIONS.has(raw.type)) throw new AutomationError(400, 'Jenis aksi tidak dikenal.');
  if (raw.type === 'prompt') {
    const action = { type: 'prompt', prompt: text(raw.prompt, 'Prompt', 4000) };
    if (raw.to !== undefined && raw.to !== null) {
      if (typeof raw.to !== 'object' || Array.isArray(raw.to)) throw new AutomationError(400, 'Target aksi tidak valid.');
      if (raw.to.session !== undefined) action.to = { session: text(raw.to.session, 'Sesi', 100) };
      else if (raw.to.subagent !== undefined) action.to = { subagent: text(raw.to.subagent, 'Subagent', 60) };
    }
    return action;
  }
  const action = { type: 'code', code: text(raw.code, 'Kode Code Mode', 20_000) };
  if (raw.args !== undefined && raw.args !== null && raw.args !== '') {
    if (typeof raw.args !== 'object' || Array.isArray(raw.args)) throw new AutomationError(400, 'Args harus objek JSON.');
    action.args = raw.args;
  }
  return action;
}

const cleanId = (value) => {
  const id = String(value ?? '');
  if (!ID.test(id)) throw new AutomationError(400, 'ID automation tidak valid.');
  return id;
};

const listOf = (out) => (Array.isArray(out) ? out : Array.isArray(out?.data) ? out.data : []);

/** The dialog only needs identity, schedule, state and the last outcome — never `state` (it can hold Code Mode memory). */
export function cleanAutomation(info) {
  if (!info || typeof info !== 'object' || !ID.test(String(info.id ?? ''))) return null;
  return {
    id: info.id,
    name: typeof info.name === 'string' ? info.name.slice(0, 80) : 'Automation',
    projectID: typeof info.projectID === 'string' ? info.projectID : '',
    directory: typeof info.directory === 'string' ? info.directory : '',
    trigger: info.trigger && typeof info.trigger === 'object' ? info.trigger : null,
    action: info.action?.type === 'code' ? 'code' : 'prompt',
    status: ['active', 'paused', 'done'].includes(info.status) ? info.status : 'active',
    nextDueAt: Number.isFinite(info.nextDueAt) ? info.nextDueAt : null,
    runCount: Number.isFinite(info.runCount) ? info.runCount : 0,
    lastRunAt: Number.isFinite(info.lastRunAt) ? info.lastRunAt : null,
    lastOutcome: typeof info.lastOutcome === 'string' ? info.lastOutcome : '',
    lastOutput: typeof info.lastOutput === 'string' ? info.lastOutput.slice(0, 600) : '',
    created: Number.isFinite(info.time?.created) ? info.time.created : null,
  };
}

export async function listAutomations(bin) {
  if (!bin) throw new AutomationError(404, 'OpenCode tidak ditemukan.');
  return listOf(await openCodeApi(bin, 'experimental.automation.list', { timeout: 60_000 })).map(cleanAutomation).filter(Boolean);
}

export async function createAutomation(bin, body = {}) {
  if (!bin) throw new AutomationError(404, 'OpenCode tidak ditemukan.');
  const name = text(body.name, 'Nama', 80);
  if (body.directory !== undefined && body.directory !== null && body.directory !== '') {
    if (typeof body.directory !== 'string' || body.directory.length > 500 || /[\u0000-\u001f]/.test(body.directory)) throw new AutomationError(400, 'Folder tidak valid.');
  }
  if (body.sessionID !== undefined && body.sessionID !== null && body.sessionID !== '' && !SESSION.test(String(body.sessionID))) throw new AutomationError(400, 'ID sesi tidak valid.');
  const payload = { name, trigger: cleanTrigger(body.trigger), action: cleanAction(body.action) };
  if (body.directory) payload.directory = body.directory;
  if (body.sessionID) payload.sessionID = body.sessionID;
  if (body.expires !== undefined && body.expires !== null && body.expires !== '') payload.expires = text(body.expires, 'Kedaluwarsa', 60);
  const out = await openCodeApi(bin, 'experimental.automation.create', { body: payload, timeout: 60_000 });
  return cleanAutomation(out?.data ?? out);
}

async function actionOn(bin, operation, id) {
  if (!bin) throw new AutomationError(404, 'OpenCode tidak ditemukan.');
  const out = await openCodeApi(bin, operation, { params: { automationID: cleanId(id) }, timeout: 60_000 });
  return operation.endsWith('delete') ? { removed: true } : cleanAutomation(out?.data ?? out);
}

export const pauseAutomation = (bin, id) => actionOn(bin, 'experimental.automation.pause', id);
export const resumeAutomation = (bin, id) => actionOn(bin, 'experimental.automation.resume', id);
export const deleteAutomation = (bin, id) => actionOn(bin, 'experimental.automation.delete', id);
