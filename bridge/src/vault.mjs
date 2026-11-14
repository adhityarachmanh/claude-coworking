// bridge/src/vault.mjs — kredensial Tuya per-space disimpan TERENKRIPSI (AES-256-GCM).
// Key = scrypt(ownerToken + ENCRYPTION_KEY operator, salt 16 byte per-space, panjang 32).
// Catatan jujur: operator memegang ENCRYPTION_KEY dan punya akses ke Blobs, jadi SECARA TEKNIS
// operator bisa menghitung kunci ini dan membaca isi terenkripsi. Privasi user bertumpu pada
// komitmen operator untuk TIDAK membacanya (dinyatakan di halaman register/manage), bukan pada
// matematika. Untuk mengecilkan paparan: ownerToken user sendiri disimpan terenkripsi dengan
// kunci murni dari ENCRYPTION_KEY (encryptSecret di bawah) — snapshot store tidak memuat
// token siap-pakai, hanya cron di server yang bisa memulihkannya.
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';

/** ENCRYPTION_KEY harus 32-byte hex (64 karakter hex), diset operator lewat env var Netlify. */
export function assertEncryptionKey(encryptionKey) {
  if (typeof encryptionKey !== 'string' || !/^[0-9a-f]{64}$/i.test(encryptionKey)) {
    throw new Error('ENCRYPTION_KEY belum diset (env var Netlify, 32-byte hex / 64 karakter)');
  }
}

/** Enkripsi objek kredensial → { v, ct, iv, tag, salt } (semua hex, salt/iv baru tiap kali). */
export function encryptCreds(ownerToken, encryptionKey, creds) {
  assertEncryptionKey(encryptionKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(`${ownerToken}${encryptionKey}`, salt, 32);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(creds), 'utf8'), cipher.final()]);
  return {
    v: 1,
    ct: ct.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    salt: salt.toString('hex'),
  };
}

/** Kebalikan encryptCreds; tag GCM salah → throw (kredensial dianggap korup / token salah). */
export function decryptCreds(ownerToken, encryptionKey, enc) {
  assertEncryptionKey(encryptionKey);
  if (!enc?.ct || !enc?.iv || !enc?.tag || !enc?.salt) throw new Error('record terenkripsi tidak lengkap');
  const key = scryptSync(`${ownerToken}${encryptionKey}`, Buffer.from(enc.salt, 'hex'), 32);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(enc.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  const pt = Buffer.concat([decipher.update(Buffer.from(enc.ct, 'hex')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

/** Enkripsi nilai rahasia server-side (ownerToken user) dengan kunci MURNI dari ENCRYPTION_KEY —
 * tanpa ownerToken di dalam formula, agar cron bisa dekripsi tapi snapshot store tidak memuat
 * token siap-pakai (yang bocor bisa langsung dipakai orang lain untuk menguasai space). */
export function encryptSecret(encryptionKey, value) {
  assertEncryptionKey(encryptionKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(encryptionKey, salt, 32);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: 1,
    ct: ct.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    salt: salt.toString('hex'),
  };
}

/** Kebalikan encryptSecret; tag GCM salah → throw (data dianggap korup / ENCRYPTION_KEY salah). */
export function decryptSecret(encryptionKey, enc) {
  assertEncryptionKey(encryptionKey);
  if (!enc?.ct || !enc?.iv || !enc?.tag || !enc?.salt) throw new Error('record terenkripsi tidak lengkap');
  const key = scryptSync(encryptionKey, Buffer.from(enc.salt, 'hex'), 32);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(enc.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  const pt = Buffer.concat([decipher.update(Buffer.from(enc.ct, 'hex')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}
