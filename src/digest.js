// 📅 Rekap mingguan: a plain-language summary of the last 7 days from the usage ledger. No model call, so it costs
// nothing and can be copied into a chat or a report.
import { insightSummary } from './insights.js';

const usd = (n) => `$${new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.round(n * 100) / 100)}`;
const num = (n) => new Intl.NumberFormat('id-ID').format(Math.round(n));
const hour = (h) => `${String(h).padStart(2, '0')}.00–${String(h + 1).padStart(2, '0')}.00`;

export function weeklyDigest(rows, { now = Date.now() } = {}) {
  const s = insightSummary(rows, { now, days: 7 });
  const date = new Date(now).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const lines = [
    `# Rekap 7 hari · ${date}`,
    '',
    `Biaya ${usd(s.costUsd)} · ${num(s.tokens)} token · ${num(s.requests)} permintaan · ${num(s.sessions)} sesi · ${num(s.activeProjects)} project aktif.`,
    s.busiestHour == null ? 'Belum ada aktivitas tercatat.' : `Jam tersibuk: ${hour(s.busiestHour)}.`,
    '',
  ];
  if (s.projects.length) {
    lines.push('## Project', '');
    for (const p of s.projects) lines.push(`- **${p.name}** — ${usd(p.costUsd)} · ${num(p.tokens)} token · ${num(p.requests)} permintaan`);
    lines.push('');
  }
  if (s.models.length) {
    lines.push('## Model', '');
    for (const m of s.models) lines.push(`- \`${m.model}\` — ${usd(m.costUsd)} · ${num(m.tokens)} token`);
    lines.push('');
  }
  lines.push('_Dari biaya yang tercatat di ledger; OpenCode Go berlangganan biasanya tercatat $0._');
  return { markdown: lines.join('\n'), summary: s };
}
