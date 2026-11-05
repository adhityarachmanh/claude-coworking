// Model logos (the repo's ai_logos/*.svg, served at /ai-logos/): which file belongs to the active model, and how to
// draw it small and crisp in the office and 🧠 Mode Otak. The mapping is pure (Node-testable), the index is fetched
// once and cached, and every decoded Image is cached too, so a frame never creates one.

const INDEX_URL = '/ai-logos/index.json';
const LOGO_URL = '/ai-logos/';
const RETRY_MS = 60_000; // a failed index is tried again on the first call after this long, never in a loop
// The server's own name pattern (server.js serveAiLogos): the whole path check, so nothing else is ever requested.
const SAFE_FILE = /^[a-z0-9][a-z0-9._-]{0,80}\.svg$/i;
const TAU = Math.PI * 2;

// Claude Code's short model aliases: they name a model, not a logo file.
const ALIASES = {
  default: 'claude-opus-5-5',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
};

// A model whose exact file is missing still gets its family's logo: the model each family is known by in ai_logos.
// (Claude keeps the alias default; GPT takes the newest member of its family, see newestOf().)
const FAMILY = {
  claude: ALIASES.default,
  gpt: null,
  kimi: 'kimi-k3.1-pro',
  glm: 'glm-5.3',
  deepseek: 'deepseek-v4.1-flash',
  gemini: 'gemini-4-argon',
  qwen: 'qwen3.8-max',
  grok: 'grok-4.7',
  minimax: 'minimax-m3.1-flash',
  mimo: 'mimo-v2.6-pro',
  hy: 'hy4',
  muse: 'muse-spark-1.3',
  longcat: 'longcat-2.0',
  step: 'step-5-preview',
  mistral: 'mistral-large-4',
};

/** The logo index: names as the server lists them (x.svg), a retry stamp, and one in-flight load at a time. */
const index = { names: [], loaded: false, pending: false, failedAt: 0 };

/**
 * The logo file names, fetched once from /ai-logos/index.json and cached; [] until it arrives, and [] on failure
 * (tried again on the first call after RETRY_MS). Never fetches outside a browser: image work needs Image anyway.
 */
export function logoIndex() {
  if (typeof Image === 'undefined') return index.names; // Node tests / a worker
  if (!index.loaded && !index.pending && (!index.failedAt || Date.now() - index.failedAt >= RETRY_MS)) loadIndex();
  return index.names;
}

async function loadIndex() {
  index.pending = true;
  try {
    const res = await fetch(INDEX_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // The server sends the folder's names; anything unexpected is dropped rather than requested.
    index.names = Array.isArray(data?.logos) ? data.logos.filter((name) => typeof name === 'string' && SAFE_FILE.test(name)) : [];
    index.loaded = true;
    index.failedAt = 0;
  } catch {
    index.failedAt = Date.now(); // back off: one retry per minute, not one per frame
  } finally {
    index.pending = false;
  }
}

/** "opencode-go/deepseek-v4.1-flash#high" → "deepseek-v4.1-flash": the provider prefix and the variant are not part
 *  of the model's name. */
function bareId(model) {
  const raw = String(model ?? '').trim();
  if (!raw) return '';
  const withoutVariant = raw.split('#')[0].trim();
  const slash = withoutVariant.lastIndexOf('/');
  return (slash >= 0 ? withoutVariant.slice(slash + 1) : withoutVariant).trim().toLowerCase();
}

/** The index as a Map: bare lower-case id -> the name exactly as the folder lists it (the file that is requested). */
function indexOf(names) {
  const map = new Map();
  if (!Array.isArray(names)) return map;
  for (const entry of names) {
    const raw = String(entry ?? '').trim();
    if (!raw) continue;
    const name = /\.svg$/i.test(raw) ? raw : `${raw}.svg`;
    if (!SAFE_FILE.test(name)) continue; // the server's own pattern: nothing else is ever requested
    map.set(name.slice(0, -4).toLowerCase(), name);
  }
  return map;
}

// Longest family name first, so "minimax" is not read as "mini" (and no family is a prefix of another's match).
const FAMILY_KEYS = Object.keys(FAMILY).sort((a, b) => b.length - a.length);

/** The family a model id belongs to (`mimo-v2.6-pro` → `mimo`), or null. */
function familyOf(id) {
  if (!id) return null;
  return FAMILY_KEYS.find((key) => id === key || id.startsWith(`${key}-`) || id.startsWith(`${key}.`) || (id.startsWith(key) && /^\d/.test(id.slice(key.length)))) ?? null;
}

/** The version numbers after a family name: "gpt-6.1-sol" → [6, 1] ([] when there is none). */
function versionOf(id, family) {
  const match = /\d+(?:\.\d+)*/.exec(id.slice(family.length));
  return match ? match[0].split('.').map(Number) : [];
}

/** The highest-version id of a family, so a new gpt-7 still shows the newest logo the folder has. */
function newestOf(ids, family) {
  let best = null;
  let bestVersion = null;
  for (const id of ids) {
    if (familyOf(id) !== family) continue;
    const version = versionOf(id, family);
    if (!bestVersion || compareVersions(version, bestVersion) > 0) {
      best = id;
      bestVersion = version;
    }
  }
  return best;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** The file for a bare id, if the index has it. */
function fileFor(index, id) {
  return (id && index.get(id)) || null;
}

/** A family's logo: the model it is known by (or the newest member), if the index carries it. */
function familyFile(index, family) {
  const known = FAMILY[family];
  return (known && fileFor(index, known)) || fileFor(index, newestOf([...index.keys()], family));
}

/**
 * The logo file for a model id, or null. Pure: `names` is the logo index (with or without .svg).
 * Handles a provider prefix (`opencode-go/…`), a `#variant`, Claude's short aliases, a `-free` twin, and finally the
 * model's family. `engine` is a last hint only: a model id from no known family on the Claude engine is a Claude.
 */
export function logoFileFor(model, names, engine) {
  const index = indexOf(names);
  const id = bareId(model);
  if (!id || !index.size) return null;
  const exact = fileFor(index, id);
  if (exact) return exact;
  // "sonnet" / "default": Claude Code's aliases, which name a model rather than a file.
  if (ALIASES[id]) {
    const alias = fileFor(index, ALIASES[id]);
    if (alias) return alias;
  }
  // A free model shares the logo of the model it is free of ("glm-5.3-flash-free" → "glm-5.3-flash").
  if (id.endsWith('-free')) {
    const paid = id.slice(0, -'-free'.length);
    const twin = fileFor(index, paid) ?? (ALIASES[paid] ? fileFor(index, ALIASES[paid]) : null);
    if (twin) return twin;
  }
  const family = familyOf(id) ?? familyOf(String(engine ?? '').trim().toLowerCase());
  if (family) return familyFile(index, family);
  return null;
}

/**
 * What the stage shows for a project: the active model (falling back to the configured one), its short label (the id
 * after the provider, for the monogram), and its logo file (null until the index arrives, or when it is unknown).
 */
export function activeModelOf(status = {}, engine) {
  const model = String(status?.activeModel || status?.model || '').trim();
  const label = (() => {
    const raw = model.split('#')[0];
    const slash = raw.lastIndexOf('/');
    return (slash >= 0 ? raw.slice(slash + 1) : raw).trim();
  })();
  return { model, label, file: model ? logoFileFor(model, logoIndex(), engine) : null };
}

/** Decoded logo images, one per file: a frame reuses the Image, it never builds one. */
const images = new Map();

/** The cached Image for a logo file, or null (an unknown name, or no DOM: Node tests). */
export function logoImage(file) {
  const name = String(file ?? '');
  if (!SAFE_FILE.test(name) || typeof Image === 'undefined') return null;
  let img = images.get(name);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = LOGO_URL + name; // same origin: CSP img-src 'self'
    images.set(name, img);
  }
  return img;
}

/** Two letters for the fallback badge: "claude-opus-5-5" → "CL" ("AI" when there is nothing to show). */
function monogram(label) {
  const text = String(label ?? '').trim();
  if (!text) return 'AI';
  // Letters when the label has any (names, not versions), else its digits.
  const letters = /[a-z]/i.test(text) ? text.replace(/[^a-z]/gi, '') : text.replace(/\D/g, '');
  return (letters.slice(0, 2).toUpperCase() || 'AI');
}

/** A ring colour as a canvas style: a string as-is, or the [r, g, b] hue the brain's core uses. */
function ringStyle(ring) {
  if (typeof ring === 'string' && ring) return ring;
  if (Array.isArray(ring) && ring.length >= 3) return `rgb(${ring[0]},${ring[1]},${ring[2]})`;
  return null;
}

/**
 * Draws a model logo centred on (x, y), contained in a `size` box: a dark disc with a light face keeps the mark
 * readable on a bright wall and inside the core's glow, an optional ring marks the owner, and a missing/undecoded
 * image falls back to a monogram of `label` instead of throwing mid-frame.
 */
export function drawModelLogo(g, file, x, y, size, { alpha = 1, ring = null, font = 'bold 10px monospace', label = '' } = {}) {
  if (!g || !(size > 0)) return;
  const radius = size / 2;
  const ink = ringStyle(ring) ?? '#e8ecff';
  let saved = false; // a context without save/restore (a test stub) still draws
  try {
    g.save();
    saved = true;
    g.globalAlpha = Math.min(1, Math.max(0, alpha));
    // A dark backing circle separates the logo from a bright wall or the core's glow...
    g.fillStyle = 'rgba(10,14,30,0.72)';
    g.beginPath();
    g.arc(x, y, radius, 0, TAU);
    g.fill();
    // ...and a light face keeps the logo itself readable: lobe-icons draws its marks with `currentColor`, which
    // resolves to black inside an <img> (most of the folder); the few white marks carry their own coloured badge.
    g.fillStyle = 'rgba(246,243,236,0.96)';
    g.beginPath();
    g.arc(x, y, radius * 0.86, 0, TAU);
    g.fill();
    const img = logoImage(file);
    if (img && img.complete && img.naturalWidth > 0) {
      const scale = Math.min((size * 0.78) / img.naturalWidth, (size * 0.78) / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      g.drawImage(img, x - w / 2, y - h / 2, w, h);
    } else {
      g.fillStyle = '#2b3446'; // dark ink: the monogram sits on the light face
      g.font = font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(monogram(label), x, y);
    }
    if (ring) {
      g.strokeStyle = ink;
      g.lineWidth = Math.max(1, size * 0.06);
      g.beginPath();
      g.arc(x, y, radius - g.lineWidth / 2, 0, TAU);
      g.stroke();
    }
  } catch {
    // A broken or undecodable SVG must never break the frame: the disc (and the monogram) stay.
  } finally {
    if (saved) {
      try {
        g.restore();
      } catch {
        // nothing left to restore
      }
    }
  }
}
