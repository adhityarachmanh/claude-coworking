// Progress of the latest turn, as pure rules (public/js/core/turn-progress.js).
//
// The chat already has every fact; the user should not have to ask "is it finished?". This turns the messages of the
// current turn into one line: duration, steps, how many run, how many lost their report, and whether the turn ended.
// "Finished" is only claimed when the server wrote its result (or the office is provably idle).

/**
 * @param {Array<{ kind?: string, ts?: number, status?: string, source?: string, ok?: boolean, meta?: object }>} messages
 * @param {{ now?: number, busy?: boolean, background?: number }} [options]
 *   busy: a turn is running; background: tasks still alive in ⧗ (they outlive the turn).
 * @returns {{ startedAt: number, durationMs: number, total: number, running: number, stale: number,
 *   finished: boolean, ok: boolean|null, cut: boolean, background: number }|null}
 */
export function turnProgress(messages = [], { now = Date.now(), busy = false, background = 0 } = {}) {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.kind === 'user') {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const startedAt = Number(messages[start].ts) || 0;
  let result = null;
  const steps = [];
  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.kind === 'result') result = m;
    if (m.kind === 'tool' || m.kind === 'delegate') steps.push(m);
  }
  const finished = Boolean(result) || !busy;
  const durationMs = Math.max(0, (finished ? Number(result?.ts) || now : now) - startedAt);
  return {
    startedAt,
    durationMs,
    total: steps.length,
    running: steps.filter((m) => m.status === 'running').length,
    stale: steps.filter((m) => m.status === 'stale').length,
    finished,
    ok: result ? result.ok !== false : null,
    cut: !result && !busy, // no result and nothing running: the turn was cut (server stop, crash, restart)
    background: Math.max(0, Number(background) || 0),
  };
}

/**
 * The one-line label: "⏳ 4 mnt 12 dtk · 9 langkah · 2 berjalan" / "✓ Selesai · …" / "■ Tidak selesai · …".
 * @param {ReturnType<typeof turnProgress>} p
 * @param {(ms: number) => string} fmtDuration
 */
export function progressLabel(p, fmtDuration = (ms) => `${Math.round(ms / 1000)} dtk`) {
  if (!p) return '';
  const dur = fmtDuration(p.durationMs);
  if (!p.finished) return `⏳ ${dur} · ${p.total} langkah${p.running ? ` · ${p.running} berjalan` : ''}`;
  if (p.cut) return `■ Tidak selesai · ${dur} · ${p.total} langkah`;
  const head = p.ok === false ? '■ Berhenti' : '✓ Selesai';
  const bits = [`${head} · ${dur}`, `${p.total} langkah`];
  if (p.stale) bits.push(`${p.stale} tidak dilaporkan`);
  if (p.background) bits.push(`${p.background} di latar`);
  return bits.join(' · ');
}
