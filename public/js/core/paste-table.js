// 📋 Pasting cells copied from Excel (or any spreadsheet): the clipboard carries tab-separated text plus an HTML
// table. Turning the TSV into a Markdown table keeps the rows/columns readable for the model instead of one long line.
export const PASTE_TABLE_MAX_ROWS = 100;
export const PASTE_TABLE_MAX_COLS = 30;

const cleanCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();

/** A spreadsheet copy has at least two lines and a tab; a single column/list stays plain text. */
export function looksLikeTable(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.length);
  return lines.length >= 2 && lines.some((l) => l.includes('\t'));
}

/** TSV → a Markdown table (first row = header), bounded; null when it is not really tabular. */
export function tsvToMarkdown(text, { maxRows = PASTE_TABLE_MAX_ROWS, maxCols = PASTE_TABLE_MAX_COLS } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length < 2 || !lines.some((l) => l.includes('\t'))) return null;
  const rows = lines.slice(0, maxRows).map((line) => {
    const cells = line.split('\t').slice(0, maxCols).map(cleanCell);
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    return cells;
  });
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 2) return null;
  const padded = rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
  const [head, ...body] = padded;
  const out = [
    `| ${head.join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  const dropped = lines.length - rows.length;
  if (dropped > 0) out.push(`_(${dropped} baris lagi tidak disertakan.)_`);
  return out.join('\n');
}
