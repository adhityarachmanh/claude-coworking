// Pairing page (/pair), served before pairing so it stays tiny and dependency-free.
//
// Three ways in, in this order:
//   1. the device is already paired (a valid device cookie): say so and open the office — no PIN and no code. That is
//      the normal case on the owner's own tailnet, where a phone pairs itself with "pasang otomatis" before it ever
//      reads this page; showing a PIN form there looks like "any PIN gets in".
//   2. a PIN sent to the owner's WhatsApp — works when nobody is in front of the laptop (the PC may be sitting at the
//      Windows login screen in another room);
//   3. the 6-digit code shown on the laptop screen, kept under "Punya kode dari laptop?" as the fallback for when
//      WhatsApp is not connected yet.
//
// `/api/auth/pin-status` is polled while the page is visible: WhatsApp reconnects in the background after a restart,
// so the PIN button has to come alive by itself instead of after a reload.
const $ = (id) => document.getElementById(id);
const msg = $('msg');
const sendBtn = $('send');
const pinForm = $('pin-form');
const pinStep = $('pin-step');
const pinInput = $('pin');
const verifyBtn = $('verify');
const countdown = $('countdown');
const codeForm = $('form');
const codeInput = $('code');
const codeBtn = $('btn');
const intro = $('intro');
const pairedBox = $('paired');

/** How often the page asks whether WhatsApp can carry a PIN (only while the tab is visible). */
const POLL_MS = 3000;
const DEFAULT_INTRO = intro.textContent;

let waReady = false; // pin-status said 'ready': WhatsApp is linked and the PIN can be sent
let resendAt = 0;
let ticker = null;
let poll = null;

function say(text, ok = false) {
  msg.textContent = text;
  msg.classList.toggle('ok', Boolean(ok));
}

/** Disables "Kirim PIN" while WhatsApp cannot carry it or the server's cooldown is still running. */
function paintSend() {
  const left = resendAt ? Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)) : 0;
  sendBtn.disabled = !waReady || left > 0;
  if (resendAt) sendBtn.textContent = '📲 Kirim ulang PIN';
  if (left > 0) {
    countdown.hidden = false;
    countdown.textContent = `Kirim ulang dalam ${left} detik.`;
    if (!ticker) ticker = setInterval(paintSend, 1000);
  } else {
    countdown.hidden = true;
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }
}

/** Disables "Kirim PIN" until the server's cooldown is over, showing the seconds left. */
function startCooldown(seconds) {
  resendAt = Math.max(resendAt, Date.now() + Math.max(0, Number(seconds) || 0) * 1000);
  paintSend();
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function requestPin() {
  sendBtn.disabled = true;
  say('');
  try {
    const { res, data } = await post('/api/auth/request-pin');
    if (res.ok) {
      pinStep.hidden = false;
      pinInput.focus();
      say('PIN sudah dikirim ke WhatsApp. Masukkan 6 angkanya di sini.', true);
      startCooldown(60);
      return;
    }
    say(data.error || 'Tidak bisa mengirim PIN.');
    startCooldown(data.retryAfter || 60);
  } catch {
    say('Tidak bisa menghubungi laptop. Pastikan HP di WiFi yang sama atau Tailscale menyala.');
    paintSend();
  }
}

async function verifyPin(event) {
  event.preventDefault();
  // Native validation already blocks this, but an empty submit must never reach the server: it would spend one of
  // the three attempts of the owner's live PIN.
  const pin = pinInput.value.trim();
  if (!/^\d{6}$/.test(pin)) {
    say('Masukkan 6 angka dari pesan WhatsApp.');
    pinInput.focus();
    return;
  }
  verifyBtn.disabled = true;
  say('');
  try {
    const { res, data } = await post('/api/auth/verify-pin', { pin });
    if (res.ok) {
      say('Tersambung. Membuka Adhitron…', true);
      location.replace('/');
      return;
    }
    if (data.triesLeft) say(`${data.error || 'PIN salah.'} Sisa ${data.triesLeft} percobaan.`);
    else say(data.error || 'PIN salah atau kedaluwarsa.');
    pinInput.select();
    if (data.retryAfter) startCooldown(data.retryAfter);
  } catch {
    say('Tidak bisa menghubungi laptop. Coba lagi.');
  }
  verifyBtn.disabled = false;
}

codeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  codeBtn.disabled = true;
  say('');
  try {
    const res = await fetch('/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: codeInput.value }),
    });
    const data = await res.json();
    if (res.ok) return location.replace('/');
    say(data.error + (data.triesLeft ? ` Sisa ${data.triesLeft} percobaan.` : ''));
  } catch {
    say('Tidak bisa menghubungi laptop. Pastikan HP di WiFi yang sama atau Tailscale menyala.');
  }
  codeBtn.disabled = false;
});

sendBtn.addEventListener('click', requestPin);
// The submit happens on the FORM (the button and the input sit in #pin-form, not in #pin-step): binding it to the
// inner <div> would let the browser do a native GET /pair and reload the page with the PIN lost.
pinForm.addEventListener('submit', verifyPin);
pinInput.addEventListener('input', () => {
  pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6);
});

// Over plain http (WiFi, not the Tailscale https link) the PIN travels unencrypted, like every other request on that
// listener. The device it pairs stays read-only there, but the owner deserves to know before typing it.
if (location.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
  const warn = document.createElement('p');
  warn.className = 'hint warn';
  warn.textContent = 'Koneksi ini tidak terenkripsi (WiFi). Untuk PIN yang aman, pakai tautan Tailscale (https) dari laptop.';
  pinForm.before(warn);
}

/** A reason from the server → why the PIN button cannot be used, always naming the laptop-code fallback. */
const REASONS = {
  'wa-off': 'WhatsApp di laptop belum tertaut — minta pemilik menautkannya lewat ⚙ Setelan → WhatsApp, atau pakai kode 6 digit dari layar laptop di bawah.',
  'wa-qr': 'WhatsApp di laptop belum dipindai — minta pemilik memindai QR di ⚙ Setelan → WhatsApp, atau pakai kode 6 digit dari layar laptop di bawah.',
  'wa-connecting': 'WhatsApp di laptop sedang menyambung ulang — tombol PIN aktif sendiri sebentar lagi. Sementara itu pakai kode 6 digit dari layar laptop di bawah.',
  'not-owner-tailnet':
    'Perangkat ini bukan perangkat tailnet pemilik laptop, atau Tailscale di HP belum tersambung — karena itu perangkat ini tidak dipasangkan otomatis. Pakai kode 6 digit dari layar laptop di bawah, atau masuk dengan akun Tailscale pemilik laptop.',
  'phone-access-off': 'Akses dari HP sedang dimatikan di laptop — pakai kode 6 digit dari layar laptop di bawah, atau nyalakan aksesnya dulu.',
};

function explain(reason) {
  intro.textContent = REASONS[reason] ?? DEFAULT_INTRO;
}

/** The device already has a valid cookie: the PIN form would only suggest there is something to type. */
function showPaired() {
  pinForm.hidden = true;
  pairedBox.hidden = false;
  intro.textContent = 'Perangkat ini sudah terpasang — tidak perlu PIN atau kode.';
  countdown.hidden = true;
  say('');
  stopPoll(); // nothing more to learn: the device stays paired until it is revoked from the laptop
}

/**
 * Renders one `/api/auth/pin-status` answer. `paired` wins (the form disappears); otherwise `reason` says why the
 * button is on or off, and a cooldown the server still remembers is restored after a reload.
 * @param {number} status the HTTP status
 * @param {object} data the parsed body
 */
function applyStatus(status, data) {
  if (status === 403) {
    waReady = false;
    explain(data.reason === 'not-owner-tailnet' ? 'not-owner-tailnet' : 'phone-access-off');
    paintSend();
    return;
  }
  if (status !== 200) return; // 401/500: keep what the page already says and let the next poll try again
  if (data.paired === true) {
    showPaired();
    return;
  }
  // Older servers answered without `reason`: derive it so the page still says something useful.
  const reason =
    data.reason ??
    (data.configured === false ? 'wa-off' : data.status === 'qr_ready' ? 'wa-qr' : data.status === 'connecting' ? 'wa-connecting' : data.status === 'connected' ? 'ready' : 'wa-off');
  waReady = reason === 'ready';
  explain(reason === 'ready' ? null : reason);
  if (data.canRequestInSec > 0) startCooldown(data.canRequestInSec);
  paintSend();
}

async function refreshStatus() {
  try {
    const res = await fetch('/api/auth/pin-status', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    applyStatus(res.status, data);
  } catch {
    // Offline (or the laptop is restarting): the page keeps what it has and the next poll tries again.
  }
}

function startPoll() {
  if (poll) return;
  poll = setInterval(refreshStatus, POLL_MS);
}

function stopPoll() {
  if (!poll) return;
  clearInterval(poll);
  poll = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPoll(); // a phone in a pocket does not need to ask every 3 s
    return;
  }
  refreshStatus();
  startPoll();
});

refreshStatus();
startPoll();
