// ---------- 📋 Antrian: prompts sent one by one whenever the project's session is idle (src/queue.js) ----------
// `queue` reads (allowed over WiFi); every queue-* is a change (refused there by the gate in server.js).
import { QueueError, refuseAttachments } from '../queue.js';
import { json } from './http.js';
import { withProject } from './project.js';

/** op → the change it makes; each answers with the queue's new view. */
const CHANGES = {
  update: (q, id, body) => {
    refuseAttachments(body);
    q.update(id, body.itemId, body.text);
  },
  remove: (q, id, body) => q.remove(id, body.itemId),
  reorder: (q, id, body) => q.reorder(id, body.order),
  pause: (q, id, body) => q.setPaused(id, body.paused === true),
  retry: (q, id, body) => q.retry(id, body.itemId),
  clear: (q, id) => q.clearFinished(id),
  budget: (q, id, body) => q.setBudget(id, body),
};

export function register(router) {
  router.post('/api/projects/:id/queue', withProject(({ taskQueue }, req, res, { id }) => json(res, 200, { queue: taskQueue.view(id) })));
  router.post('/api/projects/:id/queue-add', withProject(({ taskQueue }, req, res, { id }, body) =>
    queueChange(res, () => {
      refuseAttachments(body); // 📎 never stored in state.json (src/queue.js)
      const item = taskQueue.add(id, body.text);
      return json(res, 200, { item, queue: taskQueue.view(id) });
    }),
  ));
  for (const [op, change] of Object.entries(CHANGES)) {
    router.post(`/api/projects/:id/queue-${op}`, withProject(({ taskQueue }, req, res, { id }, body) =>
      queueChange(res, () => {
        change(taskQueue, id, body);
        return json(res, 200, { queue: taskQueue.view(id) });
      }),
    ));
  }
}

/** A QueueError is the user's mistake (unknown item, limits, a paused queue…): its own status and message. */
function queueChange(res, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof QueueError) return json(res, err.status, { error: err.message });
    throw err;
  }
}
