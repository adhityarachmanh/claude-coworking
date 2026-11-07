// ★ Pesan tersimpan, per project, in this browser only (localStorage): a quick way back to a decision, a command
// that worked, or an explanation. Only the message id, role, a short text and its time are kept; nothing leaves
// the device and no server route is involved.
const KEY = 'office.bookmarks';
const MAX_PER_PROJECT = 50;
const TEXT_MAX = 600;

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage off (private mode): the star still works until the next render
  }
}

/** Saved messages of a project, newest save first. */
export function bookmarksOf(projectId) {
  const list = readAll()[projectId];
  if (!Array.isArray(list)) return [];
  return list.filter((b) => b && typeof b.id === 'string' && typeof b.text === 'string');
}

export function isBookmarked(projectId, id) {
  return bookmarksOf(projectId).some((b) => b.id === id);
}

/** Adds or removes one message; returns true when it is now saved. */
export function toggleBookmark(projectId, msg) {
  const all = readAll();
  const list = Array.isArray(all[projectId]) ? all[projectId].filter((b) => b && typeof b.id === 'string') : [];
  const at = list.findIndex((b) => b.id === msg.id);
  if (at >= 0) {
    list.splice(at, 1);
    all[projectId] = list;
    writeAll(all);
    return false;
  }
  const text = String(msg.text ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
  list.unshift({ id: msg.id, role: msg.kind === 'user' ? 'user' : 'claude', text, ts: Number(msg.ts) || Date.now() });
  all[projectId] = list.slice(0, MAX_PER_PROJECT);
  writeAll(all);
  return true;
}

export function removeBookmark(projectId, id) {
  const all = readAll();
  const list = Array.isArray(all[projectId]) ? all[projectId] : [];
  all[projectId] = list.filter((b) => b?.id !== id);
  writeAll(all);
}
