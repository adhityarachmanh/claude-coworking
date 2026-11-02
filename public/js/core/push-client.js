// 🔔 Notifikasi HP (Web Push): service worker registration and the subscription, against the server's
// /api/push/* contract (docs/design-web-push.md). No DOM and no app imports: every browser API comes in
// through `deps`, so test/push-ui.test.mjs runs it in Node with stubs. The UI is features/push.js.
import { b64urlToBytes, pushAvailability, sameKey } from './push-rules.js';

/**
 * @param {object} deps
 * @param {() => object} deps.env           the browser facts pushAvailability() needs (read each call)
 * @param {object} [deps.serviceWorker]     navigator.serviceWorker
 * @param {object} [deps.Notification]      window.Notification
 * @param {(path: string, body: object) => Promise<any>} deps.post  JSON POST with the page's API token (core/api.js)
 * @param {() => object} deps.settings      the current settings payload (push-rules.js pushSettings)
 */
export function createPushClient({ env, serviceWorker, Notification: NotificationApi, post, settings }) {
  let registration = null; // Promise<ServiceWorkerRegistration> once registered
  let active = false; // last known: this device has a subscription the server accepted

  const availability = () => pushAvailability(env());
  // Only an https page with the APIs present ever touches the service worker (never http / WiFi / the laptop).
  const canRegister = () => ['ready', 'denied'].includes(availability());

  /** Registers /sw.js (scope /, never from the HTTP cache). Idempotent; null when this page may not. */
  function register() {
    if (!canRegister()) return null;
    registration ??= serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch((err) => {
      registration = null; // try again next time (e.g. the https listener restarted)
      throw err;
    });
    return registration;
  }

  async function currentSubscription() {
    const reg = await register();
    return reg ? reg.pushManager.getSubscription() : null;
  }

  /** Subscribed here and allowed by the browser (what the section shows as "Aktif"). */
  async function subscribed() {
    if (availability() !== 'ready' || NotificationApi?.permission !== 'granted') return (active = false);
    try {
      return (active = Boolean(await currentSubscription()));
    } catch {
      return (active = false);
    }
  }

  /**
   * "Aktifkan": permission (must be the first await: iOS only asks from a user gesture) → VAPID key →
   * browser subscription (renewed when made with another key) → POST subscribe with the current settings.
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  async function enable() {
    const avail = availability();
    if (avail !== 'ready') return { ok: false, reason: avail };
    const permission = NotificationApi.permission === 'granted' ? 'granted' : await NotificationApi.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: permission === 'denied' ? 'denied' : 'dismissed' };
    const { publicKey } = await post('/api/push/vapid', {});
    if (typeof publicKey !== 'string' || !publicKey) throw new Error('Server tidak mengirim kunci push.');
    const key = b64urlToBytes(publicKey);
    const reg = await register();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => {}); // the laptop's key changed: the old subscription is dead anyway
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await post('/api/push/subscribe', { subscription: sub.toJSON(), settings: settings() });
    active = true;
    return { ok: true };
  }

  /** "Matikan": the server forgets it, then the browser. A server error still unsubscribes here (and rethrows). */
  async function disable() {
    let error = null;
    await post('/api/push/unsubscribe', {}).catch((err) => (error = err));
    const sub = await currentSubscription().catch(() => null);
    await sub?.unsubscribe().catch(() => {});
    active = false;
    if (error) throw error;
  }

  /** "Kirim tes". */
  const sendTest = () => post('/api/push/test', {});

  /** Settings changed (🔔 dialog, favourites, lock-screen switch): tell the server. No-op when not subscribed. */
  async function syncSettings() {
    if (!(await subscribed())) return false;
    await post('/api/push/settings', { settings: settings() });
    return true;
  }

  /**
   * App opened on https: send the existing subscription again (idempotent). Heals a subscription the browser
   * rotated (pushsubscriptionchange) or the server dropped. Never asks for permission.
   */
  async function resync() {
    if (!(await subscribed())) return false;
    const sub = await currentSubscription();
    await post('/api/push/subscribe', { subscription: sub.toJSON(), settings: settings() });
    return true;
  }

  /**
   * Anti-double: while a tab of this device is visible the server holds its pushes back (the page notifies itself).
   * Only sent by a subscribed device; `tab` is a per-page id ([\w-]{1,64}).
   */
  async function reportVisible(tab, visible) {
    if (!active) return false;
    await post('/api/push/visible', { tab, visible: Boolean(visible) });
    return true;
  }

  return { availability, register, subscribed, enable, disable, sendTest, syncSettings, resync, reportVisible, isActive: () => active };
}
