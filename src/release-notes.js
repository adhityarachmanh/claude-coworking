// 📜 Release notes for the `CHANGELOG.md` bundled with the app: the `##` sections, newest first. Pure: the route owns
// reading the file, so the parser stays testable without the file system.
const HEADING = /^##[ \t]+(.+?)[ \t]*$/gm;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 8;

/**
 * @param {string} markdown the CHANGELOG's text (anything that is not a string yields [])
 * @param {{ limit?: number }} [options] how many sections to keep (default 8, clamped to 1..50)
 * @returns {Array<{ version: string, body: string }>} `version` is the heading text; `body` is its content
 */
export function parseReleaseNotes(markdown, { limit = DEFAULT_LIMIT } = {}) {
  if (typeof markdown !== 'string' || !markdown) return [];
  const take = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(Number(limit)) || DEFAULT_LIMIT));
  const sections = [];
  const matches = [...markdown.matchAll(HEADING)];
  for (let i = 0; i < matches.length && sections.length < take; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
    const version = matches[i][1].trim();
    if (!version) continue;
    sections.push({ version, body: markdown.slice(start, end).trim() });
  }
  return sections;
}
