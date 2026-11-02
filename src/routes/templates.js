// ---------- prompt templates (⚡ Template) ----------
// Reading the list is allowed over WiFi (src/remote.js); save/delete are actions, refused there by the gate.
import { TEMPLATE_LIMITS, TemplateError } from '../templates.js';
import { HttpError, json } from './http.js';

export function register(router) {
  router.post('/api/templates', ({ templates }, req, res) => json(res, 200, { templates: templates.list(), limits: TEMPLATE_LIMITS }));
  router.post('/api/templates/save', (ctx, req, res, params, body) =>
    change(() => {
      const template = ctx.templates.save({ id: body.id, name: body.name, text: body.text });
      return json(res, 200, { template, templates: ctx.templates.list() });
    }),
  );
  router.post('/api/templates/delete', (ctx, req, res, params, body) =>
    change(() => {
      ctx.templates.remove(body.id);
      return json(res, 200, { templates: ctx.templates.list() });
    }),
  );
}

/** A TemplateError is the user's mistake (name/text/limits): a 400 with its message. */
function change(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TemplateError) throw new HttpError(400, err.message);
    throw err;
  }
}
