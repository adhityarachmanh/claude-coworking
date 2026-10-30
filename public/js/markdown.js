// Minimal, safe markdown → HTML for chat messages (escapes first, then adds a small set of formats).
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const KEYWORDS = new Set(
  ('const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of ' +
    'def elif lambda pass yield with as raise None True False self public private protected static final void int string bool boolean interface type enum namespace use echo fn match ' +
    'null undefined true false this super select insert update delete where join into values create table alter drop and or not').split(' '),
);
const HASH_COMMENT = new Set(['py', 'python', 'sh', 'bash', 'shell', 'ps1', 'powershell', 'yaml', 'yml', 'rb', 'toml', 'dockerfile', 'env']);

/** Tiny tokenizer-based highlighter: comments, strings, numbers, keywords. Output is escaped. */
function highlight(code, lang) {
  const hash = HASH_COMMENT.has(lang);
  const dashComments = lang === 'sql' || lang === 'lua';
  const pattern = new RegExp(
    [
      hash ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|<!--[\\s\\S]*?-->',
      dashComments ? '--[^\\n]*' : '(?!)',
      '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`',
      '\\b\\d+(?:\\.\\d+)?\\b',
      '\\b[A-Za-z_$][\\w$]*\\b',
    ].join('|'),
    'g',
  );
  let out = '';
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    const token = match[0];
    out += escapeHtml(code.slice(last, match.index));
    last = match.index + token.length;
    let cls = '';
    if (/^(\/\/|\/\*|#|<!--)/.test(token) || (dashComments && token.startsWith('--'))) cls = 'c';
    else if (/^["'`]/.test(token)) cls = 's';
    else if (/^\d/.test(token)) cls = 'n';
    else if (KEYWORDS.has(token) || (lang === 'sql' && KEYWORDS.has(token.toLowerCase()))) cls = 'k';
    out += cls ? `<span class="hl-${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
  }
  return out + escapeHtml(code.slice(last));
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function table(lines) {
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const [head, , ...body] = lines;
  return `<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
    .map((row) => `<tr>${cells(row).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      closeList();
      const lang = line.trim().slice(3).trim().toLowerCase();
      const code = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith('```')) code.push(lines[i]);
      const bar = `<span class="code-bar">${lang ? `<span class="lang">${escapeHtml(lang)}</span>` : ''}<button type="button" class="copy" data-copy-code title="Salin kode">Salin</button></span>`;
      out.push(`<pre class="code">${bar}<code>${highlight(code.join('\n'), lang)}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:-]+\|/.test(lines[i + 1] ?? '')) {
      closeList();
      const rows = [line];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(lines[++i]);
      out.push(table(rows));
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<h4>${inline(heading[2])}</h4>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) {
        closeList();
        out.push(`<${type}>`);
        list = type;
      }
      out.push(`<li>${inline((bullet ?? numbered)[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('');
}
