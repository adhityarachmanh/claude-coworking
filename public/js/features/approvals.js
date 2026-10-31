// Permission cards in the chat: questions, plans, tool approvals.
import { api, toast } from '../core/api.js';
import { escapeHtml } from '../core/dom.js';
import { READ_ONLY_HINT, state } from '../core/state.js';
import { renderMarkdown } from '../markdown.js';
import { who } from './chat.js';

// ---------- approvals ----------

export function fillApproval(node, msg) {
  const approval = state.approvals.get(msg.approvalId);
  const status = approval?.status ?? msg.status;
  node.className = `approval ${status}`;
  const head = `<div class="ap-head">${who(msg.role)}<span>minta izin · ${escapeHtml(approval?.tool ?? '')}</span></div>`;
  if (status !== 'pending' || !approval) {
    const label = { allowed: '✓ Diizinkan', denied: '✗ Ditolak', cancelled: '– Dibatalkan', pending: '… Menunggu' }[status] ?? status;
    node.innerHTML = `${head}<div class="ap-label">${escapeHtml(msg.text)}</div><div class="ap-status">${label}</div>`;
    return;
  }
  const input = approval.input ?? {};
  let body = '';
  let actions = '';
  if (approval.kind === 'question') {
    // Every question also takes a typed answer, like the CLI's "Other" option.
    body = (input.questions ?? [])
      .map((q, qi) => `<div class="q"><b>${escapeHtml(q.question)}</b><div class="opts">${(q.options ?? [])
        .map((o) => `<label><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q${qi}" value="${escapeHtml(o.label)}"> <span><b>${escapeHtml(o.label)}</b>${o.description ? ` — ${escapeHtml(o.description)}` : ''}</span></label>`)
        .join('')}</div><input class="other-text" data-q="${qi}" placeholder="Atau tulis jawaban sendiri…" aria-label="Jawaban sendiri"></div>`)
      .join('');
    actions = '<button class="primary" data-act="answer">Kirim jawaban</button><button data-act="deny">Lewati</button>';
  } else if (approval.kind === 'plan') {
    // The CLI's plan dialog: approve and choose how edits are handled, or keep planning with feedback.
    body = `<div class="plan md">${renderMarkdown(input.plan ?? '')}</div><input class="feedback" placeholder="Catatan revisi (untuk Minta revisi)" aria-label="Catatan revisi rencana">`;
    actions =
      '<button class="primary" data-act="allow" data-mode="acceptEdits" title="Mode berubah ke ✏️ Auto-edit file">✓ Setujui, auto-edit</button><button data-act="allow" data-mode="manual" title="Mode berubah ke 🛡️ Tanya dulu">✓ Setujui, tanya tiap edit</button><button data-act="deny">Minta revisi</button>';
  } else {
    if (input.command) body = `<pre>${escapeHtml(input.command)}</pre>${input.description ? `<p class="muted">${escapeHtml(input.description)}</p>` : ''}`;
    else if (input.content != null) body = `<p class="path">${escapeHtml(input.file_path)}</p><pre>${escapeHtml(input.content)}</pre>`;
    else if (input.old_string != null) body = `<p class="path">${escapeHtml(input.file_path)}</p><pre class="del">${escapeHtml(input.old_string)}</pre><pre class="add">${escapeHtml(input.new_string)}</pre>`;
    else if (input.url) body = `<pre>${escapeHtml(input.url)}</pre>`;
    else body = `<pre>${escapeHtml(input.json ?? JSON.stringify(input, null, 2))}</pre>`;
    // "No, and tell Claude what to do differently": the note goes back to Claude with the refusal.
    body += '<input class="feedback" placeholder="Kalau menolak: beri tahu Claude harus bagaimana (opsional)" aria-label="Alasan menolak (opsional)">';
    actions = `<button class="primary" data-act="allow">Izinkan</button>${approval.canAlways ? '<button data-act="always" title="Simpan aturan izin agar tidak ditanya lagi">Izinkan selalu</button>' : ''}<button data-act="all" title="Semua aksi berikutnya di sesi ini otomatis diizinkan">Izinkan semua (sesi ini)</button><button class="danger" data-act="deny">Tolak</button>`;
  }
  node.innerHTML = `${head}<div class="ap-label">${escapeHtml(approval.description || msg.text)}</div>${body}<div class="ap-actions">${actions}</div>`;
  if (state.readOnly) {
    // Visible, so the phone knows the team is waiting; answered from the laptop or over Tailscale.
    node.querySelectorAll('button, input').forEach((el) => (el.disabled = true));
    node.insertAdjacentHTML('beforeend', `<p class="ro-note">👁 ${READ_ONLY_HINT}: jawab izin ini dari laptop atau HP lewat Tailscale.</p>`);
    return;
  }
  node.querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', () => decide(approval, btn.dataset.act, node, btn.dataset.mode)),
  );
}

async function decide(approval, act, node, mode) {
  const body = { allow: act !== 'deny' };
  if (act === 'always') body.always = true;
  if (act === 'all') body.allowAll = true;
  if (mode) body.mode = mode; // plan approved: the mode the work continues in
  if (act === 'deny') body.message = node.querySelector('.feedback')?.value || undefined;
  if (act === 'answer') {
    const answers = {};
    (approval.input.questions ?? []).forEach((q, qi) => {
      const picked = [...node.querySelectorAll(`input[name="q${qi}"]:checked`)].map((i) => i.value);
      const own = node.querySelector(`.other-text[data-q="${qi}"]`)?.value.trim();
      // A typed answer replaces a single choice and joins multiple ones.
      if (own) picked.splice(0, q.multiSelect ? 0 : picked.length, own);
      if (picked.length) answers[q.question] = picked.join(', ');
    });
    body.answers = answers;
  }
  node.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    await api(`/api/approvals/${approval.id}`, body);
  } catch (err) {
    toast(`Gagal mengirim keputusan: ${err.message}`);
    node.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}
