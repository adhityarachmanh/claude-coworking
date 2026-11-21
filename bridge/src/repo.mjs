// bridge/src/repo.mjs — repository Adhitron Web di atas SQL (Neon Postgres).
// Satu implementasi permukaan yang sama dengan src/repo-memory.mjs (dipakai test cepat tanpa DB).
// ATURAN KERAS: setiap fungsi yang menyentuh data milik user menerima `userId` dan MEMFILTER dengan
// itu — tidak ada jalur yang membaca/menulis baris user lain. Uji konformansi (test) menjalankan
// suite yang sama terhadap kedua implementasi supaya perilakunya tidak bisa menyimpang.
import { randomUUID } from 'node:crypto';

const nowIso = () => new Date().toISOString();

/** Repo SQL. `db.query(text, params)` → array baris. */
export function makeSqlRepo(db) {
  const one = async (text, params) => (await db.query(text, params))[0] ?? null;
  const all = (text, params) => db.query(text, params);

  return {
    // ---------------------------------------------------------------- users
    async createUser({ email, displayName = null, passwordHash }) {
      return one(
        `insert into users (email, display_name, password_hash)
         values ($1, $2, $3) returning *`,
        [String(email).toLowerCase(), displayName, passwordHash],
      );
    },
    async getUserByEmail(email) {
      return one('select * from users where email = $1', [String(email).toLowerCase()]);
    },
    async getUserById(id) {
      return one('select * from users where id = $1', [id]);
    },
    /** Hapus akun beserta seluruh datanya (hak hapus / UU PDP). FK on delete cascade menyapu sisanya. */
    async deleteUser(id) {
      await db.query('delete from users where id = $1', [id]);
    },

    // ---------------------------------------------------------------- sessions
    async createSession({ tokenHash, userId, expiresAt }) {
      return one(
        `insert into sessions (token_hash, user_id, expires_at)
         values ($1, $2, $3) returning *`,
        [tokenHash, userId, expiresAt],
      );
    },
    async getSession(tokenHash) {
      return one('select * from sessions where token_hash = $1', [tokenHash]);
    },
    async touchSession(tokenHash, at = nowIso()) {
      await db.query('update sessions set last_seen_at = $2 where token_hash = $1', [tokenHash, at]);
    },
    async deleteSession(tokenHash) {
      await db.query('delete from sessions where token_hash = $1', [tokenHash]);
    },
    async deleteExpiredSessions(now = nowIso()) {
      await db.query('delete from sessions where expires_at <= $1', [now]);
    },

    // ---------------------------------------------------------------- providers
    async listProviders(userId) {
      return all('select * from providers where user_id = $1 order by created_at', [userId]);
    },
    async getProvider(userId, id) {
      return one('select * from providers where user_id = $1 and id = $2', [userId, id]);
    },
    async createProvider({ userId, kind, label, baseUrl = null, apiKeyEnc, keyHint = null, models = null }) {
      return one(
        `insert into providers (user_id, kind, label, base_url, api_key_enc, key_hint, models)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [userId, kind, label, baseUrl, apiKeyEnc, keyHint, models],
      );
    },
    async updateProvider(userId, id, patch) {
      const found = await this.getProvider(userId, id);
      if (!found) return null;
      const next = { ...found, ...patch, updated_at: nowIso() };
      return one(
        `update providers set label = $3, base_url = $4, api_key_enc = $5, key_hint = $6, models = $7, updated_at = $8
         where user_id = $1 and id = $2 returning *`,
        [userId, id, next.label, next.base_url, next.api_key_enc, next.key_hint, next.models ?? null, next.updated_at],
      );
    },
    async deleteProvider(userId, id) {
      await db.query('delete from providers where user_id = $1 and id = $2', [userId, id]);
    },

    // ---------------------------------------------------------------- conversations
    async listConversations(userId) {
      return all('select * from conversations where user_id = $1 order by updated_at desc', [userId]);
    },
    async getConversation(userId, id) {
      return one('select * from conversations where user_id = $1 and id = $2', [userId, id]);
    },
    async createConversation(userId, fields = {}) {
      const c = {
        id: randomUUID(), user_id: userId, title: fields.title ?? 'Percakapan baru',
        provider_id: fields.providerId ?? null, model: fields.model ?? null, effort: fields.effort ?? null,
        model_auto: fields.modelAuto ?? false, effort_auto: fields.effortAuto ?? false,
        model_tiers: fields.modelTiers ?? null, browsing: fields.browsing ?? false,
        created_at: nowIso(), updated_at: nowIso(),
      };
      return one(
        `insert into conversations
           (id, user_id, title, provider_id, model, effort, model_auto, effort_auto, model_tiers, browsing, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [c.id, c.user_id, c.title, c.provider_id, c.model, c.effort, c.model_auto, c.effort_auto,
          c.model_tiers, c.browsing, c.created_at, c.updated_at],
      );
    },
    async updateConversation(userId, id, patch) {
      const found = await this.getConversation(userId, id);
      if (!found) return null;
      const n = { ...found, ...patch };
      return one(
        `update conversations set title=$3, provider_id=$4, model=$5, effort=$6, model_auto=$7,
           effort_auto=$8, model_tiers=$9, browsing=$10, updated_at=$11
         where user_id=$1 and id=$2 returning *`,
        [userId, id, n.title, n.provider_id, n.model, n.effort, n.model_auto, n.effort_auto,
          n.model_tiers, n.browsing, nowIso()],
      );
    },
    async deleteConversation(userId, id) {
      await db.query('delete from conversations where user_id = $1 and id = $2', [userId, id]);
    },

    // ---------------------------------------------------------------- messages
    /** Pesan selalu diambil lewat percakapan milik user (join ke conversations) — bukan id pesan langsung. */
    async listMessages(userId, conversationId) {
      return all(
        `select m.* from messages m join conversations c on c.id = m.conversation_id
         where c.user_id = $1 and m.conversation_id = $2 order by m.created_at, m.id`,
        [userId, conversationId],
      );
    },
    async addMessage(userId, conversationId, { role, content, meta = null }) {
      const conv = await this.getConversation(userId, conversationId);
      if (!conv) return null;
      const row = await one(
        `insert into messages (conversation_id, role, content, meta)
         values ($1, $2, $3, $4) returning *`,
        [conversationId, role, content, meta],
      );
      await db.query('update conversations set updated_at = $2 where id = $1', [conversationId, nowIso()]);
      return row;
    },
    async deleteMessage(userId, conversationId, messageId) {
      await db.query(
        `delete from messages m using conversations c
         where m.id = $3 and m.conversation_id = c.id and c.user_id = $1 and m.conversation_id = $2`,
        [userId, conversationId, messageId],
      );
    },

    // ---------------------------------------------------------------- citations
    async addCitations(userId, messageId, list) {
      const rows = [];
      for (const [i, cite] of list.entries()) {
        rows.push(await one(
          `insert into citations (message_id, idx, title, url, snippet)
           values ($1, $2, $3, $4, $5) returning *`,
          [messageId, cite.idx ?? i + 1, cite.title ?? null, cite.url, cite.snippet ?? null],
        ));
      }
      return rows;
    },
    async listCitations(userId, conversationId) {
      return all(
        `select ci.* from citations ci
           join messages m on m.id = ci.message_id
           join conversations c on c.id = m.conversation_id
         where c.user_id = $1 and c.id = $2 order by ci.message_id, ci.idx`,
        [userId, conversationId],
      );
    },

    // ---------------------------------------------------------------- tool runs
    async addToolRun(userId, conversationId, { messageId = null, tool, input = null, status = 'ok', error = null }) {
      const conv = await this.getConversation(userId, conversationId);
      if (!conv) return null;
      return one(
        `insert into tool_runs (conversation_id, message_id, tool, input, status, error)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [conversationId, messageId, tool, input, status, error],
      );
    },
    async countToolRuns(userId, conversationId, tool = null) {
      const row = await one(
        `select count(*)::int as n from tool_runs t join conversations c on c.id = t.conversation_id
         where c.user_id = $1 and t.conversation_id = $2 and ($3::text is null or t.tool = $3)`,
        [userId, conversationId, tool],
      );
      return row?.n ?? 0;
    },
    /** Retensi: buang jejak tool run yang lebih lama dari cutoff (audit terbatas, bukan arsip permanen). */
    async deleteOldToolRuns(before) {
      await db.query('delete from tool_runs where created_at < $1', [before]);
    },
  };
}