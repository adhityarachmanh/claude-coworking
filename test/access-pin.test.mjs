// The access PIN (src/access-pin.js): the rules that make a 6-digit code safe enough to authorise a new phone.
// Clock, randomness and the WhatsApp send are injected, so every limit is exercised without waiting or network.
//
// Two of the rules exist because anyone on the same WiFi can reach /api/auth/* before pairing:
//   • a PIN belongs to the browser that asked for it (`request()` returns a token) — without it, three wrong
//     digits would burn the owner's live PIN for free;
//   • wrong digits are counted across PINs, so "ask a PIN, guess it, ask another" does not add up.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccessPin, PIN_COOLDOWN_MS, PIN_LOCK_MS, PIN_MAX_PER_IP_PER_HOUR, PIN_RETRY_AFTER_FAILURE_MS, PinError, pinCooldownMs,
} from '../src/access-pin.js';

function makePin(options = {}) {
  const sent = [];
  let clock = 1_700_000_000_000;
  const pin = new AccessPin({
    send: async (value) => { sent.push(value); }, // the transport decides the wording (access-pin.pinMessage)
    now: () => clock,
    ...options,
  });
  return {
    pin,
    sent,
    advance: (ms) => { clock += ms; },
    code: () => sent.at(-1),
    /** Requests a PIN and returns the requester token that may spend it. */
    ask: async (context) => (await pin.request(context)).token,
  };
}

test('request: sends one 6-digit PIN over WhatsApp, hands back a requester token, keeps only hashes', async () => {
  const { pin, sent, code, ask } = makePin();
  const token = await ask({ ip: '1.2.3.4', userAgent: 'iPhone' });
  assert.match(token, /^[\w-]{40,}$/, 'a 32-byte token, not the PIN');
  assert.equal(sent.length, 1);
  const value = code();
  assert.match(value, /^\d{6}$/);
  assert.equal(token.includes(value), false);
  assert.equal(JSON.stringify(pin.status({ token })).includes(value), false, 'the PIN never leaves through status()');
  assert.equal(pin.status({ token }).active, true);
});

test('status: "active" belongs to the device that asked; a stranger sees nothing', async () => {
  const { pin, ask } = makePin();
  const token = await ask();
  assert.equal(pin.status({ token }).active, true);
  assert.equal(pin.status().active, false, 'no token → no information about the live PIN');
  assert.equal(pin.status({ token }).expiresInSec > 0, true);
  assert.equal(pin.status({ token: 'someone-else' }).active, false);
});

test('verify: the right PIN works exactly once, and only with its requester token', async () => {
  const { pin, ask, code } = makePin();
  const token = await ask();
  assert.throws(() => pin.verify(code(), { token: 'not-the-asker' }), (err) => err instanceof PinError && err.code === 'other_device' && err.status === 401);
  assert.throws(() => pin.verify(code()), (err) => err.code === 'other_device', 'no token at all is a different device too');
  assert.deepEqual(pin.verify(code(), { token }), { ok: true });
  assert.equal(pin.status({ token }).active, false, 'one-time use');
  assert.throws(() => pin.verify(code(), { token }), (err) => err.code === 'expired');
});

test('verify: another device cannot spend a single attempt of a live PIN', async () => {
  const { pin, code, ask } = makePin();
  const token = await ask();
  for (let i = 0; i < 5; i += 1) {
    assert.throws(() => pin.verify('999999', { token: 'other-device' }), (err) => err.code === 'other_device');
  }
  assert.deepEqual(pin.verify(code(), { token }), { ok: true }, 'the owner PIN survived the stranger entirely');
});

test('verify: three wrong attempts burn the PIN', async () => {
  const { pin, ask } = makePin();
  const token = await ask();
  assert.deepEqual(pin.verify('000000', { token }), { ok: false, triesLeft: 2 });
  assert.deepEqual(pin.verify('111111', { token }), { ok: false, triesLeft: 1 });
  assert.throws(() => pin.verify('222222', { token }), (err) => err instanceof PinError && err.code === 'burned' && err.status === 401);
  assert.equal(pin.status({ token }).active, false);
});

test('verify: a non-numeric guess counts as a wrong attempt, never as a match', async () => {
  const { pin, ask } = makePin();
  const token = await ask();
  assert.deepEqual(pin.verify('abcdef', { token }), { ok: false, triesLeft: 2 });
  assert.deepEqual(pin.verify(undefined, { token }), { ok: false, triesLeft: 1 });
});

test('verify: the PIN expires after 5 minutes', async () => {
  const { pin, code, advance, ask } = makePin();
  const token = await ask();
  advance(5 * 60_000 + 1);
  assert.throws(() => pin.verify(code(), { token }), (err) => err.code === 'expired');
});

test('request: a second PIN does not invalidate the message the owner is still reading', async () => {
  const { pin, advance, ask, sent } = makePin();
  const firstToken = await ask({ ip: '10.0.0.1' });
  const first = sent.at(-1);
  advance(60_000);
  const secondToken = await ask({ ip: '10.0.0.1' });
  const second = sent.at(-1);
  // A stranger can touch neither PIN.
  assert.throws(() => pin.verify('000000', { token: 'other-device' }), (err) => err.code === 'other_device');
  // The owner reads the FIRST message (still in the chat): it pairs the first browser and leaves the new PIN alone.
  assert.deepEqual(pin.verify(first, { token: firstToken }), { ok: true });
  assert.deepEqual(pin.verify(second, { token: secondToken }), { ok: true });
  assert.equal(pin.status({ token: firstToken }).active, false, 'each PIN is one use');
  assert.equal(pin.status({ token: secondToken }).active, false);
});

test('request: one minute cooldown between codes', async () => {
  const { pin, advance, ask } = makePin();
  const token = await ask();
  await assert.rejects(() => pin.request(), (err) => err.code === 'cooldown' && err.retryAfterSec === 60);
  advance(60_000);
  await pin.request();
  assert.equal(pin.status({ token }).canRequestInSec, 60);
});

test('request: at most five codes per hour, and no more than three from one address', async () => {
  const { pin, advance, ask } = makePin();
  for (let i = 0; i < 5; i += 1) {
    await ask({ ip: `10.0.0.${i}` }); // five DIFFERENT devices: the global cap is what stops them
    advance(60_000);
  }
  await assert.rejects(() => pin.request({ ip: '10.0.0.9' }), (err) => err.code === 'rate_limited');
  advance(56 * 60_000); // the first request falls out of the window
  await pin.request({ ip: '10.0.0.9' });
});

test('request: one address cannot use up the owner hourly budget', async () => {
  const { pin, advance, ask } = makePin();
  for (let i = 0; i < PIN_MAX_PER_IP_PER_HOUR; i += 1) {
    await ask({ ip: '192.168.1.50' });
    advance(60_000);
  }
  await assert.rejects(
    () => pin.request({ ip: '192.168.1.50' }),
    (err) => err.code === 'rate_limited' && /perangkat ini/.test(err.message),
  );
  await ask({ ip: '192.168.1.51' }); // another device still gets its own allowance
});

test('wrong digits are counted across PINs: too many in an hour pauses issuing', async () => {
  const { pin, advance, ask } = makePin();
  /** One wrong digit; the third one per PIN throws `burned`, which is expected here. */
  const wrong = (token) => { try { pin.verify('000000', { token }); } catch { /* burned on the third */ } };
  // 8 wrong digits over three PINs (3 + 3 + 2): the per-PIN allowance is not a renewable budget.
  for (let round = 0; round < 2; round += 1) {
    const token = await ask({ ip: `10.0.0.${round + 1}` });
    for (let i = 0; i < 3; i += 1) wrong(token);
    advance(60_000);
  }
  const token = await ask({ ip: '10.0.0.3' });
  wrong(token);
  wrong(token);
  await assert.rejects(() => pin.request(), (err) => err.code === 'locked' && err.retryAfterSec === Math.ceil(PIN_LOCK_MS / 1000));
  advance(PIN_LOCK_MS);
  await pin.request({ ip: '10.0.0.3' });
});

test('request: a WhatsApp failure leaves no live PIN, does not spend the budget, and holds a short retry', async () => {
  let fail = true;
  const { pin, advance } = makePin({
    send: async () => {
      if (fail) throw new Error('gateway down');
    },
  });
  await assert.rejects(() => pin.request(), (err) => err instanceof PinError && err.code === 'wa_failed');
  assert.equal(pin.status().active, false);
  // Not the full minute (the owner never saw a code), but not a tight loop either.
  await assert.rejects(() => pin.request(), (err) => err.code === 'cooldown');
  assert.equal(pin.status().canRequestInSec, Math.ceil(PIN_RETRY_AFTER_FAILURE_MS / 1000));
  advance(PIN_RETRY_AFTER_FAILURE_MS);
  fail = false;
  const { token } = await pin.request();
  assert.equal(pin.status({ token }).active, true);
});

test('clear: unpairing drops the live PIN', async () => {
  const { pin, ask } = makePin();
  const token = await ask();
  pin.clear();
  assert.equal(pin.status({ token }).active, false);
  assert.throws(() => pin.verify('123456', { token }), (err) => err.code === 'expired');
});

test('pinCooldownMs: the 60 s default survives every bad override', () => {
  assert.equal(pinCooldownMs({}), PIN_COOLDOWN_MS);
  assert.equal(pinCooldownMs({ OFFICE_PIN_COOLDOWN_MS: '' }), PIN_COOLDOWN_MS);
  assert.equal(pinCooldownMs({ OFFICE_PIN_COOLDOWN_MS: 'soon' }), PIN_COOLDOWN_MS);
  assert.equal(pinCooldownMs({ OFFICE_PIN_COOLDOWN_MS: '-1' }), PIN_COOLDOWN_MS, 'a negative wait is no wait at all');
  assert.equal(pinCooldownMs({ OFFICE_PIN_COOLDOWN_MS: '1000' }), 1000, 'the test runner shortens it on purpose');
  assert.equal(pinCooldownMs({ OFFICE_PIN_COOLDOWN_MS: '0' }), 0);
});
