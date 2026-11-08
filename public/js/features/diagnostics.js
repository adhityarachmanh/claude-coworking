// 🩺 Bundel diagnostik: downloads the .zip built by src/routes/diagnostics.js (laptop only).
import { api, toast } from '../core/api.js';
import { saveBlob } from '../core/util.js';

export async function downloadDiagnostics() {
  try {
    const blob = await api('/api/diagnostics/export', {}, { raw: true });
    saveBlob(`adhit-office-diagnostik-${new Date().toLocaleDateString('sv-SE')}.zip`, blob);
    toast('Bundel diagnostik diunduh.', 'ok');
  } catch (err) {
    toast(`Gagal membuat bundel diagnostik: ${err.message}`);
  }
}
