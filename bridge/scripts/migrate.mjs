// bridge/scripts/migrate.mjs — terapkan db/schema.sql ke DATABASE_URL (Neon Postgres).
// Idempoten (semua pernyataan create ... if not exists), jadi aman dijalankan ulang.
//
//   DATABASE_URL=postgres://…  node bridge/scripts/migrate.mjs
//   node bridge/scripts/migrate.mjs --check     # hanya laporkan tabel yang ada
//
// Dijalankan lewat @neondatabase/serverless (driver HTTP). Tidak butuh psql.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNeonDb, isConnectionString } from '../src/db.mjs';
import { makeSqlRepo } from '../src/repo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', 'db', 'schema.sql');
const EXPECTED_TABLES = ['users', 'sessions', 'providers', 'conversations', 'messages', 'citations', 'tool_runs'];

/** Pecah schema.sql menjadi pernyataan: buang komentar "--" dan potong pada ';'. */
export function splitStatements(sql) {
  return sql
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, '')) // komentar baris penuh/trailing
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(argv) {
  const check = argv.includes('--check');
  const url = process.env.DATABASE_URL;
  if (!isConnectionString(url)) {
    console.error('migrate: DATABASE_URL belum diset / bukan postgres:// (lihat bridge/README.md)');
    return 2;
  }
  const db = await createNeonDb(url);
  if (check) {
    const rows = await db.query(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const have = rows.map((r) => r.table_name);
    const missing = EXPECTED_TABLES.filter((t) => !have.includes(t));
    console.log(`tabel ada: ${have.join(', ') || '(kosong)'}`);
    if (missing.length) {
      console.error(`migrate: tabel belum ada: ${missing.join(', ')}`);
      return 1;
    }
    // Repo dipanggil sekali agar jalur koneksi nyata (bukan hanya daftar tabel) ikut teruji.
    await makeSqlRepo(db).listConversations('00000000-0000-0000-0000-000000000000');
    console.log('migrate: skema lengkap, koneksi sehat ✔');
    return 0;
  }
  const statements = splitStatements(readFileSync(SCHEMA, 'utf8'));
  for (const sql of statements) await db.query(sql);
  console.log(`migrate: ${statements.length} pernyataan diterapkan ✔`);
  return 0;
}

process.exit(await main(process.argv.slice(2)));