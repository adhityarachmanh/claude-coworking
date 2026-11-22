// bridge/src/attachments.mjs — lampiran sisi server Adhitron Web (fungsi murni, tanpa I/O).
// Klien tak dipercaya: setiap lampiran divalidasi ulang dengan aturan yang sama dengan browser
// (salinan verbatim `attachment-rules.mjs`), lalu diubah menjadi blok konten netral yang diterjemahkan
// `buildRequest` (chat.mjs) per provider.
//
// Fase 1 hanya kind `image` (PNG/JPEG/GIF/WebP) dan `text` (log/kode/md/json/csv/…). `pdf` sengaja
// ditolak di sini walau aturan bersama sudah mengenalnya (lihat docs/design-adhitron-web.md §5).
// Di atas aturan umum ada overlay batas total khusus bridge (payload Netlify Functions ±6 MB).
import {
  ATTACH_LIMITS, attachmentKind, attachmentTextBlock, checkAttachmentSet, formatSize, inspectAttachment,
  maxBytes, safeName,
} from './attachment-rules.mjs';

/** Batas total file khusus bridge: 3 MB → ±4 MB base64, menyisakan margin di bawah cap payload Lambda. */
export const BRIDGE_ATTACH_LIMITS = Object.freeze({ totalBytes: 3 * 1024 * 1024 });

/** Error validasi lampiran; `status` 400 dipakai rute untuk membalas JSON tanpa membocorkan detail internal. */
export class AttachmentError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const TOO_BIG_TEXT_HINT = 'Taruh file di folder project lalu sebut dengan @file.';
// Bridge hanya melayani gambar & teks, jadi pesan "jenis tidak didukung" tidak menyebut PDF.
const kindError = (name) =>
  `${name}: jenis file tidak didukung. Lampirkan gambar (PNG/JPEG/GIF/WebP) atau file teks (log, kode, md, json, csv, …).`;

/**
 * Baca `body.attachments` ([{ name, mediaType, data(base64 tanpa prefiks) }]).
 * Melempar AttachmentError (400) dengan pesan Bahasa Indonesia pada masalah pertama.
 * @returns {{ kind, name, size, mediaType, data?, text? }[]} data (base64) untuk gambar, text untuk teks
 */
export function readAttachments(body) {
  const listed = Array.isArray(body?.attachments) ? body.attachments : [];
  // Hitung jumlah dulu, sebelum menyalin/mendekode apa pun.
  if (listed.length > ATTACH_LIMITS.maxFiles) throw new AttachmentError(`Maksimal ${ATTACH_LIMITS.maxFiles} lampiran per pesan.`);

  // Gagal cepat dari nama/jenis dan ukuran base64 yang dideklarasikan, sebelum menyentuh Buffer.
  const declared = [];
  let declaredTotal = 0;
  for (const a of listed) {
    const size = Math.floor((typeof a?.data === 'string' ? a.data.length : 0) * 3 / 4);
    declaredTotal += size;
    const name = safeName(a?.name);
    const kind = attachmentKind(name, String(a?.mediaType ?? ''));
    if (!kind) throw new AttachmentError(kindError(name));
    if (kind === 'pdf') throw new AttachmentError(`${name}: PDF belum didukung pada versi ini.`);
    declared.push({ name, kind, size });
  }
  if (declaredTotal > BRIDGE_ATTACH_LIMITS.totalBytes) {
    throw new AttachmentError(`Total lampiran lebih dari ${formatSize(BRIDGE_ATTACH_LIMITS.totalBytes)}.`);
  }
  for (const { name, kind, size } of declared) {
    // data kosong sengaja dibiarkan lewat ke pemeriksaan base64 agar pesannya seragam ("data rusak").
    if (!size) continue;
    if (size > maxBytes(kind)) {
      throw new AttachmentError(kind === 'text'
        ? `${name} lebih dari ${formatSize(ATTACH_LIMITS.textBytes)}. ${TOO_BIG_TEXT_HINT}`
        : `${name} lebih dari ${formatSize(maxBytes(kind))}.`);
    }
  }

  const items = listed.map((a) => {
    const data = typeof a?.data === 'string' ? a.data : '';
    // Buffer.from() diam-diam melewati karakter yang bukan base64: pastikan bentuk kanonik lebih dulu.
    if (!data || data.length % 4 !== 0 || !BASE64.test(data)) throw new AttachmentError('Data lampiran rusak (bukan base64).');
    const bytes = Buffer.from(data, 'base64');
    const checked = inspectAttachment({ name: String(a?.name ?? ''), mediaType: String(a?.mediaType ?? ''), bytes });
    if (!checked.ok) throw new AttachmentError(checked.error);
    // Aturan bersama mengenal pdf; bridge belum melayani — tolak di sini dengan pesan fase 1.
    if (checked.item.kind === 'pdf') throw new AttachmentError(`${checked.item.name}: PDF belum didukung pada versi ini.`);
    return checked.item.kind === 'text' ? checked.item : { ...checked.item, data };
  });
  const setError = checkAttachmentSet(items);
  if (setError) throw new AttachmentError(setError);
  return items;
}

/**
 * Blok konten netral untuk pesan user: blok teks lampiran dulu, lalu teks ketik (bila ada), lalu gambar.
 * Blok teks kosong tidak disertakan agar provider tidak menolak `text` kosong. `textBlocks` boleh diberikan
 * (hasil `renderTextBlocks`) agar blok yang dikirim kali ini identik dengan yang disimpan di riwayat.
 */
export function contentBlocks(items, text, textBlocks = renderTextBlocks(items)) {
  const attachmentTexts = textBlocks.map((t) => ({ type: 'text', text: t }));
  const typed = String(text ?? '').trim() ? [{ type: 'text', text }] : [];
  const images = items.filter((a) => a.kind === 'image')
    .map((a) => ({ type: 'image', mediaType: a.mediaType, data: a.data }));
  return [...attachmentTexts, ...typed, ...images];
}

/**
 * Blok `<attachment id=…>` yang sudah dirender untuk tiap lampiran teks. Dirender sekali lalu dipakai ulang
 * (giliran berjalan DAN `meta.textBlocks`) supaya id acak anti prompt-injection tetap sama saat riwayat
 * dikirim ulang di giliran lanjutan.
 */
export const renderTextBlocks = (items) => items.filter((a) => a.kind === 'text').map((a) => attachmentTextBlock(a));

/** Yang disimpan di gelembung pesan: nama, ukuran, dan jenis — bukan isinya. */
export const attachmentChips = (items) => items.map(({ kind, name, size }) => ({ kind, name, size }));