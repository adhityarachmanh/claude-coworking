// Pairing page (/pair): sends the 6-digit code shown on the laptop. Served before pairing, so it stays tiny.
const form = document.getElementById('form');
const msg = document.getElementById('msg');
const btn = document.getElementById('btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  btn.disabled = true;
  msg.textContent = '';
  try {
    const res = await fetch('/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: document.getElementById('code').value }),
    });
    const data = await res.json();
    if (res.ok) return location.replace('/');
    msg.textContent = data.error + (data.triesLeft ? ` Sisa ${data.triesLeft} percobaan.` : '');
  } catch {
    msg.textContent = 'Tidak bisa menghubungi laptop. Pastikan HP di WiFi yang sama atau Tailscale menyala.';
  }
  btn.disabled = false;
});
