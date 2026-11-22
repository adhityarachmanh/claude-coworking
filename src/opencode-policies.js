// OpenCode policies (top-level `policies`): ordered statements that only ever tighten what agents may use.
// `effect` is allow or deny (never ask); the order is the user's (last match wins upstream), and unknown keys of a
// statement survive an edit. Pure rules: config in, config out — no file IO here.
export const POLICY_ACTIONS = Object.freeze([
  'provider.use',
  'tool.use',
  'integration.connect',
  'integration.use',
  'mcp.use',
  'skill.use',
  'plugin.use',
  'websearch.use',
]);

export const POLICY_LIMITS = Object.freeze({ count: 100, action: 64, resource: 500 });

export class OpenCodePolicyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ACTION = /^[a-z][a-z0-9._-]{0,63}$/;
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The statements the form can represent; a malformed hand-written entry is ignored by the form (JSON tab fixes it). */
export function policiesView(config) {
  if (!Array.isArray(config?.policies)) return [];
  return config.policies
    .filter((item) => isObject(item) && typeof item.action === 'string' && typeof item.resource === 'string' && (item.effect === 'allow' || item.effect === 'deny'))
    .map((item) => ({ action: item.action, resource: item.resource, effect: item.effect }));
}

const keyOf = (action, resource) => `${action}\u0000${resource}`;

/**
 * Replaces the policies list with the form's rows, keeping statement order and any unknown fields of a statement that
 * is still there. An empty list removes the key; a non-list `policies` value refuses the save instead of guessing.
 */
export function mergePolicies(config, items) {
  if (!Array.isArray(items)) throw new OpenCodePolicyError(400, 'Daftar policies tidak valid.');
  if (items.length > POLICY_LIMITS.count) throw new OpenCodePolicyError(400, `Maksimal ${POLICY_LIMITS.count} policy.`);
  if (config.policies !== undefined && !Array.isArray(config.policies)) {
    throw new OpenCodePolicyError(400, 'Bagian "policies" bukan array. Perbaiki lewat tab JSON dulu.');
  }
  const old = new Map();
  for (const item of Array.isArray(config.policies) ? config.policies : []) {
    if (!isObject(item) || typeof item.action !== 'string' || typeof item.resource !== 'string') continue;
    old.set(keyOf(item.action, item.resource), item);
  }
  const next = [];
  for (const item of items) {
    if (!isObject(item)) throw new OpenCodePolicyError(400, 'Setiap policy harus berupa objek.');
    const action = String(item.action ?? '').trim();
    const resource = String(item.resource ?? '').trim();
    const effect = item.effect;
    if (!ACTION.test(action)) throw new OpenCodePolicyError(400, 'Action policy tidak valid (huruf kecil, angka, titik, garis bawah, minus).');
    if (!resource) throw new OpenCodePolicyError(400, 'Resource policy tidak boleh kosong.');
    if (resource.length > POLICY_LIMITS.resource) throw new OpenCodePolicyError(400, `Resource policy maksimal ${POLICY_LIMITS.resource} karakter.`);
    if (/[\u0000-\u001f\u007f]/.test(resource)) throw new OpenCodePolicyError(400, 'Resource policy tidak boleh memuat karakter kontrol.');
    if (effect !== 'allow' && effect !== 'deny') throw new OpenCodePolicyError(400, 'Effect policy harus allow atau deny (policy tidak pernah meminta izin).');
    next.push({ ...(old.get(keyOf(action, resource)) ?? {}), action, resource, effect });
  }
  if (next.length) config.policies = next;
  else delete config.policies;
}
