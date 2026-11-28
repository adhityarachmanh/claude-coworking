// 🔁 Calls the pinned engine-command route (plugins/skills reload, /init) for a project.
import { api } from '../core/api.js';

export const runEngineCommand = (project, command) => api(`/api/projects/${project}/engine-command`, { command });

/** Opens the pinned CLI in Windows Terminal for the TUI-only features (attach, /batch, ultrareview, elicitation). */
export const openProjectTerminal = (project, mode, id = '') => api(`/api/projects/${project}/terminal`, { mode, ...(id ? { id } : {}) });
