// 🔁 The engine commands Adhitron may send to a Claude session as a prompt: plugin/skill reload and /init. Exact
// strings only — never a free-form command — so a UI button cannot become a remote shell.
export const ENGINE_COMMANDS = Object.freeze({
  '/reload-plugins': 'Muat ulang plugin',
  '/reload-skills': 'Muat ulang skill',
  '/init': 'Buat/segarkan CLAUDE.md',
});

/** The allowed command text (trimmed), or null when it is not one of ENGINE_COMMANDS. */
export function normalizeEngineCommand(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return Object.hasOwn(ENGINE_COMMANDS, text) ? text : null;
}
