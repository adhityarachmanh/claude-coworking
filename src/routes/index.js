// Every API route of the office, in one router (src/routes/router.js). server.js runs its security gates first
// (Host/Origin, token, laptop-only paths, the WiFi read-only allowlist); a route only does its own work.
import { Router } from './router.js';
import * as account from './account.js';
import * as approvals from './approvals.js';
import * as attention from './attention.js';
import * as backup from './backup.js';
import * as budget from './budget.js';
import * as checklist from './checklist.js';
import * as cliBridge from './cli-bridge.js';
import * as data from './data.js';
import * as claudeCheck from './claude-check.js';
import * as diagnostics from './diagnostics.js';
import * as extensions from './extensions.js';
import * as files from './files.js';
import * as git from './git.js';
import * as health from './health.js';
import * as memory from './memory.js';
import * as misc from './misc.js';
import * as opencodeCheck from './opencode-check.js';
import * as opencodeConfig from './opencode-config.js';
import * as permissions from './permissions.js';
import * as projects from './projects.js';
import * as push from './push.js';
import * as queue from './queue.js';
import * as remote from './remote.js';
import * as routines from './routines.js';
import * as session from './session.js';
import * as groups from './groups.js';
import * as setup from './setup.js';
import * as spotify from './spotify.js';
import * as tasks from './tasks.js';
import * as team from './team.js';
import * as templates from './templates.js';

/** Builds the router. Registering touches no state, so tests can enumerate the routes without a server. */
export function buildRouter() {
  const router = new Router();
  for (const register of [
    projects.register,
    projects.registerProjectActions,
    groups.register,
    session.register,
    tasks.register,
    extensions.register,
    files.register,
    memory.register,
    git.register,
    health.register,
    permissions.register,
    queue.register,
    routines.register,
    approvals.register,
    attention.register,
    cliBridge.register,
    templates.register,
    team.register,
    account.register,
    budget.register,
    checklist.register,
    data.register,
    remote.register,
    push.register,
    backup.register,
    spotify.register,
    claudeCheck.register,
    diagnostics.register,
    opencodeCheck.register,
    opencodeConfig.register,
    setup.register,
    misc.register,
  ])
    register(router);
  return router;
}
