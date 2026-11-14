// ⚡ Remote power heartbeat: a fresh POST to the bridge's /api/heartbeat tells it "the PC is alive" (its
// status page shows 🟢 and unlocks the waiting flow). Halts while a scheduled power-off exists - a heartbeat
// landing after /api/off would cancel that schedule (the bridge's rule: PC alive again → don't cut power).
// One-way halt was fragile: if the OS shutdown failed the heartbeat never came back while the PC stayed on.
// So the halt is time-based: 12 minutes after the last halt request it resumes on its own.
//
// Config, fetch and the clock are injected so tests need no network; long intervals are exercised with the
// constructor's beatMs (real timers with short waits), not by replacing setInterval.

export const DEFAULT_BEAT_MS = 2 * 60_000;
export const DEFAULT_HALT_MS = 12 * 60_000; // longest offDelaySec (10 mnt) + a cron tick of slack
// Floor for the env override: a stray OFFICE_POWER_BEAT_MS must not turn the heartbeat into a flood
// (tests use the constructor's beatMs instead, which is deliberately unbounded).
export const MIN_BEAT_MS = 60_000;

/**
 * The heartbeat interval: env `OFFICE_POWER_BEAT_MS` when it is an integer of at least MIN_BEAT_MS,
 * else the 2-minute default. Anything below the floor is ignored, never clamped to a busy loop.
 * @param {object} [env]
 * @returns {number}
 */
export function beatInterval(env = process.env) {
  const ms = Number(env?.OFFICE_POWER_BEAT_MS);
  return Number.isInteger(ms) && ms >= MIN_BEAT_MS ? ms : DEFAULT_BEAT_MS;
}

export class RemotePowerBeat {
  /**
   * @param {object} options
   * @param {() => ({ bridgeUrl?: string, token?: string }|undefined)} options.getConfig the bridge settings
   *   (server.js: hub.remotePower()); an empty bridgeUrl or token means the feature is off.
   * @param {typeof fetch} [options.fetchImpl]
   * @param {number} [options.beatMs] interval between beats (default: OFFICE_POWER_BEAT_MS or 2 minutes)
   * @param {number} [options.haltMs] how long a halt lasts (default 10 minutes)
   * @param {string} [options.appVersion] sent in the body so the bridge can show it
   * @param {() => number} [options.now]
   * @param {(err: Error) => void} [options.onError] one call per failed beat; never throws
   */
  constructor({ getConfig, fetchImpl = globalThis.fetch, beatMs = beatInterval(), haltMs = DEFAULT_HALT_MS, appVersion = '', now = Date.now, onError = () => {} } = {}) {
    this.getConfig = getConfig;
    this.fetchImpl = fetchImpl;
    this.beatMs = beatMs;
    this.haltMs = haltMs;
    this.appVersion = appVersion;
    this.now = now;
    this.onError = onError;
    this.haltUntil = 0;
    this.timer = null;
  }

  /** Sends the first beat right away (not after one interval), then one every beatMs. */
  start() {
    if (this.timer) return this; // already running: never two intervals
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.beatMs);
    this.timer.unref?.(); // the heartbeat alone must not keep the process alive
    return this;
  }

  /** No beat for haltMs: a scheduled power-off must not be cancelled by the PC still answering. */
  halt() {
    this.haltUntil = this.now() + this.haltMs;
  }

  /** Stops the timer (server shutdown, tests). The instance can be started again. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One heartbeat. Skipped while halted or without a bridge; a failure is reported once and retried on the
   * next tick - it never crashes the process or retries in a tight loop.
   * @returns {Promise<boolean>} true when the POST was made
   */
  async beat() {
    try {
      if (this.now() < this.haltUntil) return false;
      const { bridgeUrl, token } = this.getConfig() ?? {};
      if (!bridgeUrl || !token) return false;
      await this.fetchImpl(`${bridgeUrl}/api/heartbeat`, {
        method: 'POST',
        headers: { 'X-Bridge-Token': token, 'Content-Type': 'text/plain' },
        body: JSON.stringify({ ts: this.now(), version: this.appVersion }),
      });
      return true;
    } catch (err) {
      this.onError?.(err); // retried next tick; never crashes
      return false;
    }
  }
}
