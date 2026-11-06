// The composer: prompt box, send, mode/model/effort controls, read-only state, composer keyboard.
import { api, toast } from '../core/api.js';
import { estimateUsd, formatEstimate, isPeak } from '../core/cost-estimate.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { capReason, capsFor, engineBadge, engineLabel, engineOf, modeFor, modelsPerProject } from '../core/engine-caps.js';
import { fmtNum } from '../core/format.js';
import { DEMO_ID, READ_ONLY_HINT, state } from '../core/state.js';
import { setMobileView } from '../ui/layout.js';
import { attachmentPayload, attachments, attachmentsReady, clearAttachments, rememberSent, restoreAttachments } from './attachments.js';
import { localCommand } from './commands.js';
import { connection } from './connection.js';
import { draftSent, flushDraft, scheduleDraftSave } from './draft.js';
import { applyCapsToDom, autoModelNote, AUTO_MODEL, autoModelOption, guardCap, initEngine, isModelValue, matchCount, MODEL_TIER_LABELS, MODEL_TIERS, modelTiersFor, projectCaps, projectModelOptions, projectModels, tierOptionsHtml } from './engine.js';
import { recall, recallPrompt } from './history.js';
import { modelPrices, priceDetail, priceFor, priceNote, priceSuffix } from './model-prices.js';
import { renderResumeTurn } from './resume-turn.js';
import { openRewind } from './rewind.js';
import { confirmNew, renderSessionBar } from './sessions.js';
import { modeShort, MODE_CYCLE, renderStatusline, renderTodos } from './statusline.js';
import { applySuggest, closeSuggest, renderSuggest, searchHistory, suggest } from './suggest.js';
import { backgroundRunning, renderTaskChip, renderTasks, tasksView } from './tasks.js';
import { placeholders, tabToPlaceholder } from './templates.js';
import { renderQueueChip } from './queue.js';
import { renderVoice } from './voice.js';
import { closeModal, openModal } from '../ui/modals.js';

// A shorter hint fits a phone-width composer on one line.
const applyPlaceholder = () => {
  $('#prompt').placeholder = state.readOnly ? READ_ONLY_HINT : narrow.matches ? 'Ketik pesan…' : 'Minta sesuatu ke tim…';
  $('#prompt').rows = narrow.matches ? 1 : 3;
  autosize();
};
// On a phone the composer starts at one line and grows with the text, like a chat app.
export function autosize() {
  const input = $('#prompt');
  input.style.height = '';
  if (narrow.matches) input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  scheduleCostEstimate(); // every way the text changes ends here (typing, paste, template, history, voice)
}

/** Puts text in the composer to edit before sending (starters, "Edit" on a sent prompt). */
export function fillComposer(text) {
  if (state.readOnly) return;
  if (narrow.matches) setMobileView('chat');
  const input = $('#prompt');
  input.value = text;
  input.focus();
  input.setSelectionRange(text.length, text.length);
  autosize();
  updateBashMode();
  scheduleDraftSave();
}

// ---------- composer ----------

/** Something Stop / Esc can end: a turn, queued prompts, or background tasks (shells, subagents) still running. */
const stoppable = (st) => Boolean(st.busy || st.queue || (st.tasks ?? []).some((t) => t?.status === 'running' || t?.status === 'pending'));

// Sending an Auto prompt waits for the classifier before the server creates the chat bubble. Keep a visible
// "Menentukan effort..." row so an empty chat does not look like the prompt was lost.
const effortPending = { project: null };

export function renderComposer() {
  const isDemo = state.active === DEMO_ID;
  const st = state.statuses[state.active] ?? {};
  const classifying = effortPending.project === state.active;
  const engine = engineOf(st, state.config);
  const caps = capsFor(state.config, engine);
  $('#composer').classList.toggle('demo', isDemo);
  $('#btn-stop').hidden = isDemo || !stoppable(st);
  $('#btn-stop').title = st.busy || st.queue ? 'Hentikan giliran yang sedang berjalan, termasuk tugas latar (Esc)' : 'Hentikan tugas latar yang masih berjalan (Esc)';
  renderModeOptions(caps, engine);
  renderAgentOptions(st, engine);
  $('#mode').value = modeFor(st.mode ?? 'manual', caps);
  renderModelOptions(st.model ?? '', engine);
  $('#effort').value = st.effortAuto ? 'auto' : (st.effort ?? '');
  $('#team-mode').checked = st.team ?? true;
  applyCaps(caps, engine);
  const hint = [];
  // As in the CLI, a message sent mid-turn reaches Claude at its next step instead of waiting for the end.
  if (st.busy) hint.push(st.queue ? `Tim bekerja — ${st.queue} pesan antre, dibaca di langkah berikutnya.` : 'Tim bekerja — pesan baru dibaca di langkah berikutnya.');
  if (st.cliBusy) hint.push('Sesi terminal berjalan (izin dijawab di terminal).');
  if (st.autoApprove) hint.push('⚠ Semua izin otomatis di sesi ini.');
  if (state.readOnly) hint.unshift(`👁 ${READ_ONLY_HINT}.`);
  $('#composer-hint').textContent = hint.join('  ·  ');
  const planPreparing = st.planPreparing;
  $('#typing').hidden = !(classifying || planPreparing || st.busy || st.cliBusy || st.compacting);
  $('#typing-text').textContent = classifying
    ? 'Menentukan effort…'
    : planPreparing === 'build'
      ? 'Menentukan model & effort…'
      : planPreparing === 'revisi'
        ? 'Menyiapkan revisi…'
        : st.compacting
          ? '⏳ Memadatkan konteks percakapan…'
          : st.busy
            ? 'Tim sedang bekerja…'
            : 'Claude Code (terminal) sedang bekerja…';
  renderResumeTurn(st);
  renderTodos(st);
  renderStatusline(st);
  renderCostEstimate();
  renderSessionBar();
  renderTaskChip(st);
  renderQueueChip(st);
  renderModelStale(st);
  renderVoice();
  renderSettingsChip(st);
  applyReadOnly();
  renderSendState();
  if (!$('#tasks-modal').hidden && tasksView.project === state.active) renderTasks();
}

// Controls that change something: disabled (with the reason as tooltip) for a phone on plain WiFi.
const ACTION_CONTROLS = ['#prompt', '#btn-send', '#btn-plus', '#settings-chip', '#typing-stop', '#btn-attach', '#btn-template','#btn-stop', '#btn-queue-add', '#mode', '#model', '#model-search', '#effort', '#team-mode', '#btn-new', '#btn-demo', '#ch-review', '#ch-message', '#ch-commit button', '#sessions-new', '#refresh-projects', '#team-reset', '#team-form button.primary'];

function applyReadOnly() {
  if (!state.readOnly) return; // fixed per connection: a laptop / Tailscale page never needs undoing
  for (const sel of ACTION_CONTROLS) {
    const el = $(sel);
    if (!el) continue;
    el.disabled = true;
    el.title = READ_ONLY_HINT;
  }
  $('#ro-banner').hidden = false; // phone: one visible reason instead of a greyed-out composer
  applyPlaceholder();
}

const OFFLINE_HINT = 'Belum tersambung ke laptop — pesan belum dikirim, teksnya tetap di kotak';

/** Kirim waits for the connection (the text box stays usable, so typing carries on and is kept as a draft). */
export function renderSendState() {
  if (state.readOnly) return; // applyReadOnly owns the button there
  const send = $('#btn-send');
  send.disabled = !connection.online;
  send.title = connection.online ? '' : OFFLINE_HINT;
  if (narrow.matches) renderStatusline(state.statuses[state.active] ?? {}); // phone: the "not connected" chip
}

/**
 * After a provider logout the project's model may be stale (status.modelStale): the server refuses the next prompt
 * (409) until another model or Default is picked. One always-present line above the box, so showing/hiding it never
 * moves the input row or the send button — and the text is only rewritten when the model itself changes.
 */
function renderModelStale(st) {
  const box = $('#model-stale');
  if (!box) return;
  const stale = st.modelStale === true;
  box.hidden = !stale;
  if (!stale) {
    if (box.textContent) box.textContent = '';
    delete box.dataset.model;
    return;
  }
  const model = typeof st.activeModel === 'string' && st.activeModel.trim() ? st.activeModel.trim() : typeof st.model === 'string' ? st.model.trim() : '';
  const name = model || 'Model project ini';
  if (box.dataset.model === name) return; // same model: leave the node alone (no reflow on every status tick)
  box.dataset.model = name;
  box.textContent = `⚠ ${name} tidak bisa dipakai lagi karena akun/provider berubah. Pilih model lain (atau Default) dulu — prompt ditolak sampai model dipilih.`;
}

/** The chip above the input (toolbar on a phone) sums up the turn settings that live in its dialog. */
function renderSettingsChip(st) {  const chip = $('#settings-chip');
  const mode = $('#mode').value || 'manual';
  // "Default (Fable 5 · …)" → "Default": the chip stays one short line
  const label = (sel) => ($(sel).selectedOptions[0]?.textContent ?? '').replace(/\s*\(.*$/, '').trim();
  // Auto replaces the model name in the chip (the full label is the description): "Auto".
  const model = st.modelAuto === true || $('#model').value === AUTO_MODEL ? 'Auto' : label('#model') || 'Default';
  const effort = $('#effort').value && !$('#effort').disabled ? label('#effort') : '';
  const team = $('#team-mode').checked && !$('#team-ctl').classList.contains('cap-off');
  const engine = engineOf(st, state.config);
  // The project's engine names itself on the chip (short badge label): a phone has no session bar to show it.
  const engineName = engineBadge(engine);
  // Laptop already shows the engine in the header/picker: keep the chip to mode · model · effort · tim.
  chip.textContent = [narrow.matches ? engineName : '', modeShort(mode, engine), model, effort, team ? 'Tim' : ''].filter(Boolean).join(' · ');
  chip.setAttribute('aria-label', `Pengaturan giliran: mesin ${engineLabel(engine)}, mode ${modeShort(mode, engine).replace(/^\W+/u, '')}, model ${model}, effort ${effort || 'default'}, mode tim ${team ? 'aktif' : 'mati'}`);
  chip.classList.toggle('warn', mode === 'dontAsk' || Boolean(st?.autoApprove));
  const note = $('#effort-note');
  note.hidden = !$('#effort').disabled || Boolean(state.readOnly) || !$('#effort').title;
  note.textContent = $('#effort').title;
}

/** Permission modes the engine doesn't offer (🚫 dontAsk on OpenCode) leave the select and the Shift+Tab cycle. */
/**
 * OpenCode's primary agents (status.agents from its `mode` option): build and the user's own agents. "plan" stays
 * under Izin → 📋 Rencana dulu, so it is not offered twice. Hidden for Claude Code or when there is only build.
 */
function renderAgentOptions(st, engine) {
  const ctl = $('#agent-ctl');
  const agents = engine === 'opencode' ? (st.agents ?? []).filter((a) => a.value !== 'plan') : [];
  ctl.hidden = agents.length < 2 && !(st.agent && st.agent !== 'build');
  if (ctl.hidden) return;
  const select = $('#agent');
  const current = st.agent || 'build';
  const list = agents.some((a) => a.value === current) ? agents : [...agents, { value: current, name: `${current} (tidak ada lagi)` }];
  const html = list.map((a) => `<option value="${escapeHtml(a.value === 'build' ? '' : a.value)}" title="${escapeHtml(a.description ?? '')}">${escapeHtml(a.name)}</option>`).join('');
  if (select.dataset.html !== html) {
    select.innerHTML = html;
    select.dataset.html = html;
  }
  if (document.activeElement !== select) select.value = current === 'build' ? '' : current;
  select.disabled = Boolean(state.readOnly) || st.mode === 'plan';
  select.title = st.mode === 'plan' ? 'Saat Izin = 📋 Rencana dulu, OpenCode memakai agent plan' : '';
}

function renderModeOptions(caps, engine) {
  for (const opt of $('#mode').options) {
    const off = !caps.modes.includes(opt.value);
    opt.hidden = off;
    opt.disabled = off;
    // Claude Code keeps the full set of labels; OpenCode shows its two native modes as Build and Plan.
    if (!opt.dataset.label) opt.dataset.label = opt.textContent;
    opt.textContent = engine === 'opencode' ? (opt.value === 'manual' ? 'Build' : opt.value === 'plan' ? 'Plan' : opt.dataset.label) : opt.dataset.label;
  }
}

const TEAM_TITLE = (engine) => `${engineLabel(engine)} mendelegasikan ke tim (PM, BA, UI/UX, Dev, QA, …). Kantor lebih hidup, tapi lebih banyak token.`;
const CAP_NAMES = { effort: 'effort', team: 'Mode tim', rewind: 'Rewind', mcp: 'Server MCP', bgTasks: 'tugas latar' };

/**
 * Effort and Mode tim follow the engine's caps: disabled with the reason as tooltip (and, on a phone, as notes in
 * the settings sheet: no tooltips there). One place for every engine, no per-engine branches.
 */
function applyCaps(caps, engine) {
  if (!caps.effort) {
    $('#effort').disabled = true;
    $('#effort').title = capReason('effort', engine);
  }
  $('#effort').closest('.ctl').classList.toggle('cap-off', !caps.effort);
  const team = $('#team-ctl');
  $('#team-mode').disabled = !caps.team || Boolean(state.readOnly);
  team.title = caps.team ? TEAM_TITLE(engine) : capReason('team', engine);
  team.classList.toggle('cap-off', !caps.team);
  const off = Object.keys(CAP_NAMES).filter((c) => !caps[c]);
  const note = $('#engine-note');
  note.hidden = !off.length || state.active === DEMO_ID;
  note.textContent = off.length ? `${engineLabel(engine)} belum mendukung: ${off.map((c) => CAP_NAMES[c]).join(', ')}.` : '';
  applyCapsToDom();
}

/** The option tooltip: the model's own description first, then the price detail (model id, source, peak, records). */
function priceTitle(value, base = '') {
  const detail = priceDetail(value);
  return detail ? [base, detail].filter(Boolean).join(' · ') : base;
}

/**
 * The muted line under the Model control (#model-price-note): created on first use, kept next to `.controls` so it
 * follows them into the phone's "Pengaturan giliran" sheet. Hidden for the demo project and for an unset model.
 * While Model Auto is on it says which model every tier uses (and, once the server has picked one, the current model)
 * instead of the price: the price follows whichever model the classifier chose.
 */
function renderPriceNote(auto, model, engine) {
  const controls = document.querySelector('.controls');
  if (!controls) return;
  let note = $('#model-price-note');
  if (!note) {
    note = document.createElement('p');
    note.id = 'model-price-note';
    note.className = 'muted small model-price-note';
    note.setAttribute('aria-live', 'polite');
  }
  if (controls.nextElementSibling !== note) controls.after(note);
  const tiers = modelTiersFor(state.statuses[state.active] ?? {}, engine);
  const autoText = autoModelNote(tiers, model);
  const text = state.active === DEMO_ID ? '' : auto ? autoText : priceNote(model);
  if (note.textContent !== text) note.textContent = text;
  note.hidden = !text;
  renderTiersOpen(note, auto && !note.hidden);
}

/** "Atur tangga…": the ladder dialog's opener, kept right under the Auto note (hidden for a concrete model). */
function renderTiersOpen(note, show) {
  let open = $('#model-tiers-open');
  if (!open) {
    open = document.createElement('button');
    open.id = 'model-tiers-open';
    open.type = 'button';
    open.className = 'tiers-open';
    open.textContent = 'Atur tangga…';
    open.title = 'Pilih model untuk tiap tingkat Auto (Hemat / Seimbang / Kuat / Maks)';
    open.setAttribute('aria-haspopup', 'dialog');
    open.addEventListener('click', openModelTiers);
  }
  if (note.nextElementSibling !== open) note.after(open);
  open.hidden = !show;
}

// ---------- cost estimate before send (#cost-estimate) ----------

const COST_DEBOUNCE_MS = 280;
let costTimer = null;

/** Recomputes the line shortly after the box settles: one debounce for every keystroke, no request, no send. */
export function scheduleCostEstimate() {
  clearTimeout(costTimer);
  costTimer = setTimeout(renderCostEstimate, COST_DEBOUNCE_MS);
}

/** "2" / "1,5": a peak factor as shown next to "×" (Indonesian decimal comma). */
const factorText = (n) => String(Number(n.toFixed(2))).replace('.', ',');

/** The model whose price applies: the concrete one Model Auto picked, else the project's own model. */
function costModel(st) {
  for (const value of [st.activeModel, st.model]) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

/** The line lives right under the statusline, created on first use (same pattern as #model-price-note). */
function costNode() {
  let el = $('#cost-estimate');
  const line = $('#statusline');
  if (!el) {
    el = document.createElement('p');
    el.id = 'cost-estimate';
    el.className = 'cost-estimate';
    el.hidden = true;
  }
  if (line?.parentElement && line.nextElementSibling !== el) line.after(el);
  return el;
}

/**
 * What the next prompt will roughly cost: the context the turn already carries plus the box's text (≈ 4 characters
 * per token) and an assumed 600-token answer. The value is hidden without a real project, a usable price, or on a
 * read-only page; the tooltip carries the breakdown (tokens, price source, peak assumption). Reads the price cache
 * only — features/model-prices.js loads it lazily and re-renders the composer when the answer arrives.
 */
export function renderCostEstimate() {
  clearTimeout(costTimer); // a pending debounce would only repeat this exact pass
  costTimer = null;
  const el = costNode();
  const st = state.statuses[state.active] ?? {};
  const text = $('#prompt')?.value ?? '';
  const model = costModel(st);
  // `!command` runs in the shell, not through the model: no estimate to give.
  const price = state.active && state.active !== DEMO_ID && !state.readOnly && !text.startsWith('!') ? priceFor(model) : null;
  const at = Date.now();
  const est = price ? estimateUsd(price, { contextTokens: st.context?.used ?? 0, promptChars: text.length, at }) : null;
  const value = formatEstimate(est);
  if (!value) {
    el.hidden = true; // no price (or no estimate): never a made-up number
    return;
  }
  const peak = price.kind === 'list' && price.peakFactor > 1;
  const source = price.kind === 'list' ? 'harga list OpenCode Go' : `harga efektif tercatat${price.records ? ` (${fmtNum(price.records)} catatan)` : ''}`;
  const title = [
    `Perkiraan prompt berikutnya: konteks ${fmtNum(est.contextTokens)} token`,
    `prompt ±${fmtNum(est.promptTokens)} token`,
    `asumsi ${fmtNum(est.outputTokens)} token output`,
    source,
    peak ? (isPeak(at) ? `jam sibuk ${factorText(price.peakFactor)}× sudah dihitung` : `di luar jam sibuk (hingga ${factorText(price.peakFactor)}×)`) : '',
  ].filter(Boolean).join(' · ');
  const line = `Perkiraan biaya: ${value}`;
  if (el.textContent !== line) el.textContent = line;
  if (el.title !== title) el.title = title;
  el.hidden = false;
}

// ---------- Model Auto ladder dialog (#model-tiers-modal) ----------

// The dialog lists the models lazily (OpenCode: ~140 per select); `dirty` keeps unsaved picks through a re-render.
const tiersView = { key: '', dirty: false };

/** The models the current engine offers: Claude's catalog, or the project's own list (loaded on demand). */
function tierModelSource() {
  const st = state.statuses[state.active] ?? {};
  const engine = engineOf(st, state.config);
  if (!modelsPerProject(engine)) {
    const models = (state.config?.models ?? []).filter((m) => m.value && m.value !== 'default').map((m) => ({ value: m.value, name: m.displayName || m.value }));
    return { engine, models, loading: false, perProject: false };
  }
  const entry = projectModels(state.active, st, renderTierRows);
  return { engine, models: entry?.models ?? [], loading: Boolean(entry?.loading), perProject: true };
}

/** One row: a <select> of the engine's models, or a text input while the project has no list to pick from. */
function tierRow(tier, engine, models, value, loading, perProject) {
  const name = MODEL_TIER_LABELS[tier];
  const id = `tier-${tier}`;
  const label = `<label class="tiers-name" for="${id}">${escapeHtml(name)}</label>`;
  const attr = `id="${id}" data-tier="${tier}" aria-label="Model untuk tingkat ${escapeHtml(name)}"`;
  if (perProject && !models.length && !loading) return `<div class="tiers-row">${label}<input ${attr} type="text" placeholder="mis. opencode-go/glm-5.3" autocomplete="off" spellcheck="false" value="${escapeHtml(value)}" /></div>`;
  const opts = loading && !models.length ? `${tierOptionsHtml(tier, engine, [], value)}<option value="" disabled>Memuat model…</option>` : tierOptionsHtml(tier, engine, models, value, { grouped: perProject });
  return `<div class="tiers-row">${label}<select ${attr}>${opts}</select></div>`;
}

/** Fills the four rows for the active project's engine and the stored (else default) model of each tier. */
function renderTierRows() {
  const modal = $('#model-tiers-modal');
  const rows = $('#tiers-rows');
  if (!modal || !rows || modal.hidden) return;
  if (tiersView.dirty) return; // the user is editing: never clobber their picks with a late model list
  const st = state.statuses[state.active] ?? {};
  const { engine, models, loading, perProject } = tierModelSource();
  const tiers = modelTiersFor(st, engine);
  const key = `${state.active}|${engine}|${perProject}|${loading}|${models.length}|${models[0]?.value ?? ''}|${models.at(-1)?.value ?? ''}`;
  if (key !== tiersView.key) {
    tiersView.key = key;
    const html = MODEL_TIERS.map((tier) => tierRow(tier, engine, models, tiers[tier], loading, perProject)).join('');
    if (rows.dataset.html !== html) {
      rows.innerHTML = html;
      rows.dataset.html = html;
    }
  }
  for (const tier of MODEL_TIERS) {
    const field = $(`#tier-${tier}`);
    if (!field || document.activeElement === field) continue;
    field.value = tiers[tier]; // the default keeps a cleared slot honest
  }
}

const showTiersError = (message) => {
  const box = $('#tiers-error');
  if (!box) return;
  box.textContent = message;
  box.hidden = !message;
};

/** Opens the ladder dialog on the active project's engine, focus on the first tier. */
export function openModelTiers() {
  if (!state.active || state.active === DEMO_ID || !$('#model-tiers-modal')) return;
  tiersView.key = '';
  tiersView.dirty = false;
  $('#tiers-rows').dataset.html = '';
  showTiersError('');
  const save = $('#tiers-save');
  save.disabled = Boolean(state.readOnly);
  save.title = state.readOnly ? READ_ONLY_HINT : '';
  save.textContent = 'Simpan';
  openModal('model-tiers-modal');
  renderTierRows();
  $('#tier-hemat')?.focus({ preventScroll: true });
}

/**
 * Saves the ladder of the project's engine: `{ modelTiers: { <engine>: { hemat, seimbang, kuat, maks } } }`, an
 * empty slot sent as '' (back to the default). The Auto note follows right away (optimistic) and goes back when the
 * server refuses; the dialog stays open with the reason, so nothing typed is lost.
 */
async function saveModelTiers() {
  if (state.readOnly) return;
  const project = state.active;
  const st = state.statuses[project] ?? {};
  const engine = engineOf(st, state.config);
  const picks = {};
  for (const tier of MODEL_TIERS) {
    const field = $(`#tier-${tier}`);
    if (!field) return showTiersError('Form tangga model tidak lengkap — buka ulang dialognya.');
    const value = field.value.trim();
    if (!isModelValue(value)) {
      field.focus();
      return showTiersError(`Id model untuk ${MODEL_TIER_LABELS[tier]} tidak valid: "${value}". Contoh: opencode-go/glm-5.3`);
    }
    picks[tier] = value;
  }
  const save = $('#tiers-save');
  const before = st.modelTiers;
  save.disabled = true;
  save.textContent = 'Menyimpan…';
  showTiersError('');
  state.statuses[project] = { ...st, modelTiers: { ...(before && typeof before === 'object' ? before : {}), [engine]: picks } };
  renderComposer();
  try {
    await api(`/api/projects/${project}/settings`, { modelTiers: { [engine]: picks } });
    tiersView.dirty = false;
    closeModal('model-tiers-modal');
    toast('Tangga model Auto disimpan.', 'ok');
  } catch (err) {
    state.statuses[project] = { ...(state.statuses[project] ?? {}), modelTiers: before };
    renderComposer();
    showTiersError(`Gagal menyimpan: ${err.message}`);
  } finally {
    save.disabled = Boolean(state.readOnly);
    save.textContent = 'Simpan';
  }
}


/** The Model select: Claude Code's models from the app config, or the project's own list for another engine. */
function renderModelOptions(current, engine) {
  const select = $('#model');
  const search = $('#model-search');
  const auto = state.statuses[state.active]?.modelAuto === true; // Auto is a setting, never a model value
  modelPrices(renderComposer); // lazy and non-blocking: without an answer yet the labels just carry no suffix
  const entry = modelsPerProject(engine) ? projectModels(state.active, state.statuses[state.active], renderComposer) : null;
  if (entry) {
    const query = search.value.trim();
    const html = projectModelOptions(entry, current, query);
    if (select.dataset.html !== html) {
      select.innerHTML = html;
      select.dataset.html = html;
    }
    select.value = auto ? AUTO_MODEL : current;
    select.title = entry.models.length ? `${entry.models.length} model dari config ${engineLabel(engine)}` : 'Daftar model muncul setelah pesan pertama';
    $('#model-search-ctl').hidden = entry.models.length < 8; // a short list needs no search box
    $('#model-search-count').textContent = query ? `${matchCount(entry, query)} model cocok` : '';
    // OpenCode: the chosen model's own effort levels (model.list); unknown (Default model, older OpenCode) → generic
    const efforts = entry.models.find((m) => m.value === current)?.efforts;
    setEffortOptions(Array.isArray(efforts) ? efforts : null);
    const none = Array.isArray(efforts) && !efforts.length;
    $('#effort').disabled = none || Boolean(state.readOnly);
    $('#effort').title = none ? 'Model ini tidak punya level effort' : Array.isArray(efforts) ? `Level effort model ini: ${efforts.join(', ')}` : '';
    renderPriceNote(auto, current, engine);
    return;
  }
  setEffortOptions(null);
  $('#model-search-ctl').hidden = true;
  if (search.value) search.value = '';
  select.title = '';
  const models = state.config?.models ?? [];
  if (models.length) {
    const def = models.find((m) => m.value === 'default');
    const opts = [autoModelOption(), `<option value="" title="${escapeHtml(def?.description ?? '')}">Default${def ? ` (${escapeHtml(def.description.split('·')[0].trim())})` : ''}</option>`];
    for (const m of models) if (m.value !== 'default') opts.push(`<option value="${escapeHtml(m.value)}" title="${escapeHtml(priceTitle(m.value, m.description))}">${escapeHtml(`${m.displayName}${priceSuffix(m.value)}`)}</option>`);
    // A model set with /model that the picker doesn't list (e.g. opus[1m] or a full id) stays selectable.
    if (current && !models.some((m) => m.value === current)) opts.push(`<option value="${escapeHtml(current)}" title="${escapeHtml(priceTitle(current))}">${escapeHtml(`${current}${priceSuffix(current)}`)}</option>`);
    const html = opts.join('');
    if (select.dataset.html !== html) {
      select.innerHTML = html;
      select.dataset.html = html;
    }
  } else {
    // No catalog yet (or another engine's list left behind): Auto and Default, nothing stale from OpenCode.
    const html = `${autoModelOption()}<option value="">Default</option>`;
    if (select.dataset.html !== html) {
      select.innerHTML = html;
      select.dataset.html = html;
    }
  }
  select.value = auto ? AUTO_MODEL : current;
  // Effort only for models that support it (as the CLI greys it out).
  const chosen = models.find((m) => m.value === (current || 'default'));
  const noEffort = Boolean(chosen && !chosen.efforts?.length);
  $('#effort').disabled = noEffort || Boolean(state.readOnly);
  $('#effort').title = noEffort ? 'Model ini tidak mendukung pengaturan effort' : '';
  renderPriceNote(auto, current, engine);
}

// Effort picker options. `levels` null = the generic list (Claude Code's levels); else one model's own levels.
const EFFORT_LABEL = { none: 'None (tanpa berpikir)', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' };
const GENERIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
function setEffortOptions(levels) {
  const select = $('#effort');
  const list = levels ?? GENERIC_EFFORTS;
  const html = ['<option value="auto">Auto (LLM)</option>', '<option value="">Default</option>', ...list.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(EFFORT_LABEL[v] ?? v)}</option>`)].join('');
  if (select.dataset.html === html) return;
  const st = state.statuses[state.active] ?? {};
  const want = st.effortAuto ? 'auto' : (st.effort ?? select.value);
  select.innerHTML = html;
  select.dataset.html = html;
  // a level the new model doesn't have shows as Default (the server also falls back to the nearest it offers)
  select.value = want === 'auto' || list.includes(want) ? want : '';
}

function cycleMode() {
  const select = $('#mode');
  const cycle = MODE_CYCLE.filter((m) => projectCaps().modes.includes(m)); // only the modes the engine offers
  select.value = cycle[(cycle.indexOf(select.value) + 1) % cycle.length];
  saveSettings();
}

async function sendPrompt() {
  if (state.readOnly) return;
  await attachmentsReady(); // a file dropped just before Enter goes out with this prompt
  const input = $('#prompt');
  const text = input.value.trim();
  if ((!text && !attachments.length) || state.active === DEMO_ID) return;
  // Offline the request could only fail: say so and keep everything as it is (text, images, draft).
  if (!connection.online) return toast(`${OFFLINE_HINT}.`);
  const project = state.active;
  placeholders.active = false; // a template's {placeholders} are done with once the text goes out
  flushDraft(); // the stored draft stays until the server has accepted the prompt (draftSent)
  if (!attachments.length && (localCommand(text) || text.startsWith('!'))) {
    input.value = '';
    recall.index = -1;
    autosize();
    closeSuggest();
    updateBashMode();
    const command = text.startsWith('!') ? text.slice(1).trim() : '';
    if (!command) return draftSent(project, text); // handled right here (a local /command)
    api(`/api/projects/${project}/shell`, { command }).then(
      () => draftSent(project, text),
      (err) => {
        input.value = text;
        updateBashMode();
        toast(`Gagal menjalankan: ${err.message}`);
      },
    );
    return;
  }
  const files = attachmentPayload();
  const kept = attachments.slice(); // back in the box if the server refuses
  input.value = '';
  recall.index = -1;
  autosize();
  clearAttachments();
  closeSuggest();
  const autoEffort = Boolean(state.statuses[project]?.effortAuto);
  if (autoEffort) {
    effortPending.project = project;
    renderComposer();
  }
  try {
    await api(`/api/projects/${project}/prompt`, { text, attachments: files });
    draftSent(project, text);
    rememberSent(project, kept); // memory only: ↻ Ulangi / Edit can send them again until a reload
  } catch (err) {
    input.value = text;
    restoreAttachments(kept, project);
    toast(`Gagal mengirim: ${err.message}`);
  } finally {
    effortPending.project = null;
    if (autoEffort) renderComposer();
  }
}

/**
 * Picking a model in the #model select: only the model fields go out. Auto sends the flag alone (the classifier picks
 * the model per prompt), a concrete value clears Auto, Default clears both. Shown right away (optimistic), reverted
 * when the server refuses.
 */
export async function saveModel() {
  if (state.readOnly) return;
  const project = state.active;
  const pick = $('#model').value;
  const auto = pick === AUTO_MODEL;
  const before = state.statuses[project] ?? {};
  state.statuses[project] = { ...before, modelAuto: auto, ...(auto ? {} : { model: pick }) };
  renderComposer();
  try {
    await api(`/api/projects/${project}/settings`, auto ? { modelAuto: true } : { model: pick, modelAuto: false });
  } catch (err) {
    state.statuses[project] = { ...(state.statuses[project] ?? {}), model: before.model, modelAuto: before.modelAuto };
    renderComposer();
    toast(err.message);
  }
}

export async function saveSettings() {
  try {
    const agent = $('#agent-ctl').hidden ? undefined : $('#agent').value; // OpenCode only
    const effort = $('#effort').value;
    const auto = effort === 'auto';
    // Model Auto is a boolean setting: never send the sentinel as a model, and any concrete pick turns Auto off.
    const pick = $('#model').value;
    await api(`/api/projects/${state.active}/settings`, {
      mode: $('#mode').value,
      ...(pick === AUTO_MODEL ? { modelAuto: true } : { model: pick, modelAuto: false }),
      ...(auto ? { effortAuto: true } : { effort, effortAuto: false }),
      team: $('#team-mode').checked,
      ...(agent !== undefined && { agent }),
    });
  } catch (err) {
    toast(err.message);
  }
}

// Bash mode: a prompt starting with ! runs as a shell command; the box shows it.
export function updateBashMode() {
  $('#composer').classList.toggle('bash-mode', $('#prompt').value.startsWith('!'));
}

// When Esc was last pressed while idle (Esc Esc clears the box or opens Rewind).
let lastEsc = 0;

export function initComposerInput() {
  $('#prompt').addEventListener('input', autosize);
  narrow.addEventListener('change', applyPlaceholder);
  applyPlaceholder();
}

export function initComposerControls() {
  $('#prompt').addEventListener('keydown', (e) => {
    const plainArrow = (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
    if (plainArrow && !suggest.items.length && recallPrompt(e.key === 'ArrowUp' ? -1 : 1)) {
      e.preventDefault();
      return;
    }
    if (suggest.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        suggest.index = (suggest.index + (e.key === 'ArrowDown' ? 1 : -1) + suggest.items.length) % suggest.items.length;
        renderSuggest();
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        applySuggest();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSuggest();
        return;
      }
    }
    // After a template: Tab selects its next {placeholder}; with none left, Tab moves focus as usual.
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && tabToPlaceholder(e.target)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendPrompt();
      return;
    }
    // Ctrl+R: search the prompt history (the browser's reload is not what you want while typing).
    if (e.key.toLowerCase() === 'r' && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      searchHistory();
    }
  });
  // Ctrl+B anywhere: the running Bash commands / subagents carry on in the background, as in the CLI.
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'b' || !e.ctrlKey || e.shiftKey || e.altKey || state.active === DEMO_ID || state.readOnly) return;
    if (!(state.statuses[state.active] ?? {}).busy) return;
    e.preventDefault();
    backgroundRunning();
  });
  // Esc stops the running turn, like in the CLI; Esc Esc when idle clears the box, or opens Rewind when it is empty.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || suggest.items.length || state.active === DEMO_ID || state.readOnly) return;
    if (document.querySelector('.modal:not([hidden])')) return; // Esc closes the dialog instead
    const st = state.statuses[state.active] ?? {};
    if (stoppable(st)) {
      api(`/api/projects/${state.active}/stop`).catch((err) => toast(err.message));
      return;
    }
    const now = Date.now();
    if (now - lastEsc > 500) {
      lastEsc = now;
      return;
    }
    lastEsc = 0;
    const input = $('#prompt');
    if (input.value.trim()) {
      input.value = '';
      autosize();
      updateBashMode();
      scheduleDraftSave();
      input.focus();
    } else if (!guardCap('rewind')) openRewind(); // an engine without rewind gets the guard's reason instead
  });

  // Shift+Tab cycles the permission mode, like in the CLI (only from the prompt box, so Tab navigation still works elsewhere).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !e.shiftKey || e.defaultPrevented || state.active === DEMO_ID || state.readOnly) return; // defaultPrevented: Tab picked an autocomplete item
    if (e.target !== $('#prompt') && e.target !== document.body) return;
    e.preventDefault();
    cycleMode();
  });

  $('#prompt').addEventListener('input', updateBashMode);
  $('#btn-send').addEventListener('click', sendPrompt);
  $('#btn-stop').addEventListener('click', () => api(`/api/projects/${state.active}/stop`).catch((err) => toast(err.message)));
  $('#btn-new').addEventListener('click', () => {
    if (confirmNew()) api(`/api/projects/${state.active}/reset`).catch((err) => toast(err.message));
  });
  $('#btn-demo').addEventListener('click', () => api('/api/demo').catch((err) => toast(err.message)));
  // Engine picker + the searchable per-project model list (features/engine.js).
  initEngine({ onModelPicked: saveModel, rerender: renderComposer });
  $('#model').addEventListener('change', saveModel);
  // Model Auto ladder dialog: one <select> per tier, saved for the project's engine.
  $('#tiers-rows').addEventListener('change', () => {
    tiersView.dirty = true;
  });
  $('#tiers-save').addEventListener('click', saveModelTiers);
  // The dialog opens from inside the "Pengaturan giliran" sheet, so the generic modal focus restore never runs for it:
  // closing it (Esc, ✕, backdrop, Simpan) hands focus back to its "Atur tangga…" link.
  new MutationObserver(() => {
    if (!$('#model-tiers-modal').hidden) return;
    const opener = $('#model-tiers-open');
    if (opener?.getClientRects().length) opener.focus({ preventScroll: true });
  }).observe($('#model-tiers-modal'), { attributeFilter: ['hidden'] });
  for (const id of ['#mode', '#agent', '#effort', '#team-mode']) {
    $(id).addEventListener('change', saveSettings);
    $(id).addEventListener('change', () => renderSettingsChip(state.statuses[state.active])); // right away, before the server echoes it
  }
}
