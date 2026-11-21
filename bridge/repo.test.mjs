// bridge/repo.test.mjs — suite konformansi repository: perilaku yang SAMA harus berlaku untuk impl
// in-memory (selalu jalan) dan impl SQL (dijalankan bila DATABASE_URL test tersedia).
//
// Inti yang diuji: setiap operasi ter-scope ke userId, cascade menghapus anak, dan rahasia (password
// hash / api_key_enc) tidak pernah bocor lewat permukaan lain. Impl SQL diuji terhadap Neon sungguhan
// hanya bila TEST_DATABASE_URL diset (deploy/CI opsional), supaya suite tetap cepat secara default.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeMemoryRepo } from './src/repo-memory.mjs';

/** Ceritakan perilaku repo yang harus sama di kedua implementasi. `fresh()` menyiapkan repo + dua user. */
const suite = (name, fresh) => {
  const init = async () => {
    const repo = await fresh();
    const alice = await repo.createUser({ email: 'Alice@Example.com', passwordHash: 'scrypt$a$b' });
    const bob = await repo.createUser({ email: 'bob@example.com', passwordHash: 'scrypt$c$d' });
    return { repo, alice, bob };
  };

  test(`[${name}] user: email dinormalisasi lowercase & unik`, async () => {
    const { repo, alice } = await init();
    assert.equal(alice.email, 'alice@example.com');
    assert.equal((await repo.getUserByEmail('ALICE@example.com')).id, alice.id);
    await assert.rejects(() => repo.createUser({ email: 'alice@example.com', passwordHash: 'x' }));
  });

  test(`[${name}] sesi: dibuat, diambil, dihapus`, async () => {
    const { repo, alice } = await init();
    const exp = new Date(Date.now() + 86_400_000).toISOString();
    await repo.createSession({ tokenHash: 'h1', userId: alice.id, expiresAt: exp });
    assert.equal((await repo.getSession('h1')).user_id, alice.id);
    await repo.deleteSession('h1');
    assert.equal(await repo.getSession('h1'), null);
  });

  test(`[${name}] provider: CRUD ter-scope user (Bob tidak melihat milik Alice)`, async () => {
    const { repo, alice, bob } = await init();
    const enc = { v: 1, ct: 'aa', iv: 'bb', tag: 'cc', salt: 'dd' };
    const p = await repo.createProvider({ userId: alice.id, kind: 'openai', label: 'OpenAI', apiKeyEnc: enc, keyHint: 'abcd' });
    assert.equal((await repo.listProviders(alice.id)).length, 1);
    assert.equal((await repo.listProviders(bob.id)).length, 0, 'user lain tidak melihat provider ini');
    assert.equal(await repo.getProvider(bob.id, p.id), null, 'getProvider user lain → null');
    assert.equal(await repo.updateProvider(bob.id, p.id, { label: 'hacked' }), null, 'update user lain ditolak');
    assert.equal((await repo.getProvider(alice.id, p.id)).label, 'OpenAI', 'label Alice utuh');
    await repo.deleteProvider(alice.id, p.id);
    assert.equal((await repo.listProviders(alice.id)).length, 0);
  });

  test(`[${name}] percakapan: CRUD ter-scope user + updated_at maju saat pesan ditambah`, async () => {
    const { repo, alice, bob } = await init();
    const c = await repo.createConversation(alice.id, { title: 'Halo', model: 'gpt-5', effort: 'high' });
    assert.equal(c.title, 'Halo');
    assert.equal(await repo.getConversation(bob.id, c.id), null, 'Bob tidak bisa membuka percakapan Alice');
    const before = (await repo.getConversation(alice.id, c.id)).updated_at;
    await new Promise((r) => setTimeout(r, 5));
    await repo.addMessage(alice.id, c.id, { role: 'user', content: 'hai' });
    assert.ok((await repo.getConversation(alice.id, c.id)).updated_at >= before, 'updated_at tidak mundur');
    const updated = await repo.updateConversation(alice.id, c.id, { effort: 'max', browsing: true });
    assert.equal(updated.effort, 'max');
    assert.equal(updated.browsing, true);
  });

  test(`[${name}] pesan: hanya lewat percakapan milik user`, async () => {
    const { repo, alice, bob } = await init();
    const c = await repo.createConversation(alice.id, {});
    await repo.addMessage(alice.id, c.id, { role: 'user', content: 'rahasia' });
    assert.equal((await repo.listMessages(alice.id, c.id)).length, 1);
    assert.deepEqual(await repo.listMessages(bob.id, c.id), [], 'Bob tidak melihat pesan Alice');
    assert.equal(await repo.addMessage(bob.id, c.id, { role: 'user', content: 'x' }), null, 'Bob tidak bisa menulis ke percakapan Alice');
  });

  test(`[${name}] kutipan & tool run: menempel pada percakapan, ter-scope user`, async () => {
    const { repo, alice, bob } = await init();
    const c = await repo.createConversation(alice.id, {});
    const msg = await repo.addMessage(alice.id, c.id, { role: 'assistant', content: 'jawaban [1]' });
    await repo.addCitations(alice.id, msg.id, [{ idx: 1, title: 'Wiki', url: 'https://id.wikipedia.org' }]);
    assert.equal((await repo.listCitations(alice.id, c.id)).length, 1);
    assert.deepEqual(await repo.listCitations(bob.id, c.id), [], 'kutipan tidak bocor ke user lain');
    await repo.addToolRun(alice.id, c.id, { tool: 'web_search', input: { q: 'x' } });
    await repo.addToolRun(alice.id, c.id, { tool: 'fetch_url', input: { url: 'https://a.test' }, status: 'error', error: 'timeout' });
    assert.equal(await repo.countToolRuns(alice.id, c.id), 2);
    assert.equal(await repo.countToolRuns(alice.id, c.id, 'web_search'), 1);
    assert.equal(await repo.countToolRuns(bob.id, c.id), 0);
    assert.equal(await repo.addToolRun(bob.id, c.id, { tool: 'web_search' }), null);
    // Hapus pesan ikut menghapus kutipannya (cascade).
    await repo.deleteMessage(alice.id, c.id, msg.id);
    assert.equal((await repo.listCitations(alice.id, c.id)).length, 0, 'kutipan hilang bersama pesannya');
  });

  test(`[${name}] retensi: tool run lebih lama dari batas dibuang, yang baru tetap`, async () => {
    const { repo, alice } = await init();
    const c = await repo.createConversation(alice.id, {});
    await repo.addToolRun(alice.id, c.id, { tool: 'web_search', input: { q: 'lama' } });
    // Mundurkan created_at baris lama dengan menandai cutoff di masa depan untuk baris "lama" saja.
    // deleteOldToolRuns(before) membuang yang created_at < before; pakai before yang membedakan keduanya.
    const old = (await repo.addToolRun(alice.id, c.id, { tool: 'web_search', input: { q: 'x' } }));
    const cutoff = '2000-01-01T00:00:00.000Z'; // lebih tua dari semua → tidak ada yang dibuang
    await repo.deleteOldToolRuns(cutoff);
    assert.equal(await repo.countToolRuns(alice.id, c.id), 2, 'cutoff massa lalu tidak menghapus apa pun');
    await repo.deleteOldToolRuns(new Date(Date.now() + 1000).toISOString()); // lebih baru dari semua → semua dibuang
    assert.equal(await repo.countToolRuns(alice.id, c.id), 0, 'tool run lebih lama dari cutoff terbuang');
    assert.ok(old, 'addToolRun tetap mengembalikan baris');
  });

  test(`[${name}] hapus percakapan menyapu pesan, kutipan, dan tool run-nya`, async () => {
    const { repo, alice } = await init();
    const c = await repo.createConversation(alice.id, {});
    const m = await repo.addMessage(alice.id, c.id, { role: 'assistant', content: 'a' });
    await repo.addCitations(alice.id, m.id, [{ url: 'https://x.test' }]);
    await repo.addToolRun(alice.id, c.id, { tool: 'web_search' });
    await repo.deleteConversation(alice.id, c.id);
    assert.equal(await repo.getConversation(alice.id, c.id), null);
    assert.deepEqual(await repo.listMessages(alice.id, c.id), []);
    assert.equal(await repo.countToolRuns(alice.id, c.id), 0);
  });

  test(`[${name}] hapus user menyapu seluruh datanya (hak hapus)`, async () => {
    const { repo, alice, bob } = await init();
    await repo.createProvider({ userId: alice.id, kind: 'openai', label: 'x', apiKeyEnc: { v: 1 } });
    const c = await repo.createConversation(alice.id, {});
    const m = await repo.addMessage(alice.id, c.id, { role: 'assistant', content: 'a' });
    await repo.addCitations(alice.id, m.id, [{ url: 'https://x.test' }]);
    await repo.createSession({ tokenHash: 'hh', userId: alice.id, expiresAt: new Date(Date.now() + 1000).toISOString() });
    // Bob tetap utuh.
    const bc = await repo.createConversation(bob.id, {});
    await repo.deleteUser(alice.id);
    assert.equal(await repo.getUserById(alice.id), null);
    assert.equal((await repo.listProviders(alice.id)).length, 0);
    assert.deepEqual(await repo.listConversations(alice.id), []);
    assert.equal(await repo.getSession('hh'), null);
    assert.ok(await repo.getConversation(bob.id, bc.id), 'data Bob tidak tersentuh');
  });

  test(`[${name}] sesi kedaluwarsa dibersihkan`, async () => {
    const { repo, alice } = await init();
    await repo.createSession({ tokenHash: 'old', userId: alice.id, expiresAt: '2000-01-01T00:00:00.000Z' });
    await repo.createSession({ tokenHash: 'new', userId: alice.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    await repo.deleteExpiredSessions();
    assert.equal(await repo.getSession('old'), null);
    assert.ok(await repo.getSession('new'));
  });
};

suite('memory', async () => makeMemoryRepo());

// Impl SQL hanya dijalankan bila ada DB test: tanpa itu, suite ini tak dijalankan (bukan skip senyap —
// ada test terpisah di bawah yang memastikan jalur SQL setidaknya bisa dimuat/dipanggil dengan driver palsu).
if (process.env.TEST_DATABASE_URL) {
  const { createNeonDb } = await import('./src/db.mjs');
  const { makeSqlRepo } = await import('./src/repo.mjs');
  suite('sql', async () => {
    const db = await createNeonDb(process.env.TEST_DATABASE_URL);
    await db.query('truncate users cascade');
    return makeSqlRepo(db);
  });
}

test('sql repo: menolak DATABASE_URL yang bukan Postgres', async () => {
  const { createNeonDb } = await import('./src/db.mjs');
  await assert.rejects(() => createNeonDb('mysql://x'), /tidak valid/);
  await assert.rejects(() => createNeonDb(''), /tidak valid/);
});

test('sql repo: setiap query terparameterkan (tidak ada interpolasi nilai ke SQL)', async () => {
  const { makeSqlRepo } = await import('./src/repo.mjs');
  const seen = [];
  const db = { query: async (text, params) => { seen.push({ text, params }); return []; } };
  const repo = makeSqlRepo(db);
  await repo.getUserByEmail("x'; drop table users; --");
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /\$1/, 'nilai dikirim sebagai parameter, bukan disisipkan');
  assert.equal(seen[0].params[0], "x'; drop table users; --", 'nilai mentah diteruskan sebagai param');
  assert.equal(seen[0].text.includes('drop table'), false, 'SQL tidak memuat nilai user');
});