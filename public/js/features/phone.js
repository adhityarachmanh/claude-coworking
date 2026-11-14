// Phone access (QR pairing), laptop only.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { ago } from '../core/format.js';
import { state } from '../core/state.js';
import { qrSvg } from '../qr.js';

// https: true = the 🔒 Tailscale (HTTPS) QR, false = an http address, null = not chosen yet (HTTPS when available).
export const phone = { timer: null, pairing: null, ip: null, https: null, checking: false, pushing: false };
const ADDRESS_LABEL = { lan: '📶 WiFi yang sama', tailscale: '🌐 Dari mana saja (Tailscale)' };
const HTTPS_LABEL = '🔒 Tailscale (HTTPS)';

const fmtDate = (ts) => new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * The HTTPS (Tailscale certificate) status line: { tone, html } or null when there is nothing to say.
 * `https` = config.remote.https from the server: { state, host, url, validTo, error }.
 */
export function httpsStatus(https) {
  if (!https || https.state === 'off' || https.state === 'no-tailscale') return null;
  const until = Number.isFinite(https.validTo) ? ` · berlaku s/d ${escapeHtml(fmtDate(https.validTo))}` : '';
  const error = https.error ? `<small>${escapeHtml(String(https.error))}</small>` : '';
  switch (https.state) {
    case 'ok':
      return { tone: 'ok', html: `🔒 HTTPS aktif: <code>${escapeHtml(https.url ?? https.host ?? '')}</code>${until} — HP bisa dapat notifikasi push.` };
    case 'expiring':
      return { tone: 'warn', html: `⚠ Sertifikat HTTPS hampir habis${until}. ${error}` };
    case 'certs-disabled':
      return {
        tone: 'warn',
        html: 'Untuk notifikasi push ke HP: nyalakan <b>HTTPS Certificates</b> di admin console Tailscale (DNS → HTTPS Certificates), lalu klik Periksa lagi. <small>Nama laptop + tailnet akan tercatat di log publik Certificate Transparency.</small>',
      };
    default: // expired / error
      return { tone: 'warn', html: `HTTPS tidak aktif${https.state === 'expired' ? ' (sertifikat kedaluwarsa)' : ''}. ${error}` };
  }
}

function renderHttps(info) {
  const box = $('#phone-https');
  const status = info.enabled ? httpsStatus(info.https) : null;
  const html = status
    ? `<p class="https-status ${status.tone}"><span>${status.html}</span><span class="grow"></span><button type="button" data-https-check ${phone.checking ? 'disabled' : ''}>${phone.checking ? 'Memeriksa…' : 'Periksa lagi'}</button></p>`
    : '';
  // Drawn apart from the per-second countdown: the "Periksa lagi" button keeps its focus.
  if (box.dataset.html !== html) {
    box.innerHTML = html;
    box.dataset.html = html;
  }
}

// lastSeen is only stored about once an hour (server throttles disk writes), so recent use reads as "dalam 1 jam terakhir".
const lastActive = (ts) => (Date.now() - ts < 3_600_000 ? 'dalam 1 jam terakhir' : ago(ts));

function renderPhone() {
  const info = state.config?.remote ?? { enabled: false, urls: [], devices: [] };
  $('#remote-enabled').checked = info.enabled;
  const body = $('#phone-body');
  if (!info.enabled) {
    renderHttps(info);
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
  const badges = (d) => `${d.transport === 'https' ? ' <span class="dev-badge" title="Dipasangkan lewat HTTPS (Tailscale)">🔒 HTTPS</span>' : ''}${!d.push ? '' : d.push.failing ? ' <span class="dev-badge warn" title="Push terakhir gagal terkirim ke HP ini">🔔 Push ⚠</span>' : ' <span class="dev-badge" title="Notifikasi push aktif">🔔 Push</span>'}`;
  const devices = info.devices
    .map((d) => `<li><span>${escapeHtml(d.name)}${badges(d)}<small>dipasangkan ${new Date(d.created).toLocaleDateString('id-ID')} · terakhir aktif ${lastActive(d.lastSeen ?? d.created)}</small></span><button class="danger" data-revoke="${d.id}">Cabut</button></li>`)
    .join('');
  // 🔒 HTTPS: the same one-time code, but the QR opens the https origin (pairs separately, gets push).
  const secure = p?.https?.qrUrl && p.https.url ? p.https : null;
  const viaHttps = Boolean(secure) && phone.https !== false;
  const viaTailscale = viaHttps || p?.addresses.find((a) => a.ip === p.ip)?.kind === 'tailscale';
  const httpsHost = secure ? escapeHtml(secure.url.replace(/^https:\/\//, '')) : '';
  const chooser = p && (p.addresses.length > 1 || secure)
    ? `<div class="addr-tabs">${secure ? `<button class="${viaHttps ? 'active' : ''}" data-https>${HTTPS_LABEL}<small>${httpsHost}</small></button>` : ''}${p.addresses.map((a) => `<button class="${!viaHttps && a.ip === p.ip ? 'active' : ''}" data-ip="${a.ip}">${ADDRESS_LABEL[a.kind] ?? a.kind}<small>${a.ip}</small></button>`).join('')}</div>`
    : '';
  const qrUrl = viaHttps ? secure.qrUrl : p?.qrUrl;
  const openUrl = viaHttps ? secure.url : p?.url;
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
        <div class="qr">${qrSvg(qrUrl)}</div>
        <div class="pair-info">
          <ol>
            <li>${viaTailscale ? 'Nyalakan Tailscale di HP (boleh pakai data seluler / WiFi mana saja).' : 'Sambungkan HP ke WiFi yang sama.'}</li>
            <li>Scan QR dengan kamera HP.</li>
            <li>Atau buka <code>${escapeHtml(openUrl)}</code> lalu masukkan kode:</li>
          </ol>
          <div class="code">${p.code.slice(0, 3)} ${p.code.slice(3)}</div>
          <div class="muted">Berlaku ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · sekali pakai</div>
          <button type="button" data-code-push ${phone.pushing ? 'disabled' : ''}>${phone.pushing ? 'Mengirim…' : '🔔 Kirim kode ke HP-mu'}</button>
          <div class="muted small">Jauh dari layar laptop? Kode baru dikirim sebagai notifikasi ke HP yang sudah terpasang.</div>
        </div>
      </div>
      <p class="access-mode ${viaTailscale ? 'full' : 'view'}">${viaHttps
        ? '🔒 <b>Tailscale HTTPS: kendali penuh + notifikasi push.</b> Setelah masuk, aktifkan di 🔔 Pengaturan notifikasi → Notifikasi HP. Dipasangkan terpisah dari alamat http.'
        : viaTailscale
        ? '🌐 <b>Tailscale: kendali penuh.</b> HP bisa mengirim perintah, menjawab izin, dan commit.'
        : '📶 <b>WiFi: hanya lihat.</b> HP bisa memantau chat, perubahan, dan aktivitas, tapi tidak bisa mengirim perintah. Untuk kendali penuh, pakai Tailscale.'}</p>
      <div class="auto-pair"><label class="switch"><input id="remote-auto-pair" type="checkbox" ${info.autoPairTailnet !== false ? 'checked' : ''}/> Izinkan pasang otomatis dari perangkat tailnet (tanpa kode)</label>
        <p class="muted small">Perangkat yang login dengan akun Tailscale yang sama dengan laptop ini bisa pasang langsung lewat 🔒 HTTPS, tanpa mengetik kode. Perangkat lain (WiFi, akun tailnet orang lain) tetap butuh kode sekali pakai.</p></div>
      <p class="muted small">Belum tersambung? Saat pertama kali, Windows mungkin menanyakan izin firewall untuk Node.js — pilih <b>Allow / Izinkan</b> (jaringan Private).</p>`
    : '<p class="muted">Menyiapkan kode…</p>';
  renderHttps(info);
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
  phone.https = null; // HTTPS first again when it is available
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
  // 🔓 Pasang otomatis dari perangkat tailnet: the checkbox is rebuilt every second by renderPhone(),
  // so the change handler saves at once and the next render already shows the saved state.
  $('#phone-body').addEventListener('change', async (e) => {
    if (e.target.id !== 'remote-auto-pair') return;
    try {
      const info = await api('/api/remote/auto-pair', { autoPairTailnet: e.target.checked });
      if (state.config?.remote) state.config.remote = { ...state.config.remote, autoPairTailnet: info.autoPairTailnet };
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message);
    }
  });
  $('#phone-https').addEventListener('click', async (e) => {
    if (!e.target.closest('[data-https-check]') || phone.checking) return;
    phone.checking = true;
    renderPhone();
    try {
      const https = await api('/api/remote/https-check');
      if (state.config?.remote) state.config.remote = { ...state.config.remote, https };
      phone.pairing = null; // a certificate that just arrived brings the 🔒 HTTPS QR
    } catch (err) {
      toast(err.message);
    } finally {
      phone.checking = false;
      renderPhone();
      refreshPairing();
    }
  });
  $('#phone-body').addEventListener('click', async (e) => {
    const pushBtn = e.target.closest('[data-code-push]');
    if (pushBtn) {
      if (phone.pushing) return;
      phone.pushing = true;
      renderPhone();
      try {
        const out = await api('/api/pairing/code/push');
        phone.pairing = null; // the old code just died: show the fresh one right away
        if (out.pushed > 0) toast('🔔 Kode pasangan baru dikirim ke HP-mu.', 'ok');
        else if (out.skipped) toast('Kode lama di notifikasi sudah tidak berlaku. Notifikasi kode baru menyusul < 1 menit — atau lihat kode baru di layar laptop.');
        else toast('Belum ada HP terpasang yang berlangganan notifikasi (butuh HTTPS Tailscale).');
      } catch (err) {
        toast(err.message);
      } finally {
        phone.pushing = false;
        refreshPairing();
      }
      return;
    }
    if (e.target.closest('[data-https]')) {
      phone.https = true; // same pairing code, QR for the https origin
      renderPhone();
      return;
    }
    const tab = e.target.closest('[data-ip]');
    if (tab) {
      phone.ip = tab.dataset.ip; // same pairing code, QR for the other address
      phone.https = false;
      refreshPairing();
      return;
    }
    const btn = e.target.closest('[data-revoke]');
    if (!btn || !window.confirm('Cabut akses perangkat ini? HP itu harus scan QR lagi untuk masuk.')) return;
    await api('/api/remote/revoke', { id: btn.dataset.revoke }).catch((err) => toast(err.message));
  });
}
