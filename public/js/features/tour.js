// 👋 Tur singkat: four steps for a new user. Opened from Panduan or the empty chat; never pops up by itself.
import { $, escapeHtml } from '../core/dom.js';
import { closeModal, openModal } from '../ui/modals.js';

const DONE_KEY = 'office.tourDone';
const STEPS = [
  { icon: '🗂', title: 'Pilih project', body: 'Klik nama project di kiri atas, atau tekan Ctrl+K. Setiap project memakai folder dan riwayat chat sendiri.' },
  { icon: '💬', title: 'Minta sesuatu di chat', body: 'Ketik permintaan seperti “perbaiki bug checkout”. Di layar kosong ada beberapa ide singkat yang bisa langsung diklik.' },
  { icon: '✋', title: 'Jawab izin', body: 'Saat tim mau mengedit file atau menjalankan perintah, kartu izin muncul di chat. Di laptop atau HP lewat Tailscale, izin juga bisa dijawab dari notifikasi.' },
  { icon: '📋', title: 'Pantau dan atur', body: 'Antrian, jadwal, budget, dan tema ada di ⚙. Tombol 🗂 Semua project punya daftar “Perlu perhatian” agar tidak ada yang tertinggal.' },
];
let at = 0;

function render() {
  const step = STEPS[at];
  $('#tour-body').innerHTML = `<div class="tour-step"><div class="tour-icon" aria-hidden="true">${step.icon}</div><h3>${escapeHtml(step.title)}</h3><p>${escapeHtml(step.body)}</p></div>`;
  $('#tour-progress').textContent = `${at + 1} / ${STEPS.length}`;
  $('#tour-next').textContent = at === STEPS.length - 1 ? 'Selesai' : 'Lanjut';
}

function finish() {
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    // private mode: the tour just opens again next time
  }
  closeModal('tour-modal');
}

export function openTour(index = 0) {
  at = Math.max(0, Math.min(STEPS.length - 1, index));
  render();
  openModal('tour-modal');
}

export function initTour() {
  $('#btn-tour')?.addEventListener('click', () => openTour());
  $('#tour-next')?.addEventListener('click', () => {
    if (at >= STEPS.length - 1) return finish();
    at += 1;
    render();
  });
  $('#tour-skip')?.addEventListener('click', finish);
}
