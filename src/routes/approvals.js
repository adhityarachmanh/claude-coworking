// Permission prompts / questions / plans waiting for an answer (POST /api/approvals/:id).
import { PERMISSION_MODES } from '../hub.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/approvals/:id', resolveApproval);
}

function resolveApproval({ hub }, req, res, { id }, body) {
  const ok = hub.resolveApproval(id, {
    allow: Boolean(body.allow),
    always: Boolean(body.always),
    allowAll: Boolean(body.allowAll),
    answers: body.answers && typeof body.answers === 'object' ? body.answers : undefined,
    message: typeof body.message === 'string' ? body.message.slice(0, 2000) : undefined,
    mode: PERMISSION_MODES.includes(body.mode) ? body.mode : undefined, // plan approved: how the work continues
  });
  return json(res, ok ? 200 : 409, { ok });
}
