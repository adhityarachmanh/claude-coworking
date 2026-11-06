// Permission prompts / questions / plans waiting for an answer (POST /api/approvals/:id).
import { budgetStop } from '../budget.js';
import { PERMISSION_MODES } from '../hub.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/approvals/:id', resolveApproval);
}

async function resolveApproval({ hub, sessions, ledger }, req, res, { id }, body) {
  const entry = hub.approvals.get(id);
  const plan = entry?.approval?.kind === 'plan' ? entry.approval : null;
  const cancelled = body.cancelled === true;
  // 💰 A plan build is a new paid turn too: leave the card pending when the budget is already over.
  if (plan && !cancelled && Boolean(body.allow)) {
    const stop = budgetStop(hub, ledger);
    if (stop) return json(res, 409, { error: stop.message, code: 'budget' });
  }
  // A plan's build may need a fresh Model/Effort Auto decision, judged on the plan itself. The result rides on the
  // decision as `preparedAuto` so the OpenCode path does not classify the same plan a second time.
  let autoPrepared = false;
  let preparedAuto = null;
  if (plan && !cancelled && Boolean(body.allow)) {
    try {
      preparedAuto = await sessions.preparePlanTurn(plan.project, plan.input?.plan ?? '', 'build');
      autoPrepared = true;
    } catch {
      autoPrepared = true; // attempted: never classify twice because this call failed
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
    autoPrepared,
    preparedAuto,
  });
  return json(res, ok ? 200 : 409, { ok });
}
