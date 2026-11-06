// The one hint line under the composer: the most important messages on screen, all of them in the tooltip.
// Priority: read-only (the box cannot send), auto-approve (a warning), the running turn, then the terminal session.

const MAX_HINTS = 2;

export function composerHints(st = {}, { readOnly = false, readOnlyHint = '' } = {}) {
  const hints = [];
  if (readOnly) hints.push(`👁 ${readOnlyHint}.`);
  if (st.autoApprove) hints.push('⚠ Semua izin otomatis.');
  if (st.busy) hints.push(st.queue ? `Tim bekerja — ${st.queue} pesan antre.` : 'Tim bekerja — pesan baru dibaca di langkah berikutnya.');
  else if (st.cliBusy) hints.push('Sesi terminal berjalan.');
  return hints;
}

export function hintLine(hints, max = MAX_HINTS) {
  const all = hints.filter(Boolean);
  return { text: all.slice(0, max).join(' · '), title: all.join(' · ') };
}
