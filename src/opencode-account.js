/**
 * Ledger account for OpenCode turns. OpenCode has no single provider account: its providers (OpenCode Go,
 * Gemini, ...) are separate integrations. Grouping all of them as one opaque account keeps reports separate
 * from Claude accounts without exposing provider credentials or identities.
 */
export const OPENCODE_ACCOUNT = Object.freeze({ id: 'opencode', email: 'OpenCode', org: null });
