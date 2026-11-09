// Quota warnings: a toast (+ browser notification when 🔔 is on) the first time a plan window passes each
// threshold in a reset period, and a coloured indicator in the top bar while one is high.
// Built only from what the page already has (rate_limit_event from sessions, the last `/usage`): no extra requests.
import { toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { alertText, cleanThresholds, evaluateQuota, quotaTooltip, quotaWindows, thresholdError, tone } from '../core/quota-rules.js';
import { state } from '../core/state.js';
import { notifyNotice } from './notify.js';

export const QUOTA_SETTINGS_KEY = 'office.quotaAlerts';
export const QUOTA_MEMORY_KEY = 'office.quotaWarned';
const RECHECK_MS = 60_000; // a reset time passing clears the indicator without any event

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null; // blocked storage or a hand-edited value: start over
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // not remembered: at worst a warning shows again after a reload
  }
}

export const quotaSettings = () => cleanThresholds(readJson(QUOTA_SETTINGS_KEY));

/**
 * The key of an account profile: its uuid or email, or on a read-only (plain WiFi) phone the opaque `accountKey`
 * the server sends instead (no email/uuid there, for privacy).
 */
export const accountKeyOf = (p) => p?.accountUuid ?? p?.email ?? p?.accountKey ?? null;

/** Warnings are remembered per account: another account has its own quota. */
const accountId = () => accountKeyOf(state.account?.profile);

/** Looks at the current numbers: announces new thresholds once, then redraws the indicator. */
export function checkQuota(now = Date.now()) {
  const th = quotaSettings();
  const windows = quotaWindows(state.account, now);
  const id = accountId();
  if (id) {
    const saved = readJson(QUOTA_MEMORY_KEY);
    const memory = saved?.account === id ? saved.windows : {};
    const { alerts, memory: next } = evaluateQuota(windows, memory, th, now);
    if (alerts.length || JSON.stringify(next) !== JSON.stringify(memory ?? {})) writeJson(QUOTA_MEMORY_KEY, { account: id, windows: next });
    if (alerts.length) {
      // One toast for all windows at once (one message reads better than a stack of near-identical alerts).
      alerts.sort((a, b) => b.level - a.level);
      const text = alerts.map((a) => alertText(a, now)).join(' ');
      toast(text, alerts[0].level >= th.crit ? 'error' : 'warn');
      notifyNotice('Adhitron: kuota Claude', text, 'quota');
    }
  }
  renderQuotaIndicator(windows, th, now);
}

/** The top-bar pill: hidden below the yellow threshold, yellow ≥ warn, red ≥ crit or when used up. */
function renderQuotaIndicator(windows, th, now) {
  const pill = $('#quota-pill');
  const high = windows
    .map((w) => ({ w, tone: tone(w, th) }))
    .filter((x) => x.tone)
    .sort((a, b) => Number(b.w.limited) - Number(a.w.limited) || b.w.percent - a.w.percent);
  if (!high.length) {
    pill.hidden = true;
    return;
  }
  const top = high[0];
  const tip = high.map((x) => quotaTooltip(x.w, now)).join('\n');
  pill.hidden = false;
  pill.classList.toggle('crit', top.tone === 'crit');
  pill.classList.toggle('warn', top.tone === 'warn');
  pill.title = `${tip}\nKlik untuk detail kuota`;
  pill.setAttribute('aria-label', `Peringatan kuota: ${high.map((x) => quotaTooltip(x.w, now)).join('; ')}`);
  pill.innerHTML = `<span class="dot" aria-hidden="true"></span><span>${top.w.limited ? 'habis' : `${top.w.percent}%`}</span>`;
}

// ---------- ⚙ Pengaturan → Peringatan kuota ----------

function syncSettingsForm() {
  const th = quotaSettings();
  $('#quota-on').checked = th.enabled;
  $('#quota-warn').value = String(th.warn);
  $('#quota-crit').value = String(th.crit);
  $('#quota-warn').disabled = !th.enabled;
  $('#quota-crit').disabled = !th.enabled;
  $('#quota-error').textContent = '';
}

/** Saves the form when valid; otherwise shows why and keeps the stored values. */
function saveSettingsForm() {
  const enabled = $('#quota-on').checked;
  const warn = $('#quota-warn').value.trim();
  const crit = $('#quota-crit').value.trim();
  const error = enabled ? thresholdError(warn, crit) : null;
  $('#quota-error').textContent = error ?? '';
  for (const id of ['#quota-warn', '#quota-crit']) $(id).setAttribute('aria-invalid', String(Boolean(error)));
  $('#quota-warn').disabled = !enabled;
  $('#quota-crit').disabled = !enabled;
  if (error) return;
  const prev = quotaSettings();
  const next = enabled ? { enabled, warn: Number(warn), crit: Number(crit) } : { ...prev, enabled: false };
  writeJson(QUOTA_SETTINGS_KEY, next);
  checkQuota();
}

export function initQuota() {
  $('#quota-pill').addEventListener('click', () => $('#btn-account').click()); // the account dialog shows every window
  $('#quota-on').addEventListener('change', saveSettingsForm);
  for (const id of ['#quota-warn', '#quota-crit']) {
    $(id).addEventListener('change', saveSettingsForm);
    // These fields sit in the roots form: Enter must not submit it (that would rescan the project folders).
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      saveSettingsForm();
    });
  }
  $('#btn-settings').addEventListener('click', syncSettingsForm);
  syncSettingsForm();
  setInterval(() => checkQuota(), RECHECK_MS);
}
