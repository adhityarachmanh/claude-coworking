// 📊 A small, dependency-free .xlsx reader: Excel files are ZIP archives of XML, and the app only needs the cell
// text (not formulas, styles or charts). Everything is bounded so a hostile or huge workbook cannot exhaust memory.
import { inflateRawSync } from 'node:zlib';

const MAX_ENTRY = 20 * 1024 * 1024; // one XML part, uncompressed
const MAX_TOTAL = 60 * 1024 * 1024; // every part together
const MAX_ENTRIES = 5000;
const MAX_SHEETS = 10;
const MAX_ROWS = 1000;
const MAX_COLS = 100;
const MAX_CELLS = 50_000;
const MAX_OUTPUT = 150 * 1024; // below the attachment text limit (200 KB)

export class XlsxError extends Error {}

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** The ZIP entries we need: name -> uncompressed bytes (stored or deflated). Throws on a non-ZIP file. */
function unzip(bytes) {
  const eocdMin = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= eocdMin; i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('bukan arsip xlsx');
  const count = u16(bytes, eocd + 10);
  const cdOffset = u32(bytes, eocd + 16);
  if (!count || count > MAX_ENTRIES || cdOffset >= bytes.length) throw new XlsxError('arsip xlsx rusak');
  const map = new Map();
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) break;
    const method = u16(bytes, p + 10);
    const compressed = u32(bytes, p + 20);
    const uncompressed = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const local = u32(bytes, p + 42);
    const name = bytes.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.startsWith('xl/') && name !== '[Content_Types].xml') continue; // only the parts we read
    if (uncompressed > MAX_ENTRY || total + uncompressed > MAX_TOTAL) continue;
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) continue;
    const localName = u16(bytes, local + 26);
    const localExtra = u16(bytes, local + 28);
    const start = local + 30 + localName + localExtra;
    if (start + compressed > bytes.length) continue;
    const raw = bytes.subarray(start, start + compressed);
    let data;
    try {
      if (method === 0) data = raw;
      else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
      else continue;
    } catch {
      continue;
    }
    total += data.length;
    map.set(name, data);
  }
  if (!map.size) throw new XlsxError('tidak ada bagian xlsx');
  return map;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) =>
  String(s).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? decodeXml(m[1]) : '';
};

/** Concatenated `<t>` text of an `<si>` / `<is>` node (rich text runs included). */
const textOf = (xml) => [...String(xml).matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((m) => decodeXml(m[1])).join('');

const cellValue = (body) => {
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body || '');
  return v ? decodeXml(v[1]) : '';
};

/** Column letters (A, B, …, AA) to a zero-based index. */
function colIndex(ref) {
  const letters = /^([A-Z]+)/i.exec(ref)?.[1] ?? '';
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Sheet name + part path, from workbook.xml and its relationships; falls back to sheet1.xml. */
function sheetsOf(map, wanted) {
  const workbook = map.get('xl/workbook.xml');
  const rels = map.get('xl/_rels/workbook.xml.rels');
  const targets = new Map();
  if (rels) {
    for (const m of rels.toString('utf8').matchAll(/<Relationship\b[^>]*>/gi)) {
      const id = attr(m[0], 'Id');
      const target = attr(m[0], 'Target');
      if (id && target) targets.set(id, target);
    }
  }
  const out = [];
  if (workbook) {
    for (const m of workbook.toString('utf8').matchAll(/<sheet\b[^>]*>/gi)) {
      const name = attr(m[0], 'name') || `Sheet${out.length + 1}`;
      const rid = attr(m[0], 'r:id');
      let target = targets.get(rid) ?? '';
      if (target.startsWith('/')) target = target.slice(1);
      else if (target && !target.startsWith('xl/')) target = `xl/${target}`;
      if (target && map.has(target)) out.push({ name, path: target });
    }
  }
  if (!out.length) {
    for (const name of wanted) if (name.startsWith('xl/worksheets/') && name.endsWith('.xml')) out.push({ name: name.split('/').pop().replace(/\.xml$/i, ''), path: name });
  }
  return out;
}

/**
 * Reads every sheet into a tab-separated text block (the most compact form a model reads well). Bounded: 10 sheets,
 * 1000 rows and 100 columns per sheet, 50k cells, 150 KB of output. Dates can appear as Excel serial numbers.
 */
export function xlsxToText(bytes) {
  const map = unzip(bytes);
  const shared = [];
  const sst = map.get('xl/sharedStrings.xml');
  if (sst) for (const m of sst.toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) shared.push(textOf(m[1]));
  const sheets = sheetsOf(map, [...map.keys()]).slice(0, MAX_SHEETS);
  if (!sheets.length) throw new XlsxError('tidak ada worksheet');
  const out = [];
  let cells = 0;
  let truncated = false;
  let outputLength = 0;
  const push = (line) => {
    out.push(line);
    outputLength += line.length + 1;
    return outputLength > MAX_OUTPUT;
  };
  for (const sheet of sheets) {
    const xml = map.get(sheet.path).toString('utf8');
    const rows = [];
    let rowCount = 0;
    let colCount = 0;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
      if (rowCount >= MAX_ROWS || cells >= MAX_CELLS) {
        truncated = true;
        break;
      }
      const values = [];
      let next = 0;
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi)) {
        const ref = attr(c[1], 'r');
        const type = attr(c[1], 't');
        const body = c[2] ?? '';
        const col = ref ? colIndex(ref) : next;
        if (col < 0 || col >= MAX_COLS) continue;
        next = col + 1;
        let value = '';
        if (type === 's') value = shared[Number(cellValue(body))] ?? '';
        else if (type === 'inlineStr') value = textOf(body);
        else if (type === 'str') value = textOf(body) || cellValue(body);
        else if (type === 'b') value = cellValue(body) === '1' ? 'TRUE' : 'FALSE';
        else value = cellValue(body);
        values[col] = String(value).replace(/[\t\r\n]+/g, ' ').trim();
        cells++;
      }
      while (values.length && !values[values.length - 1]) values.pop();
      if (!values.length) continue; // a blank row adds nothing
      rowCount++;
      colCount = Math.max(colCount, values.length);
      rows.push(values.map((v) => v ?? '').join('\t'));
    }
    if (push(`### Sheet: ${sheet.name}`) || push(`(${rowCount} baris × ${colCount} kolom${truncated ? ' — dipotong' : ''})`) || rows.some((line) => push(line)) || push('')) {
      truncated = true;
      break;
    }
  }
  push('_Sel Excel dibaca sebagai teks; tanggal/jam bisa tampil sebagai angka serial._');
  return out.join('\n').slice(0, MAX_OUTPUT);
}
