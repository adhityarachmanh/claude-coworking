#!/usr/bin/env node
// 🔑 `office pair`: print the current pairing snapshot so the laptop does not have to be in front of you.
// Typical flow: Tailscale SSH into the laptop from a phone, run `office pair`, open the https link on that phone.
// It only READS the one-time code (never rotates or consumes it) and mints its own narrow CLI token over loopback.

const PORT = Number(process.env.OFFICE_PORT ?? 4317);
const BASE = `http://127.0.0.1:${PORT}`;
const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
};

/** The narrow CLI token (approvals + local pairing snapshot only), same endpoint the claude wrapper uses. */
async function readToken() {
  const response = await fetch(`${BASE}/api/cli-bridge/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(4000),
    redirect: 'error',
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  const token = String(body?.token ?? '');
  return /^[0-9a-f]{32,}$/.test(token) ? token : null;
}

function mmss(ms) {
  const left = Math.max(0, Math.ceil((ms - Date.now()) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

const KIND_LABEL = { wifi: '📶', lan: '📶', tailscale: '🌐' };

async function main() {
  let health = null;
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
    health = response.ok ? await response.json().catch(() => null) : null;
  } catch {
    health = null;
  }
  if (!health?.ok) return fail(`Adhitron tidak bisa dihubungi di ${BASE}. Jalankan server dulu, lalu ulangi.`);

  const token = await readToken().catch(() => null);
  if (!token) return fail('Token CLI tidak bisa diterbitkan. Periksa versi server (butuh 1.0.26+).');

  const response = await fetch(`${BASE}/api/pairing/cli`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cli-Token': token },
    body: '{}',
    signal: AbortSignal.timeout(4000),
    redirect: 'error',
  }).catch(() => null);
  if (!response) return fail(`Server tidak menjawab di ${BASE}.`);
  if (response.status === 400) return fail('Akses dari HP belum dinyalakan. Buka ⚙ → Akses dari HP (dari laptop).');
  if (response.status === 423) {
    const body = await response.json().catch(() => ({}));
    const until = Number(body?.until) || Date.now();
    return fail(`Pasangan dijeda karena terlalu banyak kode salah. Coba lagi dalam ${mmss(until)}.`);
  }
  if (!response.ok) {
    return fail(response.status === 403 || response.status === 404
      ? 'Versi server belum mendukung `office pair`. Perbarui Adhitron dulu (⚙ → Update, atau git pull + restart).'
      : `Server membalas ${response.status}.`);
  }
  const info = await response.json().catch(() => null);
  if (!info?.code || !info?.expires) return fail('Jawaban server tidak lengkap.');

  const key = /[?&]k=([^&\s]+)/.exec(info.qrUrl ?? '')?.[1] ?? '';
  const https = info.https ? `🔒 ${info.https.qrUrl}` : null;
  const links = (info.addresses ?? []).map((a) => {
    const base = `http://${a.ip}:${PORT}`;
    return `${KIND_LABEL[a.kind] ?? '📶'} ${base}/pair?k=${key}${a.kind === 'tailscale' ? '   (kendali penuh)' : '   (hanya lihat lewat WiFi)'}`;
  });

  process.stdout.write([
    '',
    `🔑 Kode pasangan Adhitron: ${info.code.slice(0, 3)} ${info.code.slice(3)}   (berlaku ${mmss(info.expires)}, sekali pakai)`,
    '',
    'Buka di HP — link ini langsung memasangkan, tanpa mengetik kode:',
    ...(https ? [`  ${https}   ← disarankan: kendali penuh + push`] : []),
    ...links.map((line) => `  ${line}`),
    '',
    'Tanpa link: buka alamatnya di HP lalu ketik kode di atas.',
    '',
  ].join('\n'));
}

main().catch((error) => fail(`office pair gagal: ${error.message}`));
