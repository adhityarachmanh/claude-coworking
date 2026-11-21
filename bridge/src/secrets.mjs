// bridge/src/secrets.mjs — enkripsi API key user (AES-256-GCM) dengan kunci operator.
// Beda dari bridge/src/vault.mjs: kunci di sini TIDAK melibatkan token user — seluruh server harus bisa
// mendekripsi key milik user mana pun untuk meneruskan permintaan ke provider atas namanya. Karena itu
// kekuatan privasi bertumpu pada ENCRYPTION_KEY operator + komitmen operator, sama seperti jembatan.
// Bentuk tersimpan: { v, ct, iv, tag, salt } (semua hex); salt+iv baru tiap enkripsi.
//
// Catatan kripto: scrypt di sini murni untuk menurunkan kunci 32 byte dari ENCRYPTION_KEY + salt (bukan
// untuk memverifikasi password), jadi parameternya ringan dan tetap aman karena ENCRYPTION_KEY acak 256-bit.
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';

/** ENCRYPTION_KEY harus 32-byte hex (64 karakter). */
export function assertKey(encryptionKey) {
  if (typeof encryptionKey !== 'string' || !/^[0-9a-f]{64}$/i.test(encryptionKey)) {
    throw new Error('ENCRYPTION_KEY belum diset (32-byte hex / 64 karakter)');
  }
}

const deriveKey = (encryptionKey, salt) =>
  scryptSync(Buffer.from(encryptionKey, 'hex'), salt, 32, { N: 16384, r: 8, p: 1 });

/** Enkripsi string rahasia (mis. API key) → { v, ct, iv, tag, salt }. */
export function encryptSecret(encryptionKey, plaintext) {
  assertKey(encryptionKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(encryptionKey, salt), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { v: 1, ct: ct.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), salt: salt.toString('hex') };
}

/** Kebalikan encryptSecret; tag salah / record tak lengkap → throw. */
export function decryptSecret(encryptionKey, enc) {
  assertKey(encryptionKey);
  if (!enc?.ct || !enc?.iv || !enc?.tag || !enc?.salt) throw new Error('record terenkripsi tidak lengkap');
  const decipher = createDecipheriv(ALGO, deriveKey(encryptionKey, Buffer.from(enc.salt, 'hex')), Buffer.from(enc.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  const pt = Buffer.concat([decipher.update(Buffer.from(enc.ct, 'hex')), decipher.final()]);
  return pt.toString('utf8');
}

/** Empat karakter terakhir key untuk tampilan ("…abcd"); tidak pernah mengembalikan key penuh. */
export const keyHint = (apiKey) => {
  const s = String(apiKey ?? '');
  return s.length >= 4 ? s.slice(-4) : '';
};

/** Bentuk provider yang aman dikirim ke klien: tanpa ciphertext key. */
export const publicProvider = (p) => ({
  id: p.id,
  kind: p.kind,
  label: p.label,
  baseUrl: p.base_url ?? null,
  keyHint: p.key_hint ?? null,
  createdAt: p.created_at,
});