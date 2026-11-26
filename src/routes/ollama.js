// 🦙 Model lokal: read-only Ollama status for the settings section (src/ollama.js does the HTTP calls).
import { ollamaStatus } from '../ollama.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/ollama/status', async (ctx, req, res) => json(res, 200, await ollamaStatus()), { maxBody: 512 });
}
