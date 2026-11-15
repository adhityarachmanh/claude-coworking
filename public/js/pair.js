// Pairing page (/pair), served before pairing so it stays tiny and dependency-free.
//
// Two ways in, in this order:
//   1. a PIN sent to the owner's WhatsApp — works when nobody is in front of the laptop (the PC may be sitting
//      at the Windows login screen in another room);
//   2. the 6-digit code shown on the laptop screen, kept under "Punya kode dari laptop?" as the fallback for
//      when WhatsApp is not connected yet.
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

let resendAt = 0;
let ticker = null;

function say(text, ok = false) {
  msg.textContent = text;
  msg.classList.toggle('ok', Boolean(ok));
}

/** Disables "Kirim PIN" until the server's cooldown is over, showing the seconds left. */
function startCooldown(seconds) {
  resendAt = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
  clearInterval(ticker);
  if (!resendAt) return;
  const paint = () => {
    const left = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    if (left <= 0) {
      clearInterval(ticker);
      countdown.hidden = true;
      sendBtn.disabled = false;
      sendBtn.textContent = '📲 Kirim ulang PIN';
      return;
    }
    sendBtn.disabled = true;
    countdown.hidden = false;
    countdown.textContent = `Kirim ulang dalam ${left} detik.`;
  };
  paint();
  ticker = setInterval(paint, 1000);
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
    sendBtn.disabled = false;
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
  $('pin-form').before(warn);
}

// Is WhatsApp actually connected? When it is not, the PIN button is pointless: say so and point at the laptop
// code instead of letting the owner wait for a message that will never arrive.
(async () => {
  try {
    const res = await fetch('/api/auth/pin-status');
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) {
      // Phone access is off on the laptop: no PIN can be issued, so point at the fallback instead of a dead button.
      sendBtn.disabled = true;
      $('intro').textContent = 'Akses dari HP sedang dimatikan di laptop — pakai kode 6 digit dari layar laptop di bawah, atau nyalakan aksesnya dulu.';
    } else if (res.ok && data.canRequestInSec > 0) startCooldown(data.canRequestInSec); // a reload must not skip the wait
    if (res.ok && data.configured === false) {
      sendBtn.disabled = true;
      $('intro').textContent = 'WhatsApp di laptop belum diatur — pakai kode 6 digit dari layar laptop di bawah.';
    } else if (res.ok && data.status && data.status !== 'connected') {
      sendBtn.disabled = true;
      $('intro').textContent = data.status === 'qr_ready'
        ? 'Sesi WhatsApp belum dipindai di laptop — pakai kode 6 digit dari layar laptop di bawah.'
        : 'WhatsApp di laptop sedang tidak terhubung — pakai kode 6 digit dari layar laptop di bawah.';
    }
  } catch { /* offline snapshot page: the buttons still work when the server is reachable */ }
})();
