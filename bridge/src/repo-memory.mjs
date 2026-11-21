// bridge/src/repo-memory.mjs — implementasi repo yang sama dengan src/repo.mjs, tetapi murni in-memory.
// Dipakai test cepat (tanpa DB) dan sebagai acuan perilaku: apa pun yang benar di sini harus benar
// di implementasi SQL. Menjaga permukaan & aturan scoping userId identik dengan repo.mjs.
import { randomUUID } from 'node:crypto';

const nowIso = () => new Date().toISOString();

/** Repo in-memory. `state` boleh diberikan agar test bisa memeriksa isinya (mis. kebocoran rahasia). */
export function makeMemoryRepo(state = {}) {
  const db = {
    users: [], sessions: [], providers: [], conversations: [], messages: [], citations: [], toolRuns: [],
    ...state,
  };
  const lower = (e) => String(e).toLowerCase();

  return {
    _state: db,
    // ---------------------------------------------------------------- users
    async createUser({ email, displayName = null, passwordHash, consentVersion = null }) {
      const e = lower(email);
      if (db.users.some((u) => u.email === e)) throw new Error('email sudah terdaftar');
      const row = {
        id: randomUUID(), email: e, display_name: displayName, password_hash: passwordHash,
        consent_version: consentVersion, consent_at: consentVersion ? nowIso() : null,
        created_at: nowIso(), updated_at: nowIso(),
      };
      db.users.push(row);
      return { ...row };
    },
    async getUserByEmail(email) {
      const u = db.users.find((x) => x.email === lower(email));
      return u ? { ...u } : null;
    },
    async getUserById(id) {
      const u = db.users.find((x) => x.id === id);
      return u ? { ...u } : null;
    },
    async deleteUser(id) {
      db.users = db.users.filter((u) => u.id !== id);
      const convIds = db.conversations.filter((c) => c.user_id === id).map((c) => c.id);
      db.conversations = db.conversations.filter((c) => c.user_id !== id);
      db.providers = db.providers.filter((p) => p.user_id !== id);
      db.sessions = db.sessions.filter((s) => s.user_id !== id);
      const msgIds = db.messages.filter((m) => convIds.includes(m.conversation_id)).map((m) => m.id);
      db.messages = db.messages.filter((m) => !convIds.includes(m.conversation_id));
      db.citations = db.citations.filter((c) => !msgIds.includes(c.message_id));
      db.toolRuns = db.toolRuns.filter((t) => !convIds.includes(t.conversation_id));
    },

    // ---------------------------------------------------------------- sessions
    async createSession({ tokenHash, userId, expiresAt }) {
      const row = { token_hash: tokenHash, user_id: userId, created_at: nowIso(), expires_at: expiresAt, last_seen_at: nowIso() };
      db.sessions.push(row);
      return { ...row };
    },
    async getSession(tokenHash) {
      const s = db.sessions.find((x) => x.token_hash === tokenHash);
      return s ? { ...s } : null;
    },
    async touchSession(tokenHash, at = nowIso()) {
      const s = db.sessions.find((x) => x.token_hash === tokenHash);
      if (s) s.last_seen_at = at;
    },
    async deleteSession(tokenHash) {
      db.sessions = db.sessions.filter((s) => s.token_hash !== tokenHash);
    },
    async deleteExpiredSessions(now = nowIso()) {
      db.sessions = db.sessions.filter((s) => s.expires_at > now);
    },

    // ---------------------------------------------------------------- providers
    async listProviders(userId) {
      return db.providers.filter((p) => p.user_id === userId).map((p) => ({ ...p }));
    },
    async getProvider(userId, id) {
      const p = db.providers.find((x) => x.user_id === userId && x.id === id);
      return p ? { ...p } : null;
    },
    async createProvider({ userId, kind, label, baseUrl = null, apiKeyEnc, keyHint = null, models = null }) {
      const row = { id: randomUUID(), user_id: userId, kind, label, base_url: baseUrl, api_key_enc: apiKeyEnc, key_hint: keyHint, models: models ?? null, created_at: nowIso(), updated_at: nowIso() };
      db.providers.push(row);
      return { ...row };
    },
    async updateProvider(userId, id, patch) {
      const p = db.providers.find((x) => x.user_id === userId && x.id === id);
      if (!p) return null;
      Object.assign(p, patch, { updated_at: nowIso() });
      return { ...p };
    },
    async deleteProvider(userId, id) {
      db.providers = db.providers.filter((p) => !(p.user_id === userId && p.id === id));
    },

    // ---------------------------------------------------------------- conversations
    async listConversations(userId) {
      return db.conversations.filter((c) => c.user_id === userId)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).map((c) => ({ ...c }));
    },
    async getConversation(userId, id) {
      const c = db.conversations.find((x) => x.user_id === userId && x.id === id);
      return c ? { ...c } : null;
    },
    async createConversation(userId, fields = {}) {
      const row = {
        id: randomUUID(), user_id: userId, title: fields.title ?? 'Percakapan baru',
        provider_id: fields.providerId ?? null, model: fields.model ?? null, effort: fields.effort ?? null,
        model_auto: fields.modelAuto ?? false, effort_auto: fields.effortAuto ?? false,
        model_tiers: fields.modelTiers ?? null, browsing: fields.browsing ?? false,
        created_at: nowIso(), updated_at: nowIso(),
      };
      db.conversations.push(row);
      return { ...row };
    },
    async updateConversation(userId, id, patch) {
      const c = db.conversations.find((x) => x.user_id === userId && x.id === id);
      if (!c) return null;
      Object.assign(c, patch, { updated_at: nowIso() });
      return { ...c };
    },
    async deleteConversation(userId, id) {
      const convIds = [id];
      db.conversations = db.conversations.filter((c) => !(c.user_id === userId && c.id === id));
      const msgIds = db.messages.filter((m) => convIds.includes(m.conversation_id)).map((m) => m.id);
      db.messages = db.messages.filter((m) => !convIds.includes(m.conversation_id));
      db.citations = db.citations.filter((c) => !msgIds.includes(c.message_id));
      db.toolRuns = db.toolRuns.filter((t) => !convIds.includes(t.conversation_id));
    },

    // ---------------------------------------------------------------- messages
    async listMessages(userId, conversationId) {
      const owned = db.conversations.some((c) => c.user_id === userId && c.id === conversationId);
      if (!owned) return [];
      return db.messages.filter((m) => m.conversation_id === conversationId)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).map((m) => ({ ...m }));
    },
    async addMessage(userId, conversationId, { role, content, meta = null }) {
      const c = db.conversations.find((x) => x.user_id === userId && x.id === conversationId);
      if (!c) return null;
      const row = { id: randomUUID(), conversation_id: conversationId, role, content, meta, created_at: nowIso() };
      db.messages.push(row);
      c.updated_at = nowIso();
      return { ...row };
    },
    async deleteMessage(userId, conversationId, messageId) {
      const owned = db.conversations.some((c) => c.user_id === userId && c.id === conversationId);
      if (!owned) return;
      db.messages = db.messages.filter((m) => !(m.id === messageId && m.conversation_id === conversationId));
    },

    // ---------------------------------------------------------------- citations
    async addCitations(userId, messageId, list) {
      const rows = list.map((cite, i) => ({
        id: randomUUID(), message_id: messageId, idx: cite.idx ?? i + 1,
        title: cite.title ?? null, url: cite.url, snippet: cite.snippet ?? null, created_at: nowIso(),
      }));
      db.citations.push(...rows);
      return rows.map((r) => ({ ...r }));
    },
    async listCitations(userId, conversationId) {
      const owned = db.conversations.some((c) => c.user_id === userId && c.id === conversationId);
      if (!owned) return [];
      const msgIds = db.messages.filter((m) => m.conversation_id === conversationId).map((m) => m.id);
      return db.citations.filter((c) => msgIds.includes(c.message_id))
        .sort((a, b) => a.idx - b.idx).map((c) => ({ ...c }));
    },

    // ---------------------------------------------------------------- tool runs
    async addToolRun(userId, conversationId, { messageId = null, tool, input = null, status = 'ok', error = null }) {
      const owned = db.conversations.some((c) => c.user_id === userId && c.id === conversationId);
      if (!owned) return null;
      const row = { id: randomUUID(), conversation_id: conversationId, message_id: messageId, tool, input, status, error, created_at: nowIso() };
      db.toolRuns.push(row);
      return { ...row };
    },
    async countToolRuns(userId, conversationId, tool = null) {
      const owned = db.conversations.some((c) => c.user_id === userId && c.id === conversationId);
      if (!owned) return 0;
      return db.toolRuns.filter((t) => t.conversation_id === conversationId && (tool == null || t.tool === tool)).length;
    },
    /** Retensi: buang jejak tool run yang lebih lama dari cutoff (audit terbatas, bukan arsip permanen). */
    async deleteOldToolRuns(before) {
      db.toolRuns = db.toolRuns.filter((t) => t.created_at >= before);
    },
  };
}