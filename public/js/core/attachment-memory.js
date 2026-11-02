// 📎 Attachment memory, the pure part (no DOM): the files sent with the last few web prompts of each project,
// kept in browser memory only (never localStorage: too big, and screenshots/logs can be private) so ↻ Ulangi and
// Edit can bring them back. A page reload empties it; the chat bubble then only has chips ({ kind, name, size }).
//
// A sent prompt is found again by its chips: the server builds them from the same rules (safeName, size, kind),
// so the bubble's chips match what the browser sent byte for byte.

export const MEMORY_LIMITS = Object.freeze({
  perProject: 5, // last N prompts with attachments per project
  totalBytes: 60 * 1024 * 1024, // across all projects; the oldest entries go first
});

/** Stable key of an attachment list: kind, name and size of each file, in order. '' for none. */
export const chipSignature = (list) => (Array.isArray(list) ? list.map((a) => `${a?.kind}:${a?.name}:${a?.size}`).join('|') : '');

const bytesOf = (items) => items.reduce((sum, a) => sum + (Number(a?.size) || 0), 0);

/**
 * @param {{ perProject?: number, totalBytes?: number }} limits
 * @returns {{ remember(project: string, items: object[]): void, recall(project: string, chips: object[]): object[]|null, size(): number }}
 */
export function createAttachmentMemory(limits = MEMORY_LIMITS) {
  const { perProject = MEMORY_LIMITS.perProject, totalBytes = MEMORY_LIMITS.totalBytes } = limits;
  // Oldest first; each entry { project, signature, items, bytes }.
  let entries = [];

  return {
    /** Keeps a copy of the files just sent (a resend of the same files moves them to the newest place). */
    remember(project, items) {
      if (!project || !Array.isArray(items) || !items.length) return;
      const signature = chipSignature(items);
      const copy = items.map((a) => ({ ...a }));
      const bytes = bytesOf(copy);
      if (bytes > totalBytes) return; // never fits: not kept, and nothing older is pushed out for it
      entries = entries.filter((e) => !(e.project === project && e.signature === signature));
      entries.push({ project, signature, items: copy, bytes });
      // Per project: only the newest N.
      const mine = entries.filter((e) => e.project === project);
      if (mine.length > perProject) {
        const drop = new Set(mine.slice(0, mine.length - perProject));
        entries = entries.filter((e) => !drop.has(e));
      }
      // Overall size: drop the oldest until it fits.
      let total = entries.reduce((sum, e) => sum + e.bytes, 0);
      while (total > totalBytes && entries.length) total -= entries.shift().bytes;
    },

    /** Copies of the files sent with a prompt whose bubble shows `chips`, or null when they are not in memory. */
    recall(project, chips) {
      const signature = chipSignature(chips);
      if (!signature) return null;
      const hit = entries.findLast((e) => e.project === project && e.signature === signature);
      return hit ? hit.items.map((a) => ({ ...a })) : null;
    },

    /** Number of prompts kept (all projects). */
    size: () => entries.length,
  };
}
