// bridge/src/auto.mjs — Auto (LLM) untuk effort & model, meniru Adhitron lokal.
// Classifier memakai model TERMURAH milik provider user, prompt ringkas, keluaran JSON ketat.
// Murni: menerima `callModel` (fungsi yang mengirim prompt tunggal dan mengembalikan teks) agar bisa
// dites tanpa jaringan. Kalau classifier gagal, pemanggil memakai nilai default (jangan blokir chat).
import { cheapestModelFor, EFFORT_LEVELS, modelsFor, TIERS } from './providers.mjs';

/** Prompt classifier: minta satu kata effort + satu kata tier. Ringkas = murah. */
export const CLASSIFIER_PROMPT = `Kamu adalah pengklasifikasi. Diberikan permintaan pengguna, pilih:
- "effort": seberapa besar penalaran yang perlu — salah satu dari low, medium, high, xhigh.
- "tier": kelas model — salah satu dari hemat, sedang, kuat.
Jawab HANYA JSON: {"effort":"...","tier":"..."}. Tidak ada teks lain.`;

/** Ambil JSON dari jawaban model (tahan pagar ```json dan teks pembungkus). */
export function parseClassifierOutput(text) {
  const s = String(text ?? '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : s;
  const brace = raw.match(/\{[\s\S]*\}/);
  if (!brace) return null;
  let j; try { j = JSON.parse(brace[0]); } catch { return null; }
  const effort = EFFORT_LEVELS.includes(j.effort) ? j.effort : null;
  const tier = TIERS.includes(j.tier) ? j.tier : null;
  return { effort, tier };
}

/** Model yang dipakai classifier untuk sebuah kind (model termurah user). */
export const classifierModel = (kind, providerModels) => cheapestModelFor(kind, providerModels);

/**
 * Jalankan classifier. `callModel({ model, system, messages })` → Promise<string>.
 * Mengembalikan { effort, tier } yang sudah divalidasi; null bila gagal / tak terpakai.
 */
export async function classify({ kind, callModel, prompt, providerModels }) {
  const model = classifierModel(kind, providerModels);
  if (!model) return null;
  let out;
  try {
    out = await callModel({ model, system: CLASSIFIER_PROMPT, messages: [{ role: 'user', content: String(prompt ?? '').slice(0, 4000) }] });
  } catch {
    return null; // Auto tidak boleh memblokir turn; pemanggil memakai default
  }
  const parsed = parseClassifierOutput(out);
  if (!parsed) return null;
  return { effort: parsed.effort ?? 'medium', tier: parsed.tier ?? 'sedang', model };
}

/** Daftar tier yang tersedia untuk kind (untuk UI). */
export const tiersFor = (kind) => [...new Set(modelsFor(kind).map((m) => m.tier))];