// 🌉 Settings file for `office claude`: only a PreToolUse hook pointing at our helper. It lives in the app's data
// folder (never ~/.claude/settings.json) and is deleted when the wrapper exits.
export const HOOK_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|WebFetch|WebSearch|mcp__.*';
export const HOOK_TIMEOUT_SECONDS = 120;

const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;

/** The exact command Claude Code runs: the current Node binary, our hook, and the short-lived token file. */
export function hookCommand(nodePath, hookPath, tokenFile = '') {
  return [nodePath, hookPath, tokenFile].filter(Boolean).map(quote).join(' ');
}

export function buildSettings({ nodePath, hookPath, tokenFile = '', timeout = HOOK_TIMEOUT_SECONDS } = {}) {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: HOOK_MATCHER,
          hooks: [{ type: 'command', command: hookCommand(nodePath, hookPath, tokenFile), timeout }],
        },
      ],
    },
  };
}
