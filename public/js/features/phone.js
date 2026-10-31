// Phone access (QR pairing), laptop only.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { ago } from '../core/format.js';
import { state } from '../core/state.js';
import { qrSvg } from '../qr.js';

export const phone = { timer: null, pairing: null, ip: null };
const ADDRESS_LABEL = { lan: '📶 WiFi yang sama', tailscale: '🌐 Dari mana saja (Tailscale)' };

// lastSeen is only stored about once an hour (server throttles disk writes), so recent use reads as "dalam 1 jam terakhir".
const lastActive = (ts) => (Date.now() - ts < 3_600_000 ? 'dalam 1 jam terakhir' : ago(ts));

function renderPhone() {
  const info = state.config?.remote ?? { enabled: false, urls: [], devices: [] };
  $('#remote-enabled').checked = info.enabled;
  const body = $('#phone-body');
  if (!info.enabled) {
    body.innerHTML = `<p class="muted">Setelah dinyalakan, scan QR dengan kamera HP untuk membuka kantor ini dari HP.</p>
      <ul class="access-modes muted small">
        <li><b>📶 WiFi yang sama: hanya lihat.</b> Pantau chat, perubahan, dan aktivitas. Koneksi WiFi tidak terenkripsi, jadi HP tidak bisa mengirim perintah, menjawab izin, atau commit.</li>
        <li><b>🌐 Tailscale: kendali penuh</b> seperti di laptop (kecuali pengaturan laptop). Koneksinya terenkripsi dan bisa dari mana saja.</li>
      </ul>
      <p class="warn">Hanya nyalakan di jaringan yang kamu percaya (rumah/kantor). Siapa pun di jaringan tetap butuh kode dari layar laptop ini untuk masuk.</p>`;
    return;
  }
  const p = phone.pairing;
  const left = p ? Math.max(0, Math.round((p.expires - Date.now()) / 1000)) : 0;
  const devices = info.devices
    .map((d) => `<li><span>${escapeHtml(d.name)}<small>dipasangkan ${new Date(d.created).toLocaleDateString('id-ID')} · terakhir aktif ${lastActive(d.lastSeen ?? d.created)}</small></span><button class="danger" data-revoke="${d.id}">Cabut</button></li>`)
    .join('');
  const viaTailscale = p?.addresses.find((a) => a.ip === p.ip)?.kind === 'tailscale';
  const chooser = p && p.addresses.length > 1
    ? `<div class="addr-tabs">${p.addresses.map((a) => `<button class="${a.ip === p.ip ? 'active' : ''}" data-ip="${a.ip}">${ADDRESS_LABEL[a.kind] ?? a.kind}<small>${a.ip}</small></button>`).join('')}</div>`
    : '';
  const tailscaleTip = info.tailscale
    ? ''
    : `<details class="tip"><summary>🌐 Mau mengirim perintah dari HP, atau buka dari luar rumah?</summary>
        <ol>
          <li>Pasang <b>Tailscale</b> (gratis) di laptop: <code>tailscale.com/download</code>, lalu login.</li>
          <li>Pasang aplikasi Tailscale di HP, login dengan akun yang sama.</li>
          <li>Buka lagi jendela ini — muncul pilihan <b>Dari mana saja (Tailscale)</b> dengan QR-nya.</li>
        </ol>
        <p class="muted small">Tailscale membuat jaringan pribadi terenkripsi antara laptop dan HP-mu. Laptop tidak terbuka ke internet publik. Lewat Tailscale HP bisa mengirim perintah; lewat WiFi biasa hanya bisa melihat.</p>
      </details>`;
  body.innerHTML = p
    ? `${chooser}<div class="pair">
        <div class="qr">${qrSvg(p.qrUrl)}</div>
        <div class="pair-info">
          <ol>
            <li>${viaTailscale ? 'Nyalakan Tailscale di HP (boleh pakai data seluler / WiFi mana saja).' : 'Sambungkan HP ke WiFi yang sama.'}</li>
            <li>Scan QR dengan kamera HP.</li>
            <li>Atau buka <code>${escapeHtml(p.url)}</code> lalu masukkan kode:</li>
          </ol>
          <div class="code">${p.code.slice(0, 3)} ${p.code.slice(3)}</div>
          <div class="muted">Berlaku ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · sekali pakai</div>
        </div>
      </div>
      <p class="access-mode ${viaTailscale ? 'full' : 'view'}">${viaTailscale
        ? '🌐 <b>Tailscale: kendali penuh.</b> HP bisa mengirim perintah, menjawab izin, dan commit.'
        : '📶 <b>WiFi: hanya lihat.</b> HP bisa memantau chat, perubahan, dan aktivitas, tapi tidak bisa mengirim perintah. Untuk kendali penuh, pakai Tailscale.'}</p>
      <p class="muted small">Belum tersambung? Saat pertama kali, Windows mungkin menanyakan izin firewall untuk Node.js — pilih <b>Allow / Izinkan</b> (jaringan Private).</p>`
    : '<p class="muted">Menyiapkan kode…</p>';
  body.innerHTML += `<div class="devices"><b>Perangkat terhubung</b>${devices ? `<ul>${devices}</ul>` : '<p class="muted small">Belum ada.</p>'}<p class="muted small">Dicabut otomatis setelah ${info.idleDays ?? 30} hari tidak aktif.</p></div>`;
  // Rendered apart from the per-second countdown so an opened <details> stays open.
  const tipBox = $('#phone-tip');
  if (tipBox.dataset.tailscale !== String(info.tailscale)) {
    tipBox.innerHTML = tailscaleTip;
    tipBox.dataset.tailscale = String(info.tailscale);
  }
}

export async function refreshPairing() {
  clearTimeout(phone.timer);
  if ($('#phone-modal').hidden || !state.config?.remote?.enabled) return;
  try {
    if (!phone.pairing || Date.now() > phone.pairing.expires - 1000 || (phone.ip && phone.pairing.ip !== phone.ip)) {
      phone.pairing = await api('/api/remote/pairing', { ip: phone.ip });
    }
  } catch (err) {
    phone.pairing = null;
    $('#phone-body').innerHTML = `<p class="warn">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderPhone();
  phone.timer = setTimeout(refreshPairing, 1000); // countdown + auto-rotate when expired
}

function openPhone() {
  $('#phone-modal').hidden = false;
  phone.pairing = null;
  renderPhone();
  refreshPairing();
}

export function initPhone() {
  $('#btn-phone').addEventListener('click', openPhone);
  $('#phone-close').addEventListener('click', () => {
    $('#phone-modal').hidden = true;
    clearTimeout(phone.timer);
  });
  $('#phone-modal').addEventListener('click', (e) => {
    if (e.target.id === 'phone-modal') $('#phone-close').click();
  });
  $('#remote-enabled').addEventListener('change', async (e) => {
    try {
      await api('/api/remote', { enabled: e.target.checked });
      phone.pairing = null;
      setTimeout(refreshPairing, 300);
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message);
    }
  });
  $('#phone-body').addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-ip]');
    if (tab) {
      phone.ip = tab.dataset.ip; // same pairing code, QR for the other address
      refreshPairing();
      return;
    }
    const btn = e.target.closest('[data-revoke]');
    if (!btn || !window.confirm('Cabut akses perangkat ini? HP itu harus scan QR lagi untuk masuk.')) return;
    await api('/api/remote/revoke', { id: btn.dataset.revoke }).catch((err) => toast(err.message));
  });
}
