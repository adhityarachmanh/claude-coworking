// Queue: prompts sent one by one whenever the project's session is idle (src/queue.js).
// `queue` reads (allowed over WiFi); every queue-* is a change (refused there by the gate in server.js).
import { classifyEffort } from '../effort-classifier.js';
import { QueueError, refuseAttachments } from '../queue.js';
import { json } from './http.js';
import { withProject } from './project.js';

/** Auto runs before a queue item is stored, so its level is visible and ready when the item starts. */
async function autoEffort(ctx, id, text) {
  const settings = ctx.hub.settingsFor(id);
  if (!settings.effortAuto) return null;
  return classifyEffort({ engine: ctx.hub.engine, claude: ctx.claude, opencode: ctx.opencode, currentModel: settings.model, text });
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
  router.post('/api/projects/:id/queue-add', withProject(async (ctx, req, res, { id }, body) =>
    queueChange(res, async () => {
      refuseAttachments(body);
      const effort = await autoEffort(ctx, id, String(body.text ?? ''));
      const item = ctx.taskQueue.add(id, body.text, effort);
      return json(res, 200, { item, queue: ctx.taskQueue.view(id) });
    }),
  ));
  router.post('/api/projects/:id/queue-update', withProject(async (ctx, req, res, { id }, body) =>
    queueChange(res, async () => {
      refuseAttachments(body);
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
