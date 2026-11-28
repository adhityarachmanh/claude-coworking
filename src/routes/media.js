// 🖼 Project media (`/media`): images/videos already in the folder, from the laptop or Tailscale only (names can
// reveal work). Read-only; opening a row reuses the file viewer.
import { findMedia } from '../media.js';
import { json } from './http.js';
import { withProject } from './project.js';

export function register(router) {
  router.post('/api/projects/:id/media', withProject((ctx, req, res, { project }) => {
    if (ctx.isReadOnly?.(req) !== false) return json(res, 403, { error: 'Media hanya bisa dibuka dari laptop atau lewat Tailscale.' });
    return json(res, 200, { media: findMedia(project.path) });
  }), { maxBody: 1024 });
}
