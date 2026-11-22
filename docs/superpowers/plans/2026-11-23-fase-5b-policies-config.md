# Fase 5b — Policies dan Config Lanjutan OpenCode

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mengelola **Policies hard-deny** OpenCode dan **config lanjutan** (compaction, warming, snapshots, watcher, formatter, media, tool_output, experimental.*, headers/body provider) dari form editor, tanpa terminal.

**Architecture:** Dua modul murni baru memegang aturan: `src/opencode-policies.js` (view + merge `policies`) dan `src/opencode-advanced.js` (view + merge config lanjutan + `providers.*.headers/body`). `src/opencode-config.js` memanggil keduanya di `readOpenCodeConfig`/`mergeForm`; UI menambah tiga bagian di `#oc-form-panel` memakai kelas yang sudah ada. Tab JSON tetap jalur universal untuk bentuk yang tidak didukung form.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, UI statis.

**Spec:** `docs/superpowers/specs/2026-11-22-adopsi-tuntas-mesin-design.md` (Fase 5, baris 112–117)

## Global Constraints

- OpenCode terpasang **2.3.2**; bentuk field dari https://opencode.ai/docs/config. Policies: `[{ action, resource, effect }]`, `effect` hanya `allow`/`deny`, urutan dipertahankan (last match wins), action: `provider.use`, `tool.use`, `integration.connect`, `integration.use`, `mcp.use`, `skill.use`, `plugin.use`, `websearch.use` (nama lain yang sah diterima dengan pola `^[a-z][a-z0-9._-]{0,63}$`).
- Config lanjutan yang diedit: `snapshots` (boolean), `watcher.ignore` (string[]), `formatter` (boolean; bentuk objek dibiarkan lewat tab JSON), `media.image` (`auto_resize`, `max_width`, `max_height`, `max_base64_bytes`), `tool_output` (`max_lines`, `max_bytes`), `compaction` (`auto`, `keep.tokens`, `buffer`), `warming` (`prompt`, `interval`, `duration`; `true` = aktif bawaan), `experimental` (`todo`, `subagent_depth`, `image_generate.model`, `location_idle_timeout`), `providers.<id>.headers` dan `providers.<id>.body` (objek JSON).
- Nilai kosong/tri-state **inherit** tidak menulis kunci; kunci asing di setiap objek dipertahankan. Batas: policies maks 100 (resource 1–500, tanpa karakter kontrol), `watcher.ignore` maks 100 (entri ≤500), angka media/tool_output 0–10.000.000 (integer), `subagent_depth` 0–5, `buffer` ≤20 karakter (`15%` atau angka), `warming.prompt` ≤500, interval/duration ≤40, model image ≤200.
- Teks UI Bahasa Indonesia, komentar kode Inggris, tanpa kata "mesin" di string UI.
- Tab JSON tetap ada; form tidak boleh menghapus bentuk yang tidak bisa direpresentasikannya (mis. `formatter` objek) — biarkan apa adanya bila tidak disentuh.

## Review Focus

1. **Policies hanya mengetatkan** — `effect` selain `allow`/`deny` ditolak 400; urutan statement dipertahankan; statement dengan field asing tidak kehilangan field itu saat disimpan ulang.
2. **Tri-state inherit tidak menghapus config** — membuka form lalu menyimpan tanpa mengubah bagian lanjutan tidak boleh menambah/menghapus `snapshots`, `warming`, `compaction`, `media`, `tool_output`, `experimental`, atau `formatter` objek.
3. **Angka & batas** — nilai bukan angka, negatif, pecahan, atau di luar batas ditolak 400; string kosong menghapus field, bukan menulis 0/NaN.
4. **JSON provider aman** — `headers`/`body` yang bukan objek JSON ditolak 400; provider id tak dikenal tidak menambah provider baru; kunci provider/model lain tetap utuh.
5. **Bentuk objek yang tidak didukung tidak hilang** — `formatter` objek, `warming` objek dengan kunci asing, `media.image` kunci tambahan, `experimental.image_generate` kunci lain, dan `providers.<id>` lain (package/env/models) tidak berubah saat form disimpan.

---

## File Structure

- Create: `src/opencode-policies.js`, `src/opencode-advanced.js`
- Modify: `src/opencode-config.js` (import + view + merge wiring)
- Modify: `public/js/features/opencode-config.js`, `public/index.html`
- Test: `test/opencode-policies.test.mjs`, `test/opencode-advanced.test.mjs`, `test/opencode-config.test.mjs`, `test/opencode-config-ui.test.mjs`
- Docs: `CHANGELOG.md`, `docs/FITUR.md`, `docs/design-opencode.md`, `docs/uji-ui.md`

---

### Task 1: Policies (view + merge)

**Files:**
- Create: `src/opencode-policies.js`
- Test: `test/opencode-policies.test.mjs`

**Interfaces:**
- Produces:
  - `POLICY_ACTIONS = ['provider.use','tool.use','integration.connect','integration.use','mcp.use','skill.use','plugin.use','websearch.use']`
  - `POLICY_LIMITS = { count: 100, action: 64, resource: 500 }`
  - `policiesView(config) -> [{ action, resource, effect }]`
  - `mergePolicies(config, items) -> void` (mutates `config.policies`; empty → delete)

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergePolicies, policiesView } from '../src/opencode-policies.js';

test('policiesView: hanya statement berbentuk benar, urutan dipertahankan', () => {
  const view = policiesView({ policies: [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'tool.use', resource: 'shell:git push *', effect: 'allow' },
    { action: 'x', resource: 'y' },
    'bukan objek',
  ] });
  assert.deepEqual(view, [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'tool.use', resource: 'shell:git push *', effect: 'allow' },
  ]);
  assert.deepEqual(policiesView({}), []);
});

test('mergePolicies: urutan, validasi effect/action/resource, field asing dipertahankan', () => {
  const base = { theme: 'x', policies: [{ action: 'tool.use', resource: 'shell:rm *', effect: 'deny', note: 'dari admin' }] };
  mergePolicies(base, [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'tool.use', resource: 'shell:rm *', effect: 'deny' },
  ]);
  assert.deepEqual(base.policies, [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'tool.use', resource: 'shell:rm *', effect: 'deny', note: 'dari admin' },
  ]);
  mergePolicies(base, []);
  assert.equal('policies' in base, false);
  for (const bad of [
    [{ action: 'provider.use', resource: '*', effect: 'ask' }],
    [{ action: 'Bad Action', resource: '*', effect: 'deny' }],
    [{ action: 'tool.use', resource: '', effect: 'deny' }],
    [{ action: 'tool.use', resource: 'a\nb', effect: 'deny' }],
    [{ action: 'tool.use', resource: 'x'.repeat(501), effect: 'deny' }],
    Array.from({ length: 101 }, () => ({ action: 'tool.use', resource: 'x', effect: 'deny' })),
    'x',
  ]) {
    assert.throws(() => mergePolicies({}, bad), (e) => e.status === 400, JSON.stringify(bad).slice(0, 80));
  }
});
```

- [ ] **Step 2: Run to fail** — `node --test test/opencode-policies.test.mjs`.
- [ ] **Step 3: Implement** `src/opencode-policies.js` with an `OpenCodePolicyError` (status 400) carrying Indonesian messages; entries matched to the old list by `action + '\\u0000' + resource` so unknown keys survive; `policies` non-array in config → throw 400.
- [ ] **Step 4: Run to pass**.
- [ ] **Step 5: Commit** — `git commit -m "OpenCode policies: daftar hard-deny dan validasi statement"`.

---

### Task 2: Config lanjutan (view + merge)

**Files:**
- Create: `src/opencode-advanced.js`
- Test: `test/opencode-advanced.test.mjs`

**Interfaces:**
- Produces:
  - `advancedView(config) -> { snapshots, watcherIgnore, formatter, mediaImage, toolOutput, compaction, warming, experimental, providers }`
  - `mergeAdvanced(config, form) -> void`
  - Bentuk: `snapshots`/`formatter`/`compaction.auto`/`experimental.todo`/`mediaImage.auto_resize`/`warming.enabled` = `'inherit'|'on'|'off'`; angka = string; `watcherIgnore` = string[]; `providers` = `[{ id, headers, body }]` (headers/body = teks JSON atau `''`).

- [ ] **Step 1: Write the failing test**

```js
test('advancedView: bentuk form, tri-state, dan provider headers/body', () => {
  const view = advancedView({
    snapshots: false,
    watcher: { ignore: ['dist/**'] },
    formatter: true,
    media: { image: { auto_resize: false, max_width: 1000 } },
    tool_output: { max_lines: 100 },
    compaction: { auto: true, keep: { tokens: 5000 }, buffer: '15%' },
    warming: { prompt: 'OK', interval: 'auto' },
    experimental: { todo: true, subagent_depth: 2, image_generate: { model: 'openai/gpt-image-2' }, location_idle_timeout: false },
    providers: { openai: { headers: { 'X-A': '1' }, body: { temperature: 0 }, models: {} } },
  });
  assert.equal(view.snapshots, 'off');
  assert.equal(view.formatter, 'on');
  assert.deepEqual(view.watcherIgnore, ['dist/**']);
  assert.equal(view.mediaImage.max_width, 1000);
  assert.equal(view.compaction.auto, 'on');
  assert.equal(view.compaction.keepTokens, 5000);
  assert.equal(view.warming.enabled, 'on');
  assert.equal(view.experimental.todo, 'on');
  assert.equal(view.experimental.locationIdleTimeout, 'false');
  assert.deepEqual(view.providers, [{ id: 'openai', headers: '{"X-A":"1"}', body: '{"temperature":0}' }]);
});

test('mergeAdvanced: inherit tidak menyentuh, angka divalidasi, kunci asing aman', () => {
  const base = {
    snapshots: false,
    formatter: { prettier: { command: ['prettier'] } },
    media: { image: { auto_resize: false, extra: 1 } },
    tool_output: { max_lines: 100, extra: 2 },
    compaction: { auto: true, keep: { tokens: 5000, extra: 3 }, buffer: '15%', extra: 4 },
    warming: { prompt: 'OK', extra: 5 },
    experimental: { todo: true, image_generate: { model: 'x', extra: 6 }, extra: 7 },
    providers: { openai: { headers: { A: '1' }, models: { m: {} }, package: 'pkg' }, lain: { models: {} } },
  };
  mergeAdvanced(base, { snapshots: 'inherit', formatter: 'inherit', mediaImage: { auto_resize: 'inherit', maxWidth: '', maxHeight: '', maxBase64Bytes: '' }, toolOutput: { maxLines: '', maxBytes: '' }, compaction: { auto: 'inherit', keepTokens: '', buffer: '' }, warming: { enabled: 'inherit', prompt: '', interval: '', duration: '' }, experimental: { todo: 'inherit', subagentDepth: '', imageModel: '', locationIdleTimeout: '' }, watcherIgnore: [], providers: [] });
  assert.deepEqual(base.snapshots, false);
  assert.deepEqual(Object.keys(base.formatter), ['prettier']);
  assert.equal(base.media.image.extra, 1);
  assert.equal(base.compaction.keep.extra, 3);
  assert.equal(base.experimental.image_generate.extra, 6);
  assert.deepEqual(base.providers.openai.models, { m: {} });
  assert.equal(base.providers.openai.package, 'pkg');
  assert.ok('lain' in base.providers);

  mergeAdvanced(base, { snapshots: 'on', formatter: 'off', mediaImage: { auto_resize: 'off', maxWidth: '1500', maxHeight: '0', maxBase64Bytes: '' }, toolOutput: { maxLines: '50', maxBytes: '1000' }, compaction: { auto: 'off', keepTokens: '100', buffer: '10%' }, warming: { enabled: 'on', prompt: 'Hi', interval: 'auto', duration: '30 minutes' }, experimental: { todo: 'on', subagentDepth: '2', imageModel: 'openai/gpt-image-2', locationIdleTimeout: 'false' }, watcherIgnore: ['dist/**', 'dist/**', ' coverage/** '], providers: [{ id: 'openai', headers: '{"X-A":"2"}', body: '' }] });
  assert.equal(base.snapshots, true);
  assert.equal(base.formatter, false);
  assert.deepEqual(base.media.image, { auto_resize: false, max_width: 1500, max_height: 0, extra: 1 });
  assert.deepEqual(base.tool_output, { max_lines: 50, max_bytes: 1000, extra: 2 });
  assert.deepEqual(base.compaction, { auto: false, keep: { tokens: 100, extra: 3 }, buffer: '10%', extra: 4 });
  assert.deepEqual(base.warming, { prompt: 'Hi', interval: 'auto', duration: '30 minutes', extra: 5 });
  assert.deepEqual(base.watcher, { ignore: ['dist/**', 'coverage/**'] });
  assert.equal(base.experimental.todo, true);
  assert.equal(base.experimental.subagent_depth, 2);
  assert.equal(base.experimental.image_generate.extra, 6);
  assert.equal(base.experimental.location_idle_timeout, false);
  assert.equal(base.providers.openai.headers['X-A'], '2');
  assert.equal('body' in base.providers.openai, false);
  for (const bad of [
    { toolOutput: { maxLines: '-1' } },
    { toolOutput: { maxLines: '1.5' } },
    { mediaImage: { maxWidth: '99999999' } },
    { experimental: { subagentDepth: '6' } },
    { compaction: { buffer: 'x'.repeat(21) } },
    { providers: [{ id: 'openai', headers: '[1]' }] },
    { providers: [{ id: 'tidak-ada', headers: '{}' }] },
    { watcherIgnore: ['x'.repeat(501)] },
  ]) {
    assert.throws(() => mergeAdvanced(JSON.parse(JSON.stringify(base)), bad), (e) => e.status === 400, JSON.stringify(bad).slice(0, 80));
  }
});
```

- [ ] **Step 2: Run to fail** — module belum ada.
- [ ] **Step 3: Implement** `src/opencode-advanced.js`:
  - Tri-state writer: `inherit` → tidak menyentuh; `on`/`off` → tulis/delete sesuai; objek lama dipertahankan untuk `compaction`, `media.image`, `experimental.image_generate`, `warming`, `providers.<id>`.
  - Angka: string kosong → hapus field; selain itu `Number.isInteger` dan 0..10.000.000 (subagent 0..5); `buffer` string ≤20; `warming` `on` tanpa detail → `true`, dengan detail → objek.
  - `watcherIgnore`: trim, buang kosong, dedupe, maks 100/500; kosong → hapus `watcher` bila tidak ada kunci lain.
  - `providers`: hanya id yang sudah ada; parse JSON headers/body (objek, bukan array); string kosong menghapus kunci itu; provider lain tidak disentuh.
  - `experimental.location_idle_timeout`: `'inherit'`/`''` tidak menyentuh, `'false'` → `false`, teks lain → string ≤40.

- [ ] **Step 4: Run to pass**.
- [ ] **Step 5: Commit** — `git commit -m "OpenCode config: aturan policies dan config lanjutan di form"`.

---

### Task 3: Sambungkan ke `readOpenCodeConfig`/`mergeForm`

**Files:**
- Modify: `src/opencode-config.js`
- Test: `test/opencode-config.test.mjs`

**Interfaces:** view menambah `policies`, `advanced`; `mergeForm` memanggil `mergePolicies`/`mergeAdvanced` hanya bila `form.policies`/`form.advanced` `!== undefined`.

- [ ] **Step 1: Tulis test integrasi** — config view memuat `policies` dan `advanced.snapshots`; `mergeForm` menyimpan `form.policies` dan `form.advanced.toolOutput.maxLines` tanpa menghapus `model`; `mergeForm` tanpa kedua field tidak menyentuh kunci itu.
- [ ] **Step 2: Run to fail**.
- [ ] **Step 3: Implement wiring** (import + objek view + dua panggilan di `mergeForm`).
- [ ] **Step 4: Run to pass** (`node --test test/opencode-config.test.mjs test/opencode-policies.test.mjs test/opencode-advanced.test.mjs`).
- [ ] **Step 5: Commit** — `git commit -m "OpenCode config: sambungkan policies dan config lanjutan ke editor"`.

---

### Task 4: UI policies + config lanjutan + provider

**Files:**
- Modify: `public/js/features/opencode-config.js`, `public/index.html`
- Test: `test/opencode-config-ui.test.mjs`

**Interfaces:** markup di `#oc-form-panel` (dalam `<details class="oc-backups">` agar tidak memenuhi layar):
- Policies: `#oc-policy-list`, `#oc-policy-add`; baris `[data-policy]` dengan `data-policy-action`, `data-policy-resource`, `data-policy-effect`, `[data-policy-remove]`.
- Advanced: `#oc-snapshots`, `#oc-formatter`, `#oc-compaction-auto`, `#oc-compaction-keep`, `#oc-compaction-buffer`, `#oc-warming-enabled`, `#oc-warming-prompt`, `#oc-warming-interval`, `#oc-warming-duration`, `#oc-watcher-ignore`, `#oc-media-autoresize`, `#oc-media-width`, `#oc-media-height`, `#oc-media-base64`, `#oc-output-lines`, `#oc-output-bytes`, `#oc-exp-todo`, `#oc-exp-depth`, `#oc-exp-image`, `#oc-exp-idle`.
- Providers: `#oc-provider-list`; baris `[data-provider-row]` dengan `#`-nya sendiri: `[data-provider-headers]`, `[data-provider-body]`.

- [ ] **Step 1: Tulis test UI** — fake view membawa `policies` + `advanced`; assert baris kebaca; ubah effect, tambah policy, isi max lines/media/warming/experimental/provider headers → POST `form.policies` dan `form.advanced` sesuai; remove semua policy → `policies: []`; simpan tanpa mengubah advanced tidak mengubah nilai (fake memantulkan). Mobile+desktop tanpa overflow.
- [ ] **Step 2: Run to fail**.
- [ ] **Step 3: Implement render + collect + handlers** memakai kelas existing (`oc-agent`, `oc-agent-grid`, `oc-field`, `ghost`, `danger-text`, `oc-agents-head`); select tri-state berisi `inherit`/`on`/`off`; `advanced` dikirim hanya dari tab Form. Teks bantuan menyebut tab JSON untuk `formatter` objek dan field eksperimental bisa berubah.
- [ ] **Step 4: Run to pass** + `node --test test/css-coverage.test.mjs`.
- [ ] **Step 5: Commit** — `git commit -m "OpenCode config: form policies, lanjutan, dan header/body provider"`.

---

### Task 5: Dokumentasi, gerbang, rilis 1.0.92

**Files:** `docs/design-opencode.md`, `CHANGELOG.md`, `docs/FITUR.md`, `docs/uji-ui.md`, `package.json`, `package-lock.json`

- [ ] **Step 1: Catatan upstream** — baris 2.3.2: policies (biner, last match wins, min 2.2.3/2.2.6), semua field config lanjutan + bentuk `buffer`/`warming` tri-state, `providers.<id>.headers/body`; catat bahwa varian model `#variant` sudah didukung.
- [ ] **Step 2: CHANGELOG** — `## Belum dirilis` → **🛡️ Policies OpenCode**, **⚙️ Config lanjutan OpenCode**, **🔌 Header/body provider**; sebut tab JSON tetap ada dan field eksperimental bisa berubah.
- [ ] **Step 3: FITUR + uji-ui** — perluas bullet Config & Agent; sebut policies hard-deny tidak pernah membuat izin lebih longgar.
- [ ] **Step 4: Gerbang** — `npm run check`; `npm run test:related -- src/opencode-policies.js src/opencode-advanced.js src/opencode-config.js public/js/features/opencode-config.js`; `node --test test/opencode-policies.test.mjs test/opencode-advanced.test.mjs test/opencode-config-ui.test.mjs`; 12 smoke file langsung (Windows) / `npm run test:smoke` di CI.
- [ ] **Step 5: Rilis 1.0.92** — bump versi, promosikan CHANGELOG, commit `Rilis 1.0.92: policies dan config lanjutan OpenCode`, tag `v1.0.92`, push, pantau workflow.

---

## Self-Review

**Spec coverage:** Policies → Task 1 + UI Task 4; config lanjutan (compaction, warming, formatter, snapshots, watcher, media, tool_output, experimental.*) → Task 2/4; providers headers/body → Task 2/4; varian model → sudah ada, dicatat Task 5. Plugins/commands/instructions/websearch selesai di 5a.
**Type consistency:** `policiesView/mergePolicies` dan `advancedView/mergeAdvanced` dipakai di wiring Task 3 dan UI Task 4 dengan nama field yang sama (`watcherIgnore`, `toolOutput`, `mediaImage`, `exp...`).
**Review Focus:** lima butir punya test di Task 1 (urutan/field asing/effect), Task 2 (inherit/angka/JSON provider/bentuk objek), Task 3 (undefined tidak menyentuh).
**Proportion:** plan memuat bentuk data, batas, dan test; body implementasi ditulis saat eksekusi.
