// Rules for the phone "mode baca" pill (features/phone-fold.js): what must stay visible while the composer is folded
// away so folding never hides something that needs a decision. Pure — no DOM, no state — so it is tested on its own
// (test/fold-rules.test.mjs).

/** The three things worth an icon on the pill, in the order they are shown. */
export const FOLD_FLAGS = {
  pending: { icon: '✋', label: 'ada izin menunggu' },
  offline: { icon: '⚡', label: 'belum tersambung' },
  busy: { icon: '⏳', label: 'sedang bekerja' },
};

/** Icons for the folded composer's pill: waiting permission, lost connection, turn in progress. */
export function foldFlags({ pending = false, busy = false, online = true } = {}) {
  const out = [];
  if (pending) out.push(FOLD_FLAGS.pending);
  if (!online) out.push(FOLD_FLAGS.offline);
  if (busy) out.push(FOLD_FLAGS.busy);
  return out;
}
