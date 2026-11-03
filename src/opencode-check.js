// OpenCode update detector: the same service as Claude Code's (src/claude-check.js), pointed at `opencode`. On server
// start (after a delay, later than Claude Code's so the two never start together) and every 6 hours, `opencode
// --version` is read (bounded); when it differs from the last version whose contract check passed, the LIGHT OpenCode
// contract (src/opencode-contract.js: `opencode acp` handshake, session/new, config options, CLI listings) runs in
// the background once no turn is busy. It never sends a prompt: no model call, no tokens. Not installed → silent
// (start() does nothing, the view says available: false).
//
// State: data/opencode-check.json (same shape as claude-check.json; not in a history backup).
// The browser gets publicView() as config.opencodeCheck (snapshot + `config` event): versions, result, failing names.
import { ClaudeCheckService } from './claude-check.js';
import { readOpenCodeVersion, runOpenCodeContract } from './opencode-contract.js';

export const OPENCODE_START_DELAY_MS = 45_000;
/** The only setting: the light check never uses a model, so there is nothing like Claude Code's allowModel. */
export const OPENCODE_SETTING_KEYS = Object.freeze(['autoCheck']);

export class OpenCodeCheckService extends ClaudeCheckService {
  /**
   * @param {{ file: string, opencode: {command: string, args: string[]}|null } & Omit<ConstructorParameters<typeof ClaudeCheckService>[0], 'claude'|'file'>} options
   */
  constructor({ opencode, timing = {}, readVersion = readOpenCodeVersion, runContract, ...options }) {
    super({
      ...options,
      claude: opencode, // the base class calls its binary `claude`
      name: 'OpenCode',
      modelLabel: 'model',
      readVersion,
      // The base passes { claude, profile, allowModel, env, timeouts, signal }: the light profile, never a model call;
      // signal = stop() (server shutdown) kills its processes.
      runContract: runContract ?? (({ claude, env, timeouts, signal }) => runOpenCodeContract({ bin: claude, profile: 'light', env, timeouts, signal })),
      timing: { startDelayMs: OPENCODE_START_DELAY_MS, ...timing },
    });
    this.state.settings.allowModel = false;
  }

  publicView() {
    const view = super.publicView();
    return { ...view, settings: { autoCheck: view.settings.autoCheck } };
  }
}
