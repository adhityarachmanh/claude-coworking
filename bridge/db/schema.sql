-- bridge/db/schema.sql — skema Adhitron Web (Neon Postgres / Lakebase).
-- Dijalankan manual (atau lewat scripts/migrate) terhadap DATABASE_URL. Idempoten: aman dijalankan ulang.
-- Setiap tabel milik seorang user; setiap query chat WAJIB di-scope user_id (lihat src/repo-*.mjs).
-- Data sensitif: users.password_hash (scrypt) dan providers.api_key_enc (AES-256-GCM, lihat vault) —
-- tidak pernah keluar dalam bentuk plaintext dari server.

create extension if not exists "pgcrypto";

-- Pengguna. email disimpan lowercase; unique menjamin satu akun per email.
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  display_name  text,
  password_hash text not null,          -- "scrypt$<salt hex>$<hash hex>"
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Sesi login. Cookie membawa token acak; yang tersimpan hanya sha256(token) (pola sama dengan bridge).
create table if not exists sessions (
  token_hash   text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions (user_id);

-- Provider AI milik user. api_key_enc = { v, ct, iv, tag, salt } (AES-256-GCM); label untuk tampilan.
create table if not exists providers (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  kind       text not null,             -- 'openai' | 'anthropic' | 'google' (openai-compatible satu kind)
  label      text not null,
  base_url   text,                      -- opsional: endpoint OpenAI-compatible kustom
  api_key_enc jsonb not null,
  key_hint   text,                      -- 4 karakter terakhir key (tampilan saja, bukan rahasia penuh)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists providers_user_idx on providers (user_id);

-- Percakapan. model/effort/Auto disimpan per-percakapan (meniru Adhitron lokal).
create table if not exists conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  title       text not null default 'Percakapan baru',
  provider_id uuid references providers(id) on delete set null,
  model       text,
  effort      text,                     -- 'default'|'low'|'medium'|'high'|'xhigh'|'max'
  model_auto  boolean not null default false,
  effort_auto boolean not null default false,
  model_tiers jsonb,                    -- peta tier → model pilihan user (Hemat/Sedang/Kuat)
  browsing    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists conversations_user_idx on conversations (user_id, updated_at desc);

-- Pesan. role 'user' | 'assistant' | 'system'. meta menyimpan pemakaian token/model yang dipakai, dll.
create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role            text not null,
  content         text not null,
  meta            jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists messages_conv_idx on messages (conversation_id, created_at);

-- Kutipan sumber (chip bernomor) yang menempel pada satu pesan asisten.
create table if not exists citations (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  idx        integer not null,          -- nomor chip [1], [2], ... di dalam pesan
  title      text,
  url        text not null,
  snippet    text,
  created_at timestamptz not null default now()
);
create index if not exists citations_message_idx on citations (message_id, idx);

-- Jejak pemanggilan tool (browsing) untuk audit & debugging, dan untuk menerapkan batas per-percakapan.
create table if not exists tool_runs (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  message_id      uuid references messages(id) on delete set null,
  tool            text not null,        -- 'web_search' | 'fetch_url'
  input           jsonb,
  status          text not null default 'ok', -- 'ok' | 'error'
  error           text,
  created_at      timestamptz not null default now()
);
create index if not exists tool_runs_conv_idx on tool_runs (conversation_id, created_at);