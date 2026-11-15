// The same phone coming back (src/remote.js adopt()): a device already known from its tailnet node id gets a
// fresh cookie on the SAME record, so the owner is not asked for a code again after losing a cookie — and the
// device list does not grow one record per visit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteAccess } from '../src/remote.js';

function makeRemote() {
  const hub = {
    persisted: { remote: { enabled: true, devices: [] } },
    save() {},
    scheduleSave() {},
    broadcast() {},
  };
  return { remote: new RemoteAccess(hub), hub };
}

test('autoPair(): the tailnet node id is stored on the record', () => {
  const { remote } = makeRemote();
  const made = remote.autoPair('pixel-adhit', { transport: 'https', ip: '100.64.0.2', nodeId: 'node-1' });
  assert.equal(made.device.nodeId, 'node-1');
  assert.equal(remote.publicInfo(4317).devices[0].nodeId, undefined, 'never exposed to browsers');
});

test('adopt(): a known node gets a new token on the same record, and the old one stops working', () => {
  const { remote } = makeRemote();
  const first = remote.autoPair('pixel-adhit', { transport: 'https', ip: '100.64.0.2', nodeId: 'node-1' });
  assert.ok(remote.verify(first.token, { transport: 'https' }));

  const again = remote.adopt('node-1', 'pixel-adhit', { transport: 'https', ip: '100.64.0.2' });
  assert.ok(again, 'a known node is adopted, not refused');
  assert.equal(again.device.id, first.device.id, 'same record: the device list does not grow');
  assert.equal(remote.state.devices.length, 1);
  assert.ok(remote.verify(again.token, { transport: 'https' }), 'the fresh cookie works');
  assert.equal(remote.verify(first.token, { transport: 'https' }), null, 'the lost cookie was replaced');
});

test('adopt(): a phone that never paired, or paired by code, is not adopted', () => {
  const { remote } = makeRemote();
  assert.equal(remote.adopt('node-unknown', 'x', { transport: 'https', ip: '100.64.0.3' }), null, 'no record yet');
  const byCode = remote.autoPair('pixel', { transport: 'https', ip: '100.64.0.2' }); // no nodeId
  assert.equal(remote.adopt('node-1', 'pixel', { transport: 'https', ip: '100.64.0.2' }), null, 'a record without a node id is never matched');
  assert.ok(remote.verify(byCode.token, { transport: 'https' }));
});

test('adopt(): keeps the transport binding (a tailnet token never works over plain WiFi)', () => {
  const { remote } = makeRemote();
  remote.autoPair('pixel-adhit', { transport: 'https', ip: '100.64.0.2', nodeId: 'node-1' });
  const again = remote.adopt('node-1', 'pixel-adhit', { transport: 'https', ip: '100.64.0.2' });
  assert.equal(remote.verify(again.token, { transport: 'http' }), null);
});

test('adopt(): off with phone access, and paced like autoPair', () => {
  const { remote } = makeRemote();
  remote.autoPair('pixel-adhit', { transport: 'https', ip: '100.64.0.2', nodeId: 'node-1' });
  const now = Date.now();
  for (let i = 0; i < 4; i += 1) assert.ok(remote.adopt('node-1', 'pixel-adhit', { transport: 'https', ip: '100.64.0.2', now: now + i }), `#${i + 1}`);
  // autoPair already spent one attempt from this IP in this minute
  assert.equal(remote.adopt('node-1', 'pixel-adhit', { transport: 'https', ip: '100.64.0.2', now: now + 10 }), null, 'minute bucket full');

  remote.setEnabled(false);
  assert.equal(remote.adopt('node-1', 'pixel-adhit', { transport: 'https', ip: '100.64.0.2', now: now + 120_000 }), null);
});

// ---------- a device paired with the 6-digit code / QR link over Tailscale (src/remote.js pair()) ----------
// server.js stores the proven tailnet node id on that record too, so "the same phone" is not asked for a code
// again either — the owner's complaint exactly. Everything else about the code (single use, rate limit) is
// untouched: only the record shape gains the node id.

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

test('pair(): a code pairing with a proven node id is adopted later, on the same record', () => {
  const { remote } = makeRemote();
  const paired = remote.pair({ code: remote.currentPairing().code }, IPHONE, '100.64.0.2', { transport: 'https', nodeId: 'node-1' });
  assert.ok(paired.token);
  assert.equal(paired.device.nodeId, 'node-1');
  assert.equal(paired.device.transport, 'https');
  assert.equal(remote.publicInfo(4317).devices[0].nodeId, undefined, 'never exposed to browsers');

  const again = remote.adopt('node-1', 'pixel-adhit', { transport: 'https', ip: '100.64.0.2' });
  assert.ok(again, 'the same phone is not asked for a code again');
  assert.equal(again.device.id, paired.device.id, 'same record: the device list does not grow');
  assert.equal(remote.state.devices.length, 1);
  assert.ok(remote.verify(again.token, { transport: 'https' }), 'the fresh cookie works');
  assert.equal(remote.verify(paired.token, { transport: 'https' }), null, 'the lost cookie was replaced');
});

test('pair(): the QR link over Tailscale also keeps its node id', () => {
  const { remote } = makeRemote();
  const paired = remote.pair({ key: remote.currentPairing().key }, IPHONE, '100.64.0.2', { transport: 'https', nodeId: 'node-1' });
  assert.equal(paired.device.nodeId, 'node-1');
  assert.ok(remote.adopt('node-1', 'pixel-adhit', { transport: 'https', ip: '100.64.0.2' }));
  assert.equal(remote.state.devices.length, 1);
});

test('pair(): without a proven node id the device is never adopted (the code is asked again)', () => {
  const { remote } = makeRemote();
  // Plain WiFi: nobody proved who the peer is, so server.js passes no node id.
  const paired = remote.pair({ code: remote.currentPairing().code }, IPHONE, '192.168.1.20', { transport: 'http' });
  assert.ok(paired.token);
  assert.equal(paired.device.nodeId, undefined);
  assert.equal(remote.adopt('node-1', 'pixel', { transport: 'https', ip: '100.64.0.2' }), null, 'a record without a node id is never matched');
  assert.ok(remote.verify(paired.token, { transport: 'http' }), 'the existing cookie keeps working');
  assert.equal(remote.state.devices.length, 1);
});

test('pair(): another tailnet node, and the transport binding, still refuse the cookie', () => {
  const { remote } = makeRemote();
  const paired = remote.pair({ code: remote.currentPairing().code }, IPHONE, '100.64.0.2', { transport: 'https', nodeId: 'node-1' });
  assert.equal(remote.adopt('node-2', 'teman', { transport: 'https', ip: '100.64.0.9' }), null, 'another tailnet node is another device');
  assert.ok(remote.verify(paired.token, { transport: 'https' }));

  const again = remote.adopt('node-1', 'pixel-adhit', { transport: 'https', ip: '100.64.0.2' });
  assert.equal(remote.verify(again.token, { transport: 'http' }), null, 'a tailnet cookie never works over plain WiFi');
});

test('pair(): the code stays single use — storing a node id changes nothing there', () => {
  const { remote } = makeRemote();
  const code = remote.currentPairing().code;
  assert.ok(remote.pair({ code }, IPHONE, '100.64.0.2', { transport: 'https', nodeId: 'node-1' }).token);
  const reused = remote.pair({ code }, IPHONE, '100.64.0.2', { transport: 'https', nodeId: 'node-1' });
  assert.equal(reused.token, undefined, 'the used code is gone');
  assert.equal(remote.state.devices.length, 1);
});
