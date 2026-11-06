// Permission prompts / questions / plans waiting for an answer (POST /api/approvals/:id).
import { PERMISSION_MODES } from '../hub.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/approvals/:id', resolveApproval);
}

async function resolveApproval({ hub, sessions }, req, res, { id }, body) {
  const entry = hub.approvals.get(id);
  const plan = entry?.approval?.kind === 'plan' ? entry.approval : null;
  const cancelled = body.cancelled === true;
  if (plan && !cancelled && Boolean(body.allow)) {
    // A plan's build may need a fresh Model/Effort Auto decision, judged on the plan itself.
    try {
      await sessions.preparePlanBuild(plan.project, plan.input?.plan ?? '');
    } catch {
      // Never block an approved plan because the classifier was unavailable.
    }
  }
  if (plan && cancelled) hub.chat(plan.project, { kind: 'info', text: 'Rencana disimpan tanpa build.' });
  const ok = hub.resolveApproval(id, {
    allow: Boolean(body.allow),
    always: Boolean(body.always),
    allowAll: Boolean(body.allowAll),
    answers: body.answers && typeof body.answers === 'object' ? body.answers : undefined,
    message: typeof body.message === 'string' ? body.message.slice(0, 2000) : undefined,
    mode: PERMISSION_MODES.includes(body.mode) ? body.mode : undefined, // plan approved: how the work continues
    cancelled,
  });
  return json(res, ok ? 200 : 409, { ok });
}
