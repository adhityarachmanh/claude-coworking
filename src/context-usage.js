// 📊 Context breakdown from Claude Code's `get_context_usage` (detail "full"): the same categories /context shows.
// Tolerant: an older CLI without the detail fields simply yields no rows; numbers are never trusted blindly.
const n = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

const CATEGORIES = [
  ['system', 'Prompt sistem', ['systemPromptTokens']],
  ['memory', 'Memory & CLAUDE.md', ['claudeMdTokens']],
  ['tools', 'Tool bawaan', ['builtInToolTokens', 'deferredBuiltinTokens']],
  ['mcp', 'Tool MCP', ['mcpToolTokens']],
  ['mcpInstructions', 'Instruksi MCP', ['mcpInstructionsTokens']],
  ['agents', 'Agent kustom', ['agentTokens']],
  ['commands', 'Command & skill', ['slashCommandTokens']],
  ['conversation', 'Percakapan, tool & lampiran', ['toolCallTokens', 'toolResultTokens', 'attachmentTokens', 'userMessageTokens', 'assistantMessageTokens']],
];

/** [{ key, label, tokens, percent }] for the categories the CLI reported, biggest first. */
export function contextBreakdown(raw) {
  const rows = CATEGORIES.map(([key, label, fields]) => ({ key, label, tokens: fields.reduce((sum, field) => sum + n(raw?.[field]), 0) })).filter((row) => row.tokens > 0);
  const total = n(raw?.totalTokens) || rows.reduce((sum, row) => sum + row.tokens, 0);
  return rows
    .map((row) => ({ ...row, percent: total > 0 ? Math.min(100, Math.round((row.tokens / total) * 100)) : 0 }))
    .sort((a, b) => b.tokens - a.tokens);
}
