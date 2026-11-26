// 🦙 Ollama (model lokal) tanpa CLI: status lewat HTTP API-nya. Hanya membaca (version, daftar model,
// model yang sedang berjalan + berapa yang ada di VRAM), dengan timeout pendek supaya Settings tidak menggantung.
const DEFAULT_URL = 'http://127.0.0.1:11434';

/** `OLLAMA_HOST` boleh `host:port`; `OFFICE_OLLAMA_URL` (untuk tes/remote) menang. Selalu http(s) tanpa path aneh. */
export function ollamaBaseUrl(env = process.env) {
  let raw = String(env.OFFICE_OLLAMA_URL ?? env.OLLAMA_HOST ?? DEFAULT_URL).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) return DEFAULT_URL; // ftp://, file:// — never a provider endpoint
  } else raw = `http://${raw}`;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return DEFAULT_URL;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return DEFAULT_URL;
  }
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const text = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');

/**
 * GET /api/version, /api/tags and /api/ps (all in parallel). `available: false` when Ollama is not answering,
 * never a thrown error: the settings section simply explains it is not running.
 */
export async function ollamaStatus({ fetchImpl = fetch, baseUrl = ollamaBaseUrl(), timeoutMs = 2500 } = {}) {
  const get = async (path) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const [version, tags, ps] = await Promise.all([get('/api/version'), get('/api/tags'), get('/api/ps')]);
    return {
      available: true,
      baseUrl,
      version: text(version?.version, 40),
      models: (Array.isArray(tags?.models) ? tags.models : [])
        .slice(0, 100)
        .map((m) => ({
          name: text(m?.name ?? m?.model, 200),
          size: num(m?.size),
          parameterSize: text(m?.details?.parameter_size, 40),
          quantization: text(m?.details?.quantization_level, 40),
          family: text(m?.details?.family, 60),
          modifiedAt: text(m?.modified_at, 40),
        }))
        .filter((m) => m.name),
      running: (Array.isArray(ps?.models) ? ps.models : [])
        .slice(0, 20)
        .map((m) => {
          const size = num(m?.size);
          const vram = num(m?.size_vram);
          return {
            name: text(m?.name ?? m?.model, 200),
            size,
            sizeVram: vram,
            gpuPercent: size > 0 ? Math.max(0, Math.min(100, Math.round((vram / size) * 100))) : 0,
            expiresAt: text(m?.expires_at, 40),
          };
        })
        .filter((m) => m.name),
    };
  } catch {
    return { available: false, baseUrl, version: '', models: [], running: [], error: 'Ollama tidak menjawab di alamat ini. Pastikan aplikasinya berjalan.' };
  }
}
