// OpenCode advanced config for the editor's form: compaction, warming, snapshots, watcher, formatter, media,
// tool_output, experimental.* and provider headers/body. Unknown keys at every level survive a save; "inherit"
// (or an untouched field) never changes the file. A shape the form cannot represent (a formatter object) is left
// exactly as it was for the JSON tab.
export const ADVANCED_LIMITS = Object.freeze({ ignore: 100, entry: 500, number: 10_000_000, depth: 5, buffer: 20, warming: 500, duration: 40, model: 200 });

export class OpenCodeAdvancedError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const tri = (value) => (value === true ? 'on' : value === false ? 'off' : 'inherit');
const num = (value) => (Number.isInteger(value) ? value : '');
const text = (value) => (typeof value === 'string' ? value : '');
const obj = (value) => (isObject(value) ? value : {});

const requireObject = (parent, key, name) => {
  if (parent[key] === undefined) parent[key] = {};
  if (!isObject(parent[key])) throw new OpenCodeAdvancedError(400, `Bagian "${name}" bukan objek. Perbaiki lewat tab JSON dulu.`);
  return parent[key];
};

const cleanInt = (value, { name, max = ADVANCED_LIMITS.number, min = 0 }) => {
  if (value === '' || value == null) return null;
  const textValue = String(value).trim();
  if (!/^\d+$/.test(textValue)) throw new OpenCodeAdvancedError(400, `${name} harus berupa angka bulat.`);
  const parsed = Number(textValue);
  if (parsed < min || parsed > max) throw new OpenCodeAdvancedError(400, `${name} harus ${min}–${max}.`);
  return parsed;
};

const cleanText = (value, { name, max }) => {
  const parsed = String(value ?? '').trim();
  if (!parsed) return null;
  if (parsed.length > max) throw new OpenCodeAdvancedError(400, `${name} maksimal ${max} karakter.`);
  return parsed;
};

const triValue = (value, name) => {
  if (value === undefined || value === 'inherit') return 'inherit';
  if (value === 'on' || value === 'off') return value;
  throw new OpenCodeAdvancedError(400, `${name} harus inherit, on, atau off.`);
};

const dropIfEmpty = (parent, key) => {
  if (isObject(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
};

/** The form payload for the advanced keys; a missing/unrepresentable value becomes inherit/empty. */
export function advancedView(config = {}) {
  const media = isObject(config.media) ? config.media : {};
  const image = isObject(media.image) ? media.image : {};
  const output = isObject(config.tool_output) ? config.tool_output : {};
  const compaction = isObject(config.compaction) ? config.compaction : {};
  const keep = isObject(compaction.keep) ? compaction.keep : {};
  const warming = isObject(config.warming) ? config.warming : {};
  const experimental = isObject(config.experimental) ? config.experimental : {};
  const imageGenerate = isObject(experimental.image_generate) ? experimental.image_generate : {};
  const providers = isObject(config.providers) ? config.providers : {};
  return {
    snapshots: tri(config.snapshots),
    formatter: tri(config.formatter),
    watcherIgnore: Array.isArray(config.watcher?.ignore) ? config.watcher.ignore.filter((item) => typeof item === 'string') : [],
    mediaImage: {
      auto_resize: tri(image.auto_resize),
      maxWidth: num(image.max_width),
      maxHeight: num(image.max_height),
      maxBase64Bytes: num(image.max_base64_bytes),
    },
    toolOutput: { maxLines: num(output.max_lines), maxBytes: num(output.max_bytes) },
    compaction: { auto: tri(compaction.auto), keepTokens: num(keep.tokens), buffer: text(compaction.buffer) },
    warming: {
      enabled: config.warming === true || isObject(config.warming) ? 'on' : config.warming === false ? 'off' : 'inherit',
      prompt: text(warming.prompt),
      interval: text(warming.interval),
      duration: text(warming.duration),
    },
    experimental: {
      todo: tri(experimental.todo),
      subagentDepth: num(experimental.subagent_depth),
      imageModel: text(imageGenerate.model),
      locationIdleTimeout: experimental.location_idle_timeout === false ? 'false' : text(experimental.location_idle_timeout),
    },
    providers: Object.entries(providers)
      .filter(([, block]) => isObject(block) && (isObject(block.headers) || isObject(block.body)))
      .map(([id, block]) => ({
        id,
        headers: isObject(block.headers) ? JSON.stringify(block.headers) : '',
        body: isObject(block.body) ? JSON.stringify(block.body) : '',
      })),
  };
}

const writeTri = (owner, key, value, name) => {
  const parsed = triValue(value, name);
  if (parsed === 'inherit') return;
  owner[key] = parsed === 'on';
};

function mergeWatcher(config, ignore) {
  if (!Array.isArray(ignore)) throw new OpenCodeAdvancedError(400, 'Daftar watcher.ignore tidak valid.');
  if (ignore.length > ADVANCED_LIMITS.ignore) throw new OpenCodeAdvancedError(400, `Maksimal ${ADVANCED_LIMITS.ignore} pola watcher.`);
  const seen = new Set();
  const list = [];
  for (const item of ignore) {
    if (typeof item !== 'string') throw new OpenCodeAdvancedError(400, 'Setiap pola watcher harus berupa teks.');
    const clean = item.trim();
    if (!clean) continue;
    if (clean.length > ADVANCED_LIMITS.entry) throw new OpenCodeAdvancedError(400, `Satu pola watcher maksimal ${ADVANCED_LIMITS.entry} karakter.`);
    if (/[\u0000-\u001f\u007f]/.test(clean)) throw new OpenCodeAdvancedError(400, 'Pola watcher tidak boleh memuat karakter kontrol.');
    if (seen.has(clean)) continue;
    seen.add(clean);
    list.push(clean);
  }
  const watcher = requireObject(config, 'watcher', 'watcher');
  if (list.length) watcher.ignore = list;
  else delete watcher.ignore;
  dropIfEmpty(config, 'watcher');
}

function mergeMedia(config, form) {
  if (!isObject(form)) throw new OpenCodeAdvancedError(400, 'Pengaturan media tidak valid.');
  const write = form.auto_resize === 'on' || form.auto_resize === 'off' || form.maxWidth !== '' || form.maxHeight !== '' || form.maxBase64Bytes !== '';
  if (!write) return;
  const media = requireObject(config, 'media', 'media');
  const image = requireObject(media, 'image', 'media.image');
  writeTri(image, 'auto_resize', form.auto_resize, 'media.image.auto_resize');
  for (const [key, field, name] of [
    ['max_width', 'maxWidth', 'media.image.max_width'],
    ['max_height', 'maxHeight', 'media.image.max_height'],
    ['max_base64_bytes', 'maxBase64Bytes', 'media.image.max_base64_bytes'],
  ]) {
    const parsed = cleanInt(form[field], { name });
    if (parsed == null) delete image[key];
    else image[key] = parsed;
  }
  dropIfEmpty(media, 'image');
  dropIfEmpty(config, 'media');
}

function mergeToolOutput(config, form) {
  if (!isObject(form)) throw new OpenCodeAdvancedError(400, 'Pengaturan tool_output tidak valid.');
  const write = form.maxLines !== '' || form.maxBytes !== '';
  if (!write) return;
  const output = requireObject(config, 'tool_output', 'tool_output');
  for (const [key, field, name] of [
    ['max_lines', 'maxLines', 'tool_output.max_lines'],
    ['max_bytes', 'maxBytes', 'tool_output.max_bytes'],
  ]) {
    const parsed = cleanInt(form[field], { name });
    if (parsed == null) delete output[key];
    else output[key] = parsed;
  }
  dropIfEmpty(config, 'tool_output');
}

function mergeCompaction(config, form) {
  if (!isObject(form)) throw new OpenCodeAdvancedError(400, 'Pengaturan compaction tidak valid.');
  const write = form.auto === 'on' || form.auto === 'off' || form.keepTokens !== '' || form.buffer !== '';
  if (!write) return;
  const compaction = requireObject(config, 'compaction', 'compaction');
  writeTri(compaction, 'auto', form.auto, 'compaction.auto');
  const tokens = cleanInt(form.keepTokens, { name: 'compaction.keep.tokens' });
  if (tokens == null) {
    if (isObject(compaction.keep)) delete compaction.keep.tokens;
  } else {
    const keep = requireObject(compaction, 'keep', 'compaction.keep');
    keep.tokens = tokens;
  }
  dropIfEmpty(compaction, 'keep');
  const buffer = cleanText(form.buffer, { name: 'compaction.buffer', max: ADVANCED_LIMITS.buffer });
  if (buffer == null) delete compaction.buffer;
  else compaction.buffer = buffer;
  dropIfEmpty(config, 'compaction');
}

function mergeWarming(config, form) {
  if (!isObject(form)) throw new OpenCodeAdvancedError(400, 'Pengaturan warming tidak valid.');
  const enabled = triValue(form.enabled, 'warming.enabled');
  if (enabled === 'inherit') return;
  if (enabled === 'off') {
    config.warming = false;
    return;
  }
  const prompt = cleanText(form.prompt, { name: 'warming.prompt', max: ADVANCED_LIMITS.warming });
  const interval = cleanText(form.interval, { name: 'warming.interval', max: ADVANCED_LIMITS.duration });
  const duration = cleanText(form.duration, { name: 'warming.duration', max: ADVANCED_LIMITS.duration });
  if (prompt == null && interval == null && duration == null) {
    config.warming = true;
    return;
  }
  const warming = isObject(config.warming) ? config.warming : {};
  if (prompt == null) delete warming.prompt;
  else warming.prompt = prompt;
  if (interval == null) delete warming.interval;
  else warming.interval = interval;
  if (duration == null) delete warming.duration;
  else warming.duration = duration;
  config.warming = warming;
}

function mergeExperimental(config, form) {
  if (!isObject(form)) throw new OpenCodeAdvancedError(400, 'Pengaturan experimental tidak valid.');
  const todo = triValue(form.todo, 'experimental.todo');
  const depth = cleanInt(form.subagentDepth, { name: 'experimental.subagent_depth', max: ADVANCED_LIMITS.depth });
  const model = cleanText(form.imageModel, { name: 'experimental.image_generate.model', max: ADVANCED_LIMITS.model });
  const idleText = String(form.locationIdleTimeout ?? '').trim();
  if (idleText && idleText.length > ADVANCED_LIMITS.duration) throw new OpenCodeAdvancedError(400, 'experimental.location_idle_timeout terlalu panjang.');
  const write = todo !== 'inherit' || depth != null || model != null || idleText !== '';
  if (!write) return;
  const experimental = requireObject(config, 'experimental', 'experimental');
  writeTri(experimental, 'todo', form.todo, 'experimental.todo');
  if (depth == null) delete experimental.subagent_depth;
  else experimental.subagent_depth = depth;
  if (model == null) {
    if (isObject(experimental.image_generate)) delete experimental.image_generate.model;
  } else {
    const imageGenerate = requireObject(experimental, 'image_generate', 'experimental.image_generate');
    imageGenerate.model = model;
  }
  dropIfEmpty(experimental, 'image_generate');
  if (!idleText) delete experimental.location_idle_timeout;
  else experimental.location_idle_timeout = idleText === 'false' ? false : idleText;
  dropIfEmpty(config, 'experimental');
}

const parseProviderJson = (value, name) => {
  const textValue = String(value ?? '').trim();
  if (!textValue) return null;
  let parsed;
  try {
    parsed = JSON.parse(textValue);
  } catch (err) {
    throw new OpenCodeAdvancedError(400, `${name} bukan JSON yang valid (${err.message}).`);
  }
  if (!isObject(parsed)) throw new OpenCodeAdvancedError(400, `${name} harus berupa objek JSON ({ … }).`);
  return parsed;
};

function mergeProviders(config, rows) {
  if (!Array.isArray(rows)) throw new OpenCodeAdvancedError(400, 'Daftar provider tidak valid.');
  if (config.providers !== undefined && !isObject(config.providers)) {
    throw new OpenCodeAdvancedError(400, 'Bagian "providers" bukan objek. Perbaiki lewat tab JSON dulu.');
  }
  for (const row of rows) {
    if (!isObject(row) || typeof row.id !== 'string') throw new OpenCodeAdvancedError(400, 'Baris provider tidak valid.');
    if (!isObject(config.providers) || !isObject(config.providers[row.id])) {
      throw new OpenCodeAdvancedError(400, `Provider "${row.id}" tidak ada di config. Tambahkan provider lewat Akun atau tab JSON.`);
    }
    const block = config.providers[row.id];
    for (const [key, field] of [['headers', 'headers'], ['body', 'body']]) {
      if (row[field] === undefined) continue;
      const parsed = parseProviderJson(row[field], `providers.${row.id}.${key}`);
      if (parsed == null) delete block[key];
      else block[key] = parsed;
    }
  }
}

/** Merges the form's advanced fields into the config; a field the form did not send is left alone. */
export function mergeAdvanced(config, form) {
  if (!isObject(form)) throw new OpenCodeAdvancedError(400, 'Pengaturan lanjutan tidak valid.');
  if (form.snapshots !== undefined) writeTri(config, 'snapshots', form.snapshots, 'snapshots');
  if (form.formatter !== undefined) writeTri(config, 'formatter', form.formatter, 'formatter');
  if (form.watcherIgnore !== undefined) mergeWatcher(config, form.watcherIgnore);
  if (form.mediaImage !== undefined) mergeMedia(config, form.mediaImage);
  if (form.toolOutput !== undefined) mergeToolOutput(config, form.toolOutput);
  if (form.compaction !== undefined) mergeCompaction(config, form.compaction);
  if (form.warming !== undefined) mergeWarming(config, form.warming);
  if (form.experimental !== undefined) mergeExperimental(config, form.experimental);
  if (form.providers !== undefined) mergeProviders(config, form.providers);
}
