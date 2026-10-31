// Number, date and time formatting (Indonesian locale).

export const DAY = 86_400_000;

export const fmtTokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
export const time = (ts) => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
export const shortDate = (ts) => (ts ? new Date(ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export const fmtNum = (n) => Number(n ?? 0).toLocaleString('id-ID');
export const fmtShort = (n) => new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 }).format(n ?? 0);
export const fmtUsd = (n) => (n == null ? '—' : `$${n.toFixed(2)}`);

/** "baru saja", "12 menit lalu", "3 jam lalu", else a short date. */
export function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return new Date(ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
