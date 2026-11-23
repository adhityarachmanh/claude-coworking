// OpenCode config/agent editor (server: src/opencode-config.js): a form for model + agents, or the raw file text.
// Laptop only (the route is in LOCAL_ONLY). A save validates first and the server keeps the backup in its own data
// folder. Two config files for one project (root + .opencode) are reported by the server and can be consolidated here.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

const editor = {
  scope: 'project',
  mode: 'form',
  view: null,
  busy: false,
  conflictDismissed: false, // "Tutup" on the conflict banner: only for this view, a reload shows it again
  backups: null, // null = not fetched yet
  backupsBusy: false,
  needsReload: false, // a 409 left the editor stale: point at "Muat ulang", never overwrite on our own
};
const previewCache = new Map(); // backup id -> text (backups never change) so Pratinjau does not refetch
const MODES = ['primary', 'subagent', 'all'];
const NOTE_BACKUP =
  'Backup file ini disimpan di folder data aplikasi (bukan <code>.bak</code> di sebelah file) dan bisa dipulihkan dari <b>Riwayat backup</b>. File <code>.bak-*</code> lama tetap muncul di riwayat dengan tanda <b>format lama</b>. Hasil konsolidasi menyimpan file <code>.opencode</code> di folder backup yang sama dengan awalan <code>dot--</code>, untuk pemulihan manual — tidak muncul di Riwayat backup file ini. Project yang punya <code>opencode.json</code> dan <code>.opencode/opencode.json</code> sekaligus juga dideteksi.';

const agentRow = (agent = {}) => {
  const name = agent.name ?? '';
  const mode = MODES.includes(agent.mode) ? agent.mode : '';
  return `<div class="oc-agent" data-agent-row>
    <div class="oc-agent-head"><b>Agent</b><button type="button" class="ghost danger-text" data-agent-remove aria-label="Hapus agent ${escapeHtml(name || 'baru')}">Hapus</button></div>
    <div class="oc-agent-grid">
      <label class="oc-field"><span>Nama</span><input data-agent="name" type="text" maxlength="64" autocomplete="off" spellcheck="false" value="${escapeHtml(name)}" placeholder="reviewer" /></label>
      <label class="oc-field"><span>Mode</span><select data-agent="mode">
        <option value=""${mode ? '' : ' selected'}>bawaan</option>
        <option value="primary"${mode === 'primary' ? ' selected' : ''}>primary</option>
        <option value="subagent"${mode === 'subagent' ? ' selected' : ''}>subagent</option>
        <option value="all"${mode === 'all' ? ' selected' : ''}>all</option>
      </select></label>
      <label class="oc-field"><span>Model</span><input data-agent="model" type="text" maxlength="200" autocomplete="off" spellcheck="false" value="${escapeHtml(agent.model ?? '')}" placeholder="provider/model (opsional)" /></label>
      <label class="oc-field"><span>Deskripsi</span><input data-agent="description" type="text" maxlength="500" autocomplete="off" value="${escapeHtml(agent.description ?? '')}" placeholder="opsional" /></label>
      <label class="oc-field"><span>Langkah maksimal</span><input data-agent="steps" type="number" min="1" max="100" step="1" value="${escapeHtml(agent.steps ?? '')}" placeholder="opsional" /></label>
      <label class="oc-field"><span>Warna</span><input data-agent="color" type="text" maxlength="20" autocomplete="off" spellcheck="false" value="${escapeHtml(agent.color ?? '')}" placeholder="mis. #4f8cff" /></label>
      <label class="oc-field"><span>Sembunyikan dari daftar</span><input data-agent="hidden" type="checkbox"${agent.hidden ? ' checked' : ''} /></label>
      <label class="oc-field"><span>Nonaktif</span><input data-agent="disabled" type="checkbox"${agent.disabled ? ' checked' : ''} /></label>
      <label class="oc-field oc-field-wide"><span>Prompt / system</span><textarea data-agent="prompt" rows="3" maxlength="20000" spellcheck="false" placeholder="Instruksi agent (opsional)">${escapeHtml(agent.prompt ?? '')}</textarea></label>
    </div>
  </div>`;
};

const renderAgents = (agents) => {
  const list = (Array.isArray(agents) ? agents : []).filter((agent) => agent && typeof agent === 'object');
  $('#oc-agent-list').innerHTML = list.length ? list.map(agentRow).join('') : '<p class="muted small">Belum ada agent khusus.</p>';
};

/**
 * One reference row (upstream `references` block): an alias pointing at a local folder or a Git repository. The kind
 * swaps which value fields are visible; alias, description and the hidden flag apply to both.
 */
const referenceRow = (ref = {}) => {
  const name = ref.name ?? '';
  const kind = ref.kind === 'repository' ? 'repository' : 'path';
  const value = (key) => escapeHtml(typeof ref[key] === 'string' ? ref[key] : '');
  const hide = (field) => (field === 'path' ? kind !== 'path' : kind !== 'repository') ? ' hidden' : '';
  return `<div class="oc-agent" data-ref-row>
    <div class="oc-agent-head"><b>Reference</b><button type="button" class="ghost danger-text" data-ref-remove aria-label="Hapus reference ${escapeHtml(name || 'baru')}">Hapus</button></div>
    <div class="oc-agent-grid">
      <label class="oc-field"><span>Alias</span><input data-ref="name" type="text" maxlength="64" autocomplete="off" spellcheck="false" value="${escapeHtml(name)}" placeholder="pustaka" /></label>
      <label class="oc-field"><span>Jenis</span><select data-ref="kind">
        <option value="path"${kind === 'path' ? ' selected' : ''}>folder lokal</option>
        <option value="repository"${kind === 'repository' ? ' selected' : ''}>repository Git</option>
      </select></label>
      <label class="oc-field" data-ref-field="path"${hide('path')}><span>Path</span><input data-ref="path" type="text" maxlength="500" autocomplete="off" spellcheck="false" value="${value('path')}" placeholder="~/pustaka atau C:\\kerja\\pustaka" /></label>
      <label class="oc-field" data-ref-field="repository"${hide('repository')}><span>Repository</span><input data-ref="repository" type="text" maxlength="500" autocomplete="off" spellcheck="false" value="${value('repository')}" placeholder="owner/repo atau URL Git" /></label>
      <label class="oc-field" data-ref-field="branch"${hide('branch')}><span>Cabang</span><input data-ref="branch" type="text" maxlength="200" autocomplete="off" spellcheck="false" value="${value('branch')}" placeholder="main (opsional)" /></label>
      <label class="oc-field"><span>Deskripsi</span><input data-ref="description" type="text" maxlength="500" autocomplete="off" value="${value('description')}" placeholder="opsional" /></label>
      <label class="oc-field"><span>Sembunyikan</span><input data-ref="hidden" type="checkbox"${ref.hidden === true ? ' checked' : ''} /></label>
    </div>
  </div>`;
};

/** Only the value fields of the chosen kind are shown; a hidden field keeps its value but is not offered. */
const syncRefKind = (row) => {
  if (!row) return;
  const kind = row.querySelector('[data-ref="kind"]')?.value === 'repository' ? 'repository' : 'path';
  for (const field of row.querySelectorAll('[data-ref-field]')) {
    const mine = field.dataset.refField;
    field.hidden = mine !== kind && !(kind === 'repository' && mine === 'branch');
  }
};

const renderReferences = (references) => {
  const list = (Array.isArray(references) ? references : []).filter((ref) => ref && typeof ref === 'object');
  $('#oc-reference-list').innerHTML = list.length ? list.map(referenceRow).join('') : '<p class="muted small">Belum ada reference.</p>';
};

const WEBSEARCH_PROVIDERS = [
  ['inherit', 'Bawaan (tidak diatur)'],
  ['off', 'Nonaktif'],
  ['opencode', 'OpenCode Web Search'],
  ['random', 'Acak otomatis'],
  ['exa', 'Exa'],
  ['firecrawl', 'Firecrawl'],
  ['parallel', 'Parallel'],
  ['tavily', 'Tavily'],
  ['tinyfish', 'TinyFish'],
];

const instructionRow = (value = '') => `<div class="oc-agent" data-instruction-row>
  <div class="oc-agent-head"><b>Instruksi</b><button type="button" class="ghost danger-text" data-instruction-remove aria-label="Hapus instruksi">Hapus</button></div>
  <div class="oc-agent-grid">
    <label class="oc-field"><span>Path, glob, atau URL</span><input data-instruction type="text" maxlength="500" autocomplete="off" spellcheck="false" value="${escapeHtml(value)}" placeholder="AGENTS.md, ~/aturan/*.md, https://…" /></label>
  </div>
</div>`;

const renderInstructions = (instructions) => {
  const list = (Array.isArray(instructions) ? instructions : []).filter((item) => typeof item === 'string');
  $('#oc-instruction-list').innerHTML = list.length ? list.map(instructionRow).join('') : '<p class="muted small">Belum ada instruksi tambahan.</p>';
};

const collectInstructions = () =>
  [...document.querySelectorAll('#oc-instruction-list [data-instruction]')].map((input) => input.value.trim()).filter(Boolean);

const skillRow = (value = '') => `<div class="oc-agent" data-skill-row>
  <div class="oc-agent-head"><b>Sumber skill</b><button type="button" class="ghost danger-text" data-skill-remove aria-label="Hapus sumber skill">Hapus</button></div>
  <div class="oc-agent-grid">
    <label class="oc-field"><span>Folder atau katalog HTTP</span><input data-skill type="text" maxlength="500" autocomplete="off" spellcheck="false" value="${escapeHtml(value)}" placeholder="./team-skills, ~/shared/skills, https://…" /></label>
  </div>
</div>`;

const renderSkills = (skills) => {
  const list = (Array.isArray(skills) ? skills : []).filter((item) => typeof item === 'string');
  $('#oc-skill-list').innerHTML = list.length ? list.map(skillRow).join('') : '<p class="muted small">Belum ada sumber skill tambahan.</p>';
};

const collectSkills = () => [...document.querySelectorAll('#oc-skill-list [data-skill]')].map((input) => input.value.trim()).filter(Boolean);

/** The provider the form shows; one the list does not know yet keeps its value instead of being reset. */
const renderWebsearch = (websearch) => {
  const select = $('#oc-websearch');
  if (!select.options.length) select.innerHTML = WEBSEARCH_PROVIDERS.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('');
  const mode = websearch?.mode === 'off' ? 'off' : websearch?.mode === 'provider' ? 'provider' : 'inherit';
  const provider = typeof websearch?.provider === 'string' ? websearch.provider : '';
  if (provider && ![...select.options].some((option) => option.value === provider)) {
    select.append(new Option(provider, provider));
  }
  select.value = mode === 'provider' ? provider : mode;
};

const policyRow = (policy = {}) => `<div class="oc-agent" data-policy-row>
  <div class="oc-agent-head"><b>Policy</b><button type="button" class="ghost danger-text" data-policy-remove aria-label="Hapus policy">Hapus</button></div>
  <div class="oc-agent-grid">
    <label class="oc-field"><span>Action</span><input data-policy-action list="oc-policy-actions" maxlength="64" autocomplete="off" spellcheck="false" value="${escapeHtml(policy.action ?? '')}" placeholder="tool.use" /></label>
    <label class="oc-field"><span>Resource</span><input data-policy-resource maxlength="500" autocomplete="off" spellcheck="false" value="${escapeHtml(policy.resource ?? '')}" placeholder="shell:git push *" /></label>
    <label class="oc-field"><span>Effect</span><select data-policy-effect><option value="allow"${policy.effect !== 'deny' ? ' selected' : ''}>allow</option><option value="deny"${policy.effect === 'deny' ? ' selected' : ''}>deny</option></select></label>
  </div>
</div>`;

const renderPolicies = (policies) => {
  const list = (Array.isArray(policies) ? policies : []).filter((policy) => policy && typeof policy === 'object');
  $('#oc-policy-list').innerHTML = list.length ? list.map(policyRow).join('') : '<p class="muted small">Belum ada policy.</p>';
};

const collectPolicies = () =>
  [...document.querySelectorAll('#oc-policy-list .oc-agent')]
    .map((row) => ({
      action: row.querySelector('[data-policy-action]')?.value.trim() ?? '',
      resource: row.querySelector('[data-policy-resource]')?.value.trim() ?? '',
      effect: row.querySelector('[data-policy-effect]')?.value === 'deny' ? 'deny' : 'allow',
    }))
    .filter((policy) => policy.action || policy.resource);

const watcherRow = (value = '') => `<div class="oc-agent" data-watcher-row>
  <div class="oc-agent-head"><b>Pola</b><button type="button" class="ghost danger-text" data-watcher-remove aria-label="Hapus pola">Hapus</button></div>
  <div class="oc-agent-grid"><label class="oc-field"><span>Pola file/folder</span><input data-watcher-ignore maxlength="500" autocomplete="off" spellcheck="false" value="${escapeHtml(value)}" placeholder="dist/**" /></label></div>
</div>`;

const renderWatchers = (ignore) => {
  const list = (Array.isArray(ignore) ? ignore : []).filter((item) => typeof item === 'string');
  $('#oc-watcher-list').innerHTML = list.length ? list.map(watcherRow).join('') : '<p class="muted small">Belum ada pola.</p>';
};

const collectWatchers = () => [...document.querySelectorAll('#oc-watcher-list [data-watcher-ignore]')].map((input) => input.value.trim()).filter(Boolean);

const providerRow = (provider) => `<div class="oc-agent" data-provider-row="${escapeHtml(provider.id)}">
  <div class="oc-agent-head"><b>${escapeHtml(provider.id)}</b></div>
  <label class="oc-field"><span>Headers (JSON objek)</span><textarea data-provider-headers class="memory-text" rows="2" spellcheck="false" placeholder='{"X-Custom":"1"}'>${escapeHtml(provider.headers ?? '')}</textarea></label>
  <label class="oc-field"><span>Body (JSON objek)</span><textarea data-provider-body class="memory-text" rows="2" spellcheck="false" placeholder='{"temperature":0}'>${escapeHtml(provider.body ?? '')}</textarea></label>
</div>`;

const renderProviders = (providers) => {
  const list = (Array.isArray(providers) ? providers : []).filter((provider) => provider && typeof provider.id === 'string');
  $('#oc-provider-list').innerHTML = list.length ? list.map(providerRow).join('') : '<p class="muted small">Belum ada provider dengan headers/body.</p>';
};

const collectProviders = () =>
  [...document.querySelectorAll('#oc-provider-list [data-provider-row]')].map((row) => ({
    id: row.dataset.providerRow,
    headers: row.querySelector('[data-provider-headers]')?.value ?? '',
    body: row.querySelector('[data-provider-body]')?.value ?? '',
  }));

const setField = (id, value, fallback = '') => {
  const field = $(id);
  field.value = value == null || value === '' ? fallback : String(value);
};

const renderAdvanced = (advanced) => {
  const a = advanced ?? {};
  setField('#oc-snapshots', a.snapshots, 'inherit');
  setField('#oc-formatter', a.formatter, 'inherit');
  setField('#oc-compaction-auto', a.compaction?.auto, 'inherit');
  setField('#oc-compaction-background', a.compaction?.background, 'inherit');
  setField('#oc-compaction-keep', a.compaction?.keepTokens);
  setField('#oc-compaction-buffer', a.compaction?.buffer);
  setField('#oc-warming-enabled', a.warming?.enabled, 'inherit');
  setField('#oc-warming-prompt', a.warming?.prompt);
  setField('#oc-warming-interval', a.warming?.interval);
  setField('#oc-warming-duration', a.warming?.duration);
  setField('#oc-media-autoresize', a.mediaImage?.auto_resize, 'inherit');
  setField('#oc-media-width', a.mediaImage?.maxWidth);
  setField('#oc-media-height', a.mediaImage?.maxHeight);
  setField('#oc-media-base64', a.mediaImage?.maxBase64Bytes);
  setField('#oc-output-lines', a.toolOutput?.maxLines);
  setField('#oc-output-bytes', a.toolOutput?.maxBytes);
  setField('#oc-exp-todo', a.experimental?.todo, 'inherit');
  setField('#oc-exp-depth', a.experimental?.subagentDepth);
  setField('#oc-exp-image', a.experimental?.imageModel);
  setField('#oc-exp-idle', a.experimental?.locationIdleTimeout);
  renderWatchers(a.watcherIgnore);
  renderProviders(a.providers);
};

const collectAdvanced = () => ({
  snapshots: $('#oc-snapshots').value,
  formatter: $('#oc-formatter').value,
  watcherIgnore: collectWatchers(),
  mediaImage: {
    auto_resize: $('#oc-media-autoresize').value,
    maxWidth: $('#oc-media-width').value,
    maxHeight: $('#oc-media-height').value,
    maxBase64Bytes: $('#oc-media-base64').value,
  },
  toolOutput: { maxLines: $('#oc-output-lines').value, maxBytes: $('#oc-output-bytes').value },
  compaction: { auto: $('#oc-compaction-auto').value, background: $('#oc-compaction-background').value, keepTokens: $('#oc-compaction-keep').value, buffer: $('#oc-compaction-buffer').value },
  warming: { enabled: $('#oc-warming-enabled').value, prompt: $('#oc-warming-prompt').value, interval: $('#oc-warming-interval').value, duration: $('#oc-warming-duration').value },
  experimental: { todo: $('#oc-exp-todo').value, subagentDepth: $('#oc-exp-depth').value, imageModel: $('#oc-exp-image').value, locationIdleTimeout: $('#oc-exp-idle').value },
  providers: collectProviders(),
});

const dateOf = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const timeText = (value) => {
  const date = dateOf(value);
  if (!date) return 'waktu tidak diketahui';
  try {
    return date.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return date.toISOString();
  }
};
const kbText = (bytes) => {
  const size = Number(bytes);
  const kb = Number.isFinite(size) && size > 0 ? size / 1024 : 0;
  return `${(kb < 0.1 ? 0.1 : kb).toFixed(1)} KB`;
};
const backupById = (id) => (Array.isArray(editor.backups) ? editor.backups : []).find((b) => b && b.id === id) ?? null;
const backupLocked = (id) => {
  const backup = backupById(id);
  return !backup || backup.valid === false; // an invalid backup cannot be restored
};
const baseName = (file) => String(file).split(/[\\/]/).pop() || String(file);
/** How a source file is named in a sentence: `.opencode/opencode.json` instead of the long absolute path. */
const sourceLabel = (source) => (source?.kind === 'dot-opencode' ? `.opencode/${baseName(source.path)}` : baseName(source?.path ?? ''));

const renderConflict = () => {
  const box = $('#oc-conflict');
  const view = editor.view;
  const conflict = view && !editor.conflictDismissed && view.conflict ? view.conflict : null;
  if (!conflict) {
    box.hidden = true;
    return;
  }
  $('#oc-conflict-message').textContent =
    typeof conflict.message === 'string' && conflict.message ? conflict.message : 'Ada lebih dari satu file config OpenCode untuk project ini.';

  // Paths come from the server: build nodes, never innerHTML. Show the files that exist (the missing ones would only
  // add noise), then fall back to `others` when the server sent no `sources`.
  const sources = Array.isArray(view.sources) ? view.sources.filter((s) => s && typeof s.path === 'string') : [];
  const present = sources.filter((source) => source.exists !== false);
  const others = Array.isArray(conflict.others) ? conflict.others.filter((p) => typeof p === 'string') : [];
  const entries = present.length
    ? present
    : sources.length
      ? sources
      : [...new Set([conflict.effective, ...others].filter((p) => typeof p === 'string'))].map((path) => ({ path }));
  const list = $('#oc-conflict-paths');
  list.replaceChildren();
  for (const source of entries) {
    const li = document.createElement('li');
    if (source.path === conflict.effective) li.className = 'oc-conflict-effective';
    const file = document.createElement('code');
    file.textContent = source.path;
    li.append(file);
    const marks = [];
    if (source.path === view.path) marks.push('diedit di sini');
    if (source.path === conflict.effective) marks.push('dipakai OpenCode');
    if (source.kind === 'legacy') marks.push('format lama');
    if (source.exists === false) marks.push('belum ada');
    if (source.valid === false) marks.push('tidak valid');
    if (marks.length) {
      const note = document.createElement('span');
      note.className = 'muted';
      note.textContent = ` — ${marks.join(', ')}`;
      li.append(note);
    }
    list.append(li);
  }
  list.hidden = !entries.length;

  // The server decides: `consolidatable` is true when there is an existing `.opencode` file and >=2 mergeable sources.
  // `sameFolder` only explains the ignored `.jsonc` in the message, it never hides the button.
  const consolidate = $('#oc-conflict-consolidate');
  consolidate.hidden = editor.scope !== 'project' || view.consolidatable !== true;
  box.hidden = false; // fill it first, then show: the alert is announced with its content
  applyBusy();
};

const renderView = () => {
  const view = editor.view;
  if (!view) return;
  const filePath = typeof view.path === 'string' ? view.path : '';
  const format = typeof view.format === 'string' && view.format ? view.format : 'json';
  $('#oc-config-path').textContent = `${filePath} - ${view.exists ? format.toUpperCase() : 'file baru'}`;
  $('#oc-config-path').title = filePath;
  $('#oc-model').value = typeof view.config?.model === 'string' ? view.config.model : '';
  $('#oc-small-model').value = typeof view.config?.small_model === 'string' ? view.config.small_model : '';
  renderAgents(view.agents);
  $('#oc-default-agent').value = view.defaultAgent ?? '';
  renderReferences(view.references);
  renderInstructions(view.instructions);
  renderSkills(view.skills);
  renderWebsearch(view.websearch);
  renderPolicies(view.policies);
  renderAdvanced(view.advanced);
  $('#oc-json-text').value = typeof view.text === 'string' && view.text ? view.text : '{\n}\n';
  $('#oc-config-error').textContent = typeof view.parseError === 'string' ? view.parseError : '';
  if (view.parseError) setMode('json'); // the raw file is the only way to repair it
  const jsonc = view.format === 'jsonc';
  $('#oc-config-note').innerHTML = `${jsonc ? 'File ini JSONC: tab <b>JSON</b> mempertahankan komentar, simpan lewat <b>Form</b> menulis JSON biasa. ' : ''}${NOTE_BACKUP}`;
  renderConflict();
};

const renderBackups = () => {
  const list = $('#oc-backup-list');
  if (editor.backupsBusy) {
    list.innerHTML = '<p class="muted small">Memuat riwayat backup…</p>';
    applyBusy();
    return;
  }
  if (editor.backupError) {
    list.innerHTML = `<p class="field-error" role="alert">${escapeHtml(editor.backupError)}</p>`;
    applyBusy();
    return;
  }
  const backups = Array.isArray(editor.backups) ? editor.backups : null;
  if (!backups) {
    list.replaceChildren();
    applyBusy();
    return;
  }
  if (!backups.length) {
    list.innerHTML = '<p class="muted small">Belum ada backup.</p>';
    applyBusy();
    return;
  }
  list.innerHTML = backups.filter((backup) => backup && typeof backup === 'object').map((backup) => {
    const id = String(backup?.id ?? '');
    const when = timeText(backup?.at);
    const invalid = backup?.valid === false;
    return `<div class="oc-backup-row" data-backup-row="${escapeHtml(id)}">
      <div class="oc-backup-meta">
        <b>${escapeHtml(when)}</b>
        <span class="muted">${escapeHtml(kbText(backup?.bytes))}${backup?.format ? ` · ${escapeHtml(String(backup.format).toUpperCase())}` : ''}</span>
        ${invalid ? '<span class="pill bad">tidak valid</span>' : ''}
        ${backup?.legacy ? '<span class="pill">format lama</span>' : ''}
      </div>
      <div class="backup-actions">
        <button type="button" class="ghost" data-backup-preview="${escapeHtml(id)}" aria-label="Pratinjau backup ${escapeHtml(when)}">Pratinjau</button>
        <button type="button" class="ghost" data-backup-restore="${escapeHtml(id)}" aria-label="Pulihkan backup ${escapeHtml(when)}"${invalid ? ' disabled' : ''}>Pulihkan</button>
      </div>
    </div>`;
  }).join('');
  applyBusy();
};

const resetPreview = () => {
  $('#oc-backup-preview-wrap').hidden = true;
  $('#oc-backup-preview').value = '';
  $('#oc-backup-preview-meta').textContent = '';
};

const setScope = (scope) => {
  editor.scope = scope;
  for (const [id, value] of [['#oc-scope-project', 'project'], ['#oc-scope-global', 'global']]) {
    const on = value === scope;
    $(id).classList.toggle('on', on);
    $(id).setAttribute('aria-selected', String(on));
  }
};

const setMode = (mode) => {
  editor.mode = mode;
  const form = mode === 'form';
  $('#oc-form-panel').hidden = !form;
  $('#oc-json-panel').hidden = form;
  for (const [id, value] of [['#oc-mode-form', 'form'], ['#oc-mode-json', 'json']]) {
    const on = value === mode;
    $(id).classList.toggle('on', on);
    $(id).setAttribute('aria-selected', String(on));
  }
};

const setReloadHint = (on) => {
  editor.needsReload = on;
  $('#oc-config-reload').classList.toggle('needs-reload', on);
};

/** A write refused by the server. `stale`/`lock-missing` means the editor read an old file: show the message plus the
 *  "↻ Muat ulang" hint. `busy` (a turn is running) is a 409 too, but reloading would throw away unsaved edits and does
 *  not end the turn: show the message only. Never retries on its own. */
const reportWriteError = (err) => {
  const message = typeof err?.message === 'string' && err.message ? err.message : 'Permintaan ditolak server.';
  const code = err?.data?.code;
  const stale = err?.status === 409 && (code === 'stale' || code === 'lock-missing');
  $('#oc-config-error').textContent = stale ? `${message} Klik ↻ Muat ulang, lalu coba lagi.` : message;
  if (err?.status === 409) setReloadHint(stale);
};

/** One place for every "busy" state: the form, the conflict banner, and every backup row. */
const applyBusy = () => {
  const busy = editor.busy;
  $('#oc-config-save').disabled = busy || !editor.view;
  $('#oc-config-reload').disabled = busy;
  $('#oc-scope-project').disabled = busy || !state.active || state.active === DEMO_ID;
  $('#oc-scope-global').disabled = busy;
  $('#oc-agent-add').disabled = busy;
  $('#oc-reference-add').disabled = busy;
  $('#oc-instruction-add').disabled = busy;
  $('#oc-skill-add').disabled = busy;
  for (const button of document.querySelectorAll('#oc-reference-list [data-ref-remove], #oc-instruction-list [data-instruction-remove], #oc-skill-list [data-skill-remove]')) button.disabled = busy;
  $('#oc-conflict-consolidate').disabled = busy || editor.backupsBusy;
  for (const button of document.querySelectorAll('#oc-backup-list button[data-backup-preview], #oc-backup-list button[data-backup-restore]')) {
    button.disabled = busy || editor.backupsBusy || (button.dataset.backupRestore ? backupLocked(button.dataset.backupRestore) : false);
  }
};

const setBusy = (busy) => {
  editor.busy = busy;
  applyBusy();
};

/** Moves focus somewhere useful after the focused control disappears (dismissed banner, re-rendered backup row). */
const focusEditor = () => (editor.mode === 'form' ? $('#oc-model') : $('#oc-json-text')).focus({ preventScroll: true });

async function loadBackups() {
  if (editor.backupsBusy) return;
  editor.backupsBusy = true;
  editor.backupError = '';
  $('#oc-backup-error').textContent = '';
  renderBackups();
  try {
    const reply = await api('/api/opencode-config/backups', { scope: editor.scope, projectId: state.active });
    editor.backups = Array.isArray(reply?.backups) ? reply.backups : [];
  } catch (err) {
    editor.backups = null;
    editor.backupError = err.message;
  } finally {
    editor.backupsBusy = false;
    renderBackups();
  }
}

async function load() {
  if (editor.busy) return;
  if (editor.scope === 'project' && (!state.active || state.active === DEMO_ID)) {
    setScope('global');
    return load();
  }
  setBusy(true);
  setReloadHint(false);
  editor.conflictDismissed = false;
  editor.backups = null;
  editor.backupError = '';
  previewCache.clear();
  resetPreview();
  $('#oc-backup-error').textContent = '';
  $('#oc-config-error').textContent = '';
  $('#oc-config-path').textContent = 'Memuat config…';
  $('#oc-conflict').hidden = true; // never show the previous view's banner while this one loads
  try {
    const [reply] = await Promise.all([
      api('/api/opencode-config', { scope: editor.scope, projectId: state.active }),
      $('#oc-history').open ? loadBackups() : null, // the history can load in parallel
    ]);
    editor.view = reply;
    renderView();
  } catch (err) {
    editor.view = null;
    renderConflict();
    $('#oc-config-path').textContent = 'Gagal memuat config.';
    $('#oc-config-error').textContent = err.message;
  } finally {
    setBusy(false);
  }
}

const collectAgents = () => {
  const out = [];
  for (const row of document.querySelectorAll('#oc-agent-list .oc-agent')) {
    const value = (key) => row.querySelector(`[data-agent="${key}"]`)?.value ?? '';
    const agent = {
      name: value('name').trim(),
      mode: value('mode').trim(),
      model: value('model').trim(),
      description: value('description').trim(),
      prompt: value('prompt'),
      steps: value('steps').trim(),
      color: value('color').trim(),
      hidden: row.querySelector('[data-agent="hidden"]')?.checked === true,
      disabled: row.querySelector('[data-agent="disabled"]')?.checked === true,
    };
    if (!agent.name && !agent.mode && !agent.model && !agent.description && !agent.prompt.trim() && !agent.steps && !agent.color) continue;
    out.push(agent);
  }
  return out;
};

/** The reference rows exactly as the server's mergeForm expects them; a row the user never touched is skipped. */
const collectReferences = () => {
  const out = [];
  for (const row of document.querySelectorAll('#oc-reference-list .oc-agent')) {
    const value = (key) => row.querySelector(`[data-ref="${key}"]`)?.value ?? '';
    const reference = {
      name: value('name').trim(),
      kind: value('kind') === 'repository' ? 'repository' : 'path',
      path: value('path').trim(),
      repository: value('repository').trim(),
      branch: value('branch').trim(),
      description: value('description').trim(),
      hidden: row.querySelector('[data-ref="hidden"]')?.checked === true,
    };
    if (!reference.name && !reference.path && !reference.repository && !reference.branch && !reference.description && !reference.hidden) continue;
    out.push(reference);
  }
  return out;
};

async function save() {
  if (editor.busy || !editor.view) return;
  setBusy(true);
  $('#oc-config-error').textContent = '';
  const body = { scope: editor.scope, projectId: state.active, mode: editor.mode, baseHash: editor.view.hash ?? null };
  if (editor.mode === 'form') {
    body.form = {
      model: $('#oc-model').value.trim(),
      smallModel: $('#oc-small-model').value.trim(),
      agents: collectAgents(),
      defaultAgent: $('#oc-default-agent').value.trim(),
      references: collectReferences(),
      instructions: collectInstructions(),
      skills: collectSkills(),
      websearch: (() => {
        const value = $('#oc-websearch').value;
        return value === 'inherit' || value === 'off' ? { mode: value, provider: '' } : { mode: 'provider', provider: value };
      })(),
      policies: collectPolicies(),
      advanced: collectAdvanced(),
    };
  } else {
    body.text = $('#oc-json-text').value;
  }
  try {
    const reply = await api('/api/opencode-config/save', body);
    editor.view = reply;
    setReloadHint(false);
    renderView();
    toast(`Config OpenCode disimpan${reply.backup ? ' (backup dibuat)' : ''}.${reply.restarted ? ` ${reply.restarted} sesi OpenCode idle dimuat ulang.` : ''}`, 'ok');
    if ($('#oc-history').open) await loadBackups();
  } catch (err) {
    // 409: stale (reload fixes it) or a running turn (reload does not); never write over it.
    reportWriteError(err);
  } finally {
    setBusy(false);
  }
}

async function consolidate() {
  const view = editor.view;
  const conflict = view?.conflict;
  if (editor.busy || !conflict || view.consolidatable !== true || editor.scope !== 'project') return;
  // Every existing `.opencode` file is moved; name the one the user knows and count them when there is more than one.
  const dotSources = (Array.isArray(view.sources) ? view.sources : []).filter(
    (source) => source && source.kind === 'dot-opencode' && typeof source.path === 'string' && source.exists !== false,
  );
  const movedSource = dotSources[0] ?? null;
  const movedLabel = movedSource ? sourceLabel(movedSource) : '.opencode/opencode.json';
  const dotCount = dotSources.length;
  const what = dotCount > 1 ? `${dotCount} file .opencode` : movedLabel;
  const ok = window.confirm(
    `Gabungkan ${what} ke ${view.path}?\n\n` +
      `Isi file .opencode digabung ke file ini (file yang lebih akhir menang), lalu ${what} disimpan di folder backup aplikasi dengan awalan "dot--" untuk pemulihan manual — tidak muncul di Riwayat backup file ini. ` +
      `File root ditulis sebagai JSON biasa, jadi komentar JSONC di file root tidak dipertahankan; backup sebelumnya bisa mengembalikannya.`,
  );
  if (!ok) return;
  setBusy(true);
  $('#oc-config-error').textContent = '';
  try {
    const reply = await api('/api/opencode-config/consolidate', { projectId: state.active, baseHash: editor.view.hash ?? null });
    editor.view = reply;
    editor.conflictDismissed = false;
    setReloadHint(false);
    renderView();
    // The response knows exactly what was moved (`movedBackups`): say the count when it is more than one.
    const movedCount = Array.isArray(reply.movedBackups) ? reply.movedBackups.filter((file) => typeof file === 'string').length : 0;
    const movedText = movedCount > 1 ? `${movedCount} file .opencode` : movedLabel;
    toast(`Config digabung ke file ini. ${movedText} disimpan di folder backup aplikasi (awalan "dot--", pemulihan manual; bukan di Riwayat backup ini)${reply.restarted ? `; ${reply.restarted} sesi OpenCode idle dimuat ulang` : ''}.`, 'ok');
    focusEditor();
    if ($('#oc-history').open) await loadBackups();
  } catch (err) {
    reportWriteError(err);
  } finally {
    setBusy(false);
  }
}

async function showPreview(id) {
  const backup = backupById(id);
  if (!backup || editor.busy || editor.backupsBusy) return;
  $('#oc-backup-error').textContent = '';
  const area = $('#oc-backup-preview');
  const meta = $('#oc-backup-preview-meta');
  $('#oc-backup-preview-wrap').hidden = false;
  meta.textContent = `${backup.name ? `${backup.name} · ` : ''}${timeText(backup.at)} · ${kbText(backup.bytes)}`;
  if (previewCache.has(id)) {
    area.value = previewCache.get(id); // text only, never innerHTML
    return;
  }
  area.value = '';
  editor.backupsBusy = true;
  applyBusy();
  const previewWrap = $('#oc-backup-preview-wrap');
  previewWrap.setAttribute('aria-busy', 'true');
  const view = editor.view;
  try {
    const reply = await api('/api/opencode-config/backup', { scope: editor.scope, projectId: state.active, id });
    const text = typeof reply?.text === 'string' ? reply.text : '';
    previewCache.set(id, text);
    if (previewCache.size > 20) previewCache.delete(previewCache.keys().next().value);
    if (editor.view === view) area.value = text; // the scope may have changed while this was in flight
  } catch (err) {
    if (editor.view === view) {
      $('#oc-backup-error').textContent = err.message;
      $('#oc-backup-preview-wrap').hidden = true;
    }
  } finally {
    previewWrap.removeAttribute('aria-busy');
    editor.backupsBusy = false;
    applyBusy();
  }
}

async function restore(id) {
  const backup = backupById(id);
  if (!backup || backup.valid === false || editor.busy || editor.backupsBusy) return;
  const when = timeText(backup.at);
  const ok = window.confirm(
    `Pulihkan config dari backup ${when} (${kbText(backup.bytes)})?\n\nIsi file config sekarang diganti dengan isi backup ini. Isi yang sekarang dibackup lebih dulu, jadi masih bisa dikembalikan.`,
  );
  if (!ok) return;
  setBusy(true);
  $('#oc-config-error').textContent = '';
  $('#oc-backup-error').textContent = '';
  let restored = false;
  try {
    const reply = await api('/api/opencode-config/restore', { scope: editor.scope, projectId: state.active, id, baseHash: editor.view?.hash ?? null });
    editor.view = reply;
    editor.conflictDismissed = false;
    setReloadHint(false);
    renderView();
    toast(`Config dipulihkan dari backup ${when}${reply.restarted ? `; ${reply.restarted} sesi OpenCode idle dimuat ulang` : ''}.`, 'ok');
    focusEditor();
    restored = true;
  } catch (err) {
    // 409 (stale or a running turn) belongs to the editor; a missing/unreadable backup stays in the history block.
    if (err?.status === 409) reportWriteError(err);
    else $('#oc-backup-error').textContent = err.message;
  } finally {
    setBusy(false);
  }
  if (restored) await loadBackups();
}

export function initOpenCodeConfig() {
  $('#oc-config-open').addEventListener('click', async () => {
    setScope(state.active && state.active !== DEMO_ID ? 'project' : 'global');
    setMode('form');
    openModal('oc-config-modal');
    await load();
  });
  $('#oc-scope-project').addEventListener('click', async () => {
    if (editor.busy || !state.active || state.active === DEMO_ID) return;
    setScope('project');
    await load();
  });
  $('#oc-scope-global').addEventListener('click', async () => {
    if (editor.busy) return;
    setScope('global');
    await load();
  });
  $('#oc-mode-form').addEventListener('click', () => setMode('form'));
  $('#oc-mode-json').addEventListener('click', () => setMode('json'));
  $('#oc-agent-add').addEventListener('click', () => {
    if (editor.busy) return;
    const list = $('#oc-agent-list');
    if (list.querySelector('.muted')) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', agentRow());
    list.querySelector('.oc-agent:last-child [data-agent="name"]')?.focus();
  });
  $('#oc-agent-list').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-agent-remove]');
    if (!remove || editor.busy) return;
    const row = remove.closest('.oc-agent');
    row?.remove();
    if (!document.querySelector('#oc-agent-list .oc-agent')) renderAgents([]);
  });
  $('#oc-reference-add').addEventListener('click', () => {
    if (editor.busy) return;
    const list = $('#oc-reference-list');
    if (list.querySelector('.muted')) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', referenceRow());
    list.querySelector('.oc-agent:last-child [data-ref="name"]')?.focus();
  });
  // Choosing the kind only re-shows the fields that belong to it; the values stay in the DOM for switching back.
  $('#oc-reference-list').addEventListener('change', (e) => {
    const kind = e.target.closest('[data-ref="kind"]');
    if (kind) syncRefKind(kind.closest('.oc-agent'));
  });
  $('#oc-reference-list').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-ref-remove]');
    if (!remove || editor.busy) return;
    const row = remove.closest('.oc-agent');
    row?.remove();
    if (!document.querySelector('#oc-reference-list .oc-agent')) renderReferences([]);
  });
  $('#oc-config-reload').addEventListener('click', load);
  $('#oc-instruction-add').addEventListener('click', () => {
    if (editor.busy) return;
    const list = $('#oc-instruction-list');
    if (list.querySelector('.muted')) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', instructionRow());
    list.querySelector('.oc-agent:last-child [data-instruction]')?.focus();
  });
  $('#oc-instruction-list').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-instruction-remove]');
    if (!remove || editor.busy) return;
    remove.closest('.oc-agent')?.remove();
    if (!document.querySelector('#oc-instruction-list .oc-agent')) renderInstructions([]);
  });
  $('#oc-skill-add').addEventListener('click', () => {
    if (editor.busy) return;
    const list = $('#oc-skill-list');
    if (list.querySelector('.muted')) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', skillRow());
    list.querySelector('.oc-agent:last-child [data-skill]')?.focus();
  });
  $('#oc-skill-list').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-skill-remove]');
    if (!remove || editor.busy) return;
    remove.closest('.oc-agent')?.remove();
    if (!document.querySelector('#oc-skill-list .oc-agent')) renderSkills([]);
  });
  $('#oc-policy-add').addEventListener('click', () => {
    if (editor.busy) return;
    const list = $('#oc-policy-list');
    if (list.querySelector('.muted')) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', policyRow());
    list.querySelector('.oc-agent:last-child [data-policy-action]')?.focus();
  });
  $('#oc-policy-list').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-policy-remove]');
    if (!remove || editor.busy) return;
    remove.closest('.oc-agent')?.remove();
    if (!document.querySelector('#oc-policy-list .oc-agent')) renderPolicies([]);
  });
  $('#oc-watcher-add').addEventListener('click', () => {
    if (editor.busy) return;
    const list = $('#oc-watcher-list');
    if (list.querySelector('.muted')) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', watcherRow());
    list.querySelector('.oc-agent:last-child [data-watcher-ignore]')?.focus();
  });
  $('#oc-watcher-list').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-watcher-remove]');
    if (!remove || editor.busy) return;
    remove.closest('.oc-agent')?.remove();
    if (!document.querySelector('#oc-watcher-list .oc-agent')) renderWatchers([]);
  });
  $('#oc-config-save').addEventListener('click', save);
  $('#oc-conflict-consolidate').addEventListener('click', consolidate);
  $('#oc-conflict-close').addEventListener('click', () => {
    editor.conflictDismissed = true;
    renderConflict();
    focusEditor(); // the banner's own button just disappeared
  });
  $('#oc-history').addEventListener('toggle', () => {
    if ($('#oc-history').open) loadBackups();
  });
  $('#oc-backup-list').addEventListener('click', (e) => {
    const preview = e.target.closest('[data-backup-preview]');
    if (preview) return showPreview(preview.dataset.backupPreview);
    const restoreButton = e.target.closest('[data-backup-restore]');
    if (restoreButton) return restore(restoreButton.dataset.backupRestore);
  });
}
