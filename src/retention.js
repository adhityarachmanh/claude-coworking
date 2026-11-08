// Data retention for the two things that grow without bound: chat history (both engines) and the usage ledger.
// 0 = keep forever, which is the default: nothing is ever deleted until the user picks a number of days.
//
// The saved setting lives in state.json as `persisted.retention` ({chatsDays, usageDays}). `retentionPreview()` only
// counts (no file is touched) and `applyRetention()` is the one that deletes; the server also calls it once a day.
// Rows/messages without a usable timestamp, and lines that cannot be parsed, are always kept: a cleanup must never
// turn into data loss.
import { readFileSync } from 'node:fs';

export const RETENTION_MAX_DAYS = 3650;
const DAY_MS = 86_400_000;

/** A whole number of days 0…3650 (0 = keep forever). Anything else is not a choice the app offers. */
export const isRetentionDays = (raw) => Number.isInteger(raw) && raw >= 0 && raw <= RETENTION_MAX_DAYS;

/** A stored/typed value, or 0 (keep forever) when it is not a whole number of days in range. */
export const cleanRetentionDays = (raw) => (isRetentionDays(raw) ? raw : 0);

/** The retention this hub runs with (missing/malformed fields mean "keep forever"). */
export function retentionOf(hub) {
  const stored = hub?.persisted?.retention;
  return {
    chatsDays: cleanRetentionDays(stored?.chatsDays),
    usageDays: cleanRetentionDays(stored?.usageDays),
  };
}

/**
 * Saves a retention patch (`{ chatsDays?, usageDays? }`). A present field must be an integer 0…3650, else a
 * 400-status error; an absent field keeps its stored value. No SSE broadcast: the data panel reads again.
 * @returns {{ chatsDays: number, usageDays: number }} what is stored now
 */
export function setRetention(hub, patch) {
  const next = retentionOf(hub);
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const key of ['chatsDays', 'usageDays']) {
      if (!Object.hasOwn(patch, key)) continue;
      if (!isRetentionDays(patch[key])) {
        const label = key === 'chatsDays' ? 'Retensi chat' : 'Retensi laporan pemakaian';
        throw Object.assign(new Error(`${label} harus bilangan bulat 0–${RETENTION_MAX_DAYS} hari.`), { status: 400 });
      }
      next[key] = patch[key];
    }
  }
  hub.persisted.retention = next;
  hub.save();
  return next;
}

/** Start of the deletion window; 0 = off (keep forever). */
const cutoffOf = (days, now) => (days > 0 ? now - days * DAY_MS : 0);

/** Rows older than cutoff across every ledger file, plus how many files hold at least one of them. */
function usageBefore(ledger, cutoff) {
  let rows = 0;
  let files = 0;
  for (const file of typeof ledger?.files === 'function' ? ledger.files() : []) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // unreadable right now: the other files still count
    }
    let hit = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (Number.isFinite(row?.ts) && row.ts < cutoff) hit++;
      } catch {
        // a torn/hand-edited line: kept by pruneBefore, so it is never counted as removable
      }
    }
    rows += hit;
    if (hit) files++;
  }
  return { rows, files };
}

/**
 * What applying the retention would delete, without writing anything.
 * @param {object} hub
 * @param {object} ledger UsageLedger
 * @param {number} [now]
 * @param {{ chatsDays: number, usageDays: number }} [settings] what to preview (default: the saved setting)
 * @returns {{ chats: { messages: number, projects: number }, usage: { rows: number, files: number },
 *   cutoff: { chats: number, usage: number } }}
 */
export function retentionPreview(hub, ledger, now = Date.now(), settings = retentionOf(hub)) {
  const chosen = { chatsDays: cleanRetentionDays(settings?.chatsDays), usageDays: cleanRetentionDays(settings?.usageDays) };
  const cutoff = { chats: cutoffOf(chosen.chatsDays, now), usage: cutoffOf(chosen.usageDays, now) };
  const chats = cutoff.chats ? (hub?.chatRetentionCount?.(cutoff.chats) ?? { messages: 0, projects: 0 }) : { messages: 0, projects: 0 };
  const usage = cutoff.usage ? usageBefore(ledger, cutoff.usage) : { rows: 0, files: 0 };
  return { chats, usage, cutoff };
}

/**
 * Deletes what the retention asks for. A setting of 0 means keep forever, so that half is skipped entirely.
 * @param {object} hub
 * @param {object} ledger UsageLedger
 * @param {number} [now]
 * @param {{ chatsDays: number, usageDays: number }} [settings] the half to apply (default: the saved setting)
 * @returns {{ chats: { removed: number, projects: number }, usage: { removed: number, files: number } }}
 */
export function applyRetention(hub, ledger, now = Date.now(), settings = retentionOf(hub)) {
  const chosen = { chatsDays: cleanRetentionDays(settings?.chatsDays), usageDays: cleanRetentionDays(settings?.usageDays) };
  const result = { chats: { removed: 0, projects: 0 }, usage: { removed: 0, files: 0 } };
  if (chosen.chatsDays > 0) {
    const pruned = hub?.pruneChatsBefore?.(cutoffOf(chosen.chatsDays, now)) ?? {};
    result.chats = { removed: pruned.removed ?? 0, projects: pruned.projects ?? 0 };
  }
  if (chosen.usageDays > 0 && typeof ledger?.pruneBefore === 'function') {
    const pruned = ledger.pruneBefore(cutoffOf(chosen.usageDays, now)) ?? {};
    result.usage = { removed: pruned.removed ?? 0, files: pruned.files ?? 0 };
  }
  return result;
}
