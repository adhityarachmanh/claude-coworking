// 🔐 Encrypted history backups: the .zip is sealed with AES-256-GCM and a scrypt-derived key.
// File layout: "AOEBK1\0" | salt(16) | iv(12) | ciphertext | tag(16). The password is never stored.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { appendFileSync, closeSync, createReadStream, createWriteStream, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export const BACKUP_MAGIC = Buffer.from('AOEBK1\0');
export const MIN_BACKUP_PASSWORD = 8;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class BackupCryptoError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** True when the file starts with the encrypted-backup magic (reads only the first bytes). */
export function isEncryptedBackup(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(BACKUP_MAGIC.length);
    const read = readSync(fd, head, 0, head.length, 0);
    return read === head.length && head.equals(BACKUP_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Encrypts `zipFile` into `outFile` (header + ciphertext + auth tag). */
export async function encryptBackupFile(zipFile, outFile, password) {
  if (typeof password !== 'string' || password.length < MIN_BACKUP_PASSWORD) throw new BackupCryptoError(`Kata sandi backup minimal ${MIN_BACKUP_PASSWORD} karakter.`);
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(password, salt, KEY_LEN, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  writeFileSync(outFile, Buffer.concat([BACKUP_MAGIC, salt, iv]));
  const out = createWriteStream(outFile, { flags: 'a' });
  await pipeline(createReadStream(zipFile), cipher, out);
  appendFileSync(outFile, cipher.getAuthTag()); // GCM tag: a wrong password or a changed byte fails here
}

/** Decrypts an encrypted backup into `outFile` (a plain .zip). Throws BackupCryptoError on a wrong password. */
export async function decryptBackupFile(inFile, outFile, password) {
  if (typeof password !== 'string' || !password) throw new BackupCryptoError('Backup ini terenkripsi: isi kata sandi dulu.');
  const size = statSync(inFile).size;
  const start = BACKUP_MAGIC.length + SALT_LEN + IV_LEN;
  if (size <= start + TAG_LEN) throw new BackupCryptoError('File backup terenkripsi tidak lengkap.');
  let fd;
  try {
    fd = openSync(inFile, 'r');
    const head = Buffer.alloc(start);
    readSync(fd, head, 0, start, 0);
    if (!head.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new BackupCryptoError('File ini bukan backup terenkripsi Adhitron.');
    const salt = head.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + SALT_LEN);
    const iv = head.subarray(BACKUP_MAGIC.length + SALT_LEN, start);
    const tag = Buffer.alloc(TAG_LEN);
    readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
    const key = scryptSync(password, salt, KEY_LEN, SCRYPT);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    await pipeline(createReadStream(inFile, { start, end: size - TAG_LEN - 1 }), decipher, createWriteStream(outFile));
  } catch (err) {
    if (err instanceof BackupCryptoError) throw err;
    throw new BackupCryptoError('Kata sandi salah atau file backup rusak.', 400);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
