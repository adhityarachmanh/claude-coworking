// ⚠ Perlu perhatian: one list of things that are waiting or blocked across projects. Read-only, laptop/Tailscale
// only (the labels can name tools and files, which a plain-WiFi page must not receive).
import { budgetStop, budgetView, WINDOW_UNITS } from '../budget.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/attention', list, { maxBody: 1024 });
}

const projectName = (hub, id) => hub.projects.get(id)?.name ?? 'project';

function list({ hub, ledger, taskQueue }, req, res) {
  const items = [];
  const now = Date.now();

  for (const { approval } of hub.approvals?.values?.() ?? []) {
    if (approval.status !== 'pending') continue;
    items.push({
      kind: approval.kind === 'plan' ? 'plan' : approval.kind === 'question' ? 'question' : 'approval',
      project: approval.project,
      projectName: projectName(hub, approval.project),
      label: approval.label || approval.tool || 'Menunggu jawaban',
      detail: approval.kind === 'plan' ? 'Rencana menunggu persetujuan' : approval.kind === 'question' ? 'Pertanyaan menunggu jawaban' : 'Izin menunggu jawaban',
      chatId: approval.chatId ?? null,
    });
  }

  const globalStop = budgetStop(hub, ledger, now);
  if (globalStop) items.push({ kind: 'budget', project: null, projectName: 'Global', label: `Budget ${globalStop.label}`, detail: 'Pengiriman prompt dihentikan', scope: 'global' });
  for (const id of Object.keys(hub.persisted?.projectBudgets ?? {})) {
    if (!hub.projects?.has?.(id)) continue;
    const view = budgetView(hub, ledger, now, id);
    if (!WINDOW_UNITS.some((unit) => view.windows[unit].state === 'over')) continue;
    items.push({ kind: 'budget', project: id, projectName: projectName(hub, id), label: 'Budget project tercapai', detail: 'Pengiriman prompt project ini dihentikan', scope: 'project' });
  }

  for (const [id, q] of Object.entries(taskQueue?.queues ?? {})) {
    const waiting = q.items?.filter((i) => i.status === 'waiting').length ?? 0;
    if (!q.paused || !waiting) continue;
    items.push({ kind: 'queue', project: id, projectName: projectName(hub, id), label: `Antrian dijeda · ${waiting} item`, detail: q.reason === 'budget' ? 'Menunggu budget dinaikkan' : q.reason === 'account' ? 'Akun berubah' : q.reason === 'rate_limit' ? 'Batas pemakaian tercapai' : 'Perlu dilanjutkan' });
  }

  for (const id of Object.keys(hub.persisted?.interrupted ?? {})) {
    items.push({ kind: 'interrupted', project: id, projectName: projectName(hub, id), label: 'Giliran terputus', detail: 'Server berhenti di tengah giliran — lanjutkan atau abaikan' });
  }

  for (const routine of hub.persisted?.routines ?? []) {
    if (routine.lastStatus !== 'failed' && !routine.error) continue;
    items.push({ kind: 'routine', project: routine.projectId, projectName: projectName(hub, routine.projectId), label: 'Jadwal gagal', detail: routine.lastError || routine.error || routine.prompt?.slice(0, 80) || '' });
  }

  const order = { approval: 0, plan: 0, question: 0, budget: 1, queue: 2, interrupted: 3, routine: 4 };
  items.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  return json(res, 200, { items: items.slice(0, 30), count: items.length });
}
