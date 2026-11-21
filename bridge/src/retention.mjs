// bridge/src/retention.mjs — retensi terjadwal untuk Chat Web (kepatuhan UU PDP/GDPR).
// Dipanggil cron Netlify: membersihkan sesi kedaluwarsa dan membatasi umur jejak tool_run.
// Murni terhadap repo (tanpa I/O langsung), jadi bisa diuji cepat dengan repo memory.

/** Umur maksimal jejak tool_run (audit browsing) sebelum dibuang. Dicatat di kebijakan privasi. */
export const TOOL_RUN_KEEP_DAYS = 90;
export const TOOL_RUN_KEEP_MS = TOOL_RUN_KEEP_DAYS * 24 * 60 * 60 * 1000;

/**
 * Satu pass retensi: hapus sesi kedaluwarsa + tool run lebih tua dari batas.
 * Tidak pernah melempar kegagalan repo ke pemanggil cron (best-effort), tetapi mengembalikan ringkasan.
 */
export async function sweepChatRetention(repo, nowMs = Date.now()) {
  if (!repo?.deleteExpiredSessions || !repo?.deleteOldToolRuns) return { ok: false };
  const now = new Date(nowMs).toISOString();
  const toolCutoff = new Date(nowMs - TOOL_RUN_KEEP_MS).toISOString();
  await repo.deleteExpiredSessions(now);
  await repo.deleteOldToolRuns(toolCutoff);
  return { ok: true, sessionsBefore: now, toolRunsBefore: toolCutoff };
}