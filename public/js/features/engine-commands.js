// 🔁 Calls the pinned engine-command route (plugins/skills reload, /init) for a project.
import { api } from '../core/api.js';

export const runEngineCommand = (project, command) => api(`/api/projects/${project}/engine-command`, { command });
