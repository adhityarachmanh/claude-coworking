// Queue: prompts sent one by one whenever the project's session is idle (src/queue.js).
// `queue` reads (allowed over WiFi); every queue-* is a change (refused there by the gate in server.js).
import { AttachmentError, readAttachments } from '../attachments.js';
import { autoContext, classifyEffort } from '../effort-classifier.js';
import { QueueError } from '../queue.js';
import { json } from './http.js';
import { withProject } from './project.js';

/** Auto runs before a queue item is stored, so its level is visible and ready when the item starts.
 *  The level is needed when either Auto is on: Model Auto applies it at dispatch (src/queue.js). */
async function autoEffort(ctx, id, text, attachments = []) {
  const settings = ctx.hub.settingsFor(id);
  if (!settings.effortAuto && !settings.modelAuto) return null;
  return classifyEffort({ engine: ctx.hub.engineOf(id), claude: ctx.claude, opencode: ctx.opencode, currentModel: settings.model, text, attachments, context: autoContext(ctx.hub, id) });
}

/** op → the change it makes; each answers with the queue's new view. */
const CHANGES = {
  remove: (q, id, body) => q.remove(id, body.itemId),
  reorder: (q, id, body) => q.reorder(id, body.order),
  pause: (q, id, body) => q.setPaused(id, body.paused === true),
  retry: (q, id, body) => q.retry(id, body.itemId),
  clear: (q, id) => q.clearFinished(id),
  budget: (q, id, body) => q.setBudget(id, body),
};

export function register(router) {
  router.post('/api/projects/:id/queue', withProject(({ taskQueue }, req, res, { id }) => json(res, 200, { queue: taskQueue.view(id) })));
  // 🔁 Retry a failed item once, automatically (per project).
  router.post('/api/projects/:id/queue-retry-once', withProject((ctx, req, res, { id }, body) => {
    const retryOnce = ctx.hub.setQueueRetryOnce(id, body.on === true);
    return json(res, 200, { ok: true, retryOnce, queue: ctx.taskQueue.view(id) });
  }));
  router.post('/api/projects/:id/queue-add', withProject(async (ctx, req, res, { id }, body) => {
    let attachments;
    try {
      attachments = readAttachments(body); // same validation as a direct prompt; bytes are written under data/queue-files
    } catch (err) {
      if (err instanceof AttachmentError) return json(res, err.status, { error: err.message });
      throw err;
    }
    return queueChange(res, async () => {
      const effort = await autoEffort(ctx, id, String(body.text ?? ''), attachments);
      const item = ctx.taskQueue.add(id, body.text, effort, attachments);
      return json(res, 200, { item, queue: ctx.taskQueue.view(id) });
    });
  }));
  router.post('/api/projects/:id/queue-update', withProject(async (ctx, req, res, { id }, body) =>
    queueChange(res, async () => {
      const files = (Array.isArray(body.attachments) ? body.attachments.length : 0) + (Array.isArray(body.images) ? body.images.length : 0);
      if (files) throw new QueueError(400, 'Lampiran item antrian hanya bisa ditambahkan saat membuat item. Hapus item lalu tambahkan ulang untuk mengganti lampirannya.');
      const effort = await autoEffort(ctx, id, String(body.text ?? ''));
      ctx.taskQueue.update(id, body.itemId, body.text, effort);
      return json(res, 200, { queue: ctx.taskQueue.view(id) });
    }),
  ));
  for (const [op, change] of Object.entries(CHANGES)) {
    router.post(`/api/projects/:id/queue-${op}`, withProject((ctx, req, res, { id }, body) =>
      queueChange(res, () => {
        change(ctx.taskQueue, id, body);
        return json(res, 200, { queue: ctx.taskQueue.view(id) });
      }),
    ));
  }
  // 📚 Runbooks: named prompt sequences stored with the office state; ▶ adds them to the same queue.
  router.post('/api/projects/:id/runbooks', withProject(({ hub }, req, res, { id }) => json(res, 200, { runbooks: hub.runbooksFor(id) })));
  router.post('/api/projects/:id/runbook-save', withProject(({ hub }, req, res, { id }, body) => {
    try {
      const runbook = hub.saveRunbook(id, body);
      return json(res, 200, { runbook, runbooks: hub.runbooksFor(id) });
    } catch (err) {
      if (err.status) return json(res, err.status, { error: err.message });
      throw err;
    }
  }));
  router.post('/api/projects/:id/runbook-delete', withProject(({ hub }, req, res, { id }, body) => {
    if (!hub.deleteRunbook(id, String(body.runbookId ?? ''))) return json(res, 404, { error: 'Runbook tidak ditemukan.' });
    return json(res, 200, { runbooks: hub.runbooksFor(id) });
  }));
  router.post('/api/projects/:id/runbook-run', withProject(async (ctx, req, res, { id }, body) => {
    const book = ctx.hub.runbooksFor(id).find((b) => b.id === String(body.runbookId ?? ''));
    if (!book) return json(res, 404, { error: 'Runbook tidak ditemukan.' });
    return queueChange(res, async () => {
      for (const [index, text] of book.prompts.entries()) {
        const effort = await autoEffort(ctx, id, text);
        ctx.taskQueue.add(id, text, effort, [], { runbookId: book.id, runbookIndex: index });
      }
      return json(res, 200, { added: book.prompts.length, queue: ctx.taskQueue.view(id) });
    });
  }));
}

/** A QueueError is the user's mistake (unknown item, limits, a paused queue…): its own status and message. */
async function queueChange(res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof QueueError) return json(res, err.status, { error: err.message });
    throw err;
  }
}
