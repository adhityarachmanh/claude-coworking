import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { isTailscaleIp, lanAddresses, networkAddresses } from '../src/remote.js';

const v4 = (address) => ({ family: 'IPv4', address, internal: false });

test('addresses are classified: WiFi/LAN first, then Tailscale, virtual adapters last', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({
    'vEthernet (WSL (Hyper-V firewall))': [v4('172.18.144.1')],
    Tailscale: [v4('100.101.5.9')],
    'Wi-Fi': [v4('192.168.1.14'), { family: 'IPv6', address: 'fe80::1', internal: false }],
    docker0: [v4('172.17.0.1')],
    Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    Ethernet: [v4('169.254.10.2')], // link-local: unreachable, skipped
    tailscale0: [v4('100.64.0.7')], // Linux name, CGNAT range
  }));
  assert.deepEqual(networkAddresses().map((a) => [a.ip, a.kind]), [
    ['192.168.1.14', 'lan'],
    ['100.101.5.9', 'tailscale'],
    ['100.64.0.7', 'tailscale'],
    ['172.18.144.1', 'virtual'],
    ['172.17.0.1', 'virtual'],
  ]);
  assert.equal(lanAddresses().length, 5); // the listener still answers on all of them
});

test('a 100.x address outside the Tailscale range is ordinary LAN', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({ Ethernet: [v4('100.200.1.1')] }));
  assert.equal(networkAddresses()[0].kind, 'lan');
});

test('only Tailscale addresses may manage the Claude account from a phone', () => {
  for (const ip of ['100.64.0.1', '100.101.5.9', '100.127.255.254', '::ffff:100.80.1.2']) assert.ok(isTailscaleIp(ip), ip);
  for (const ip of ['192.168.1.14', '100.63.0.1', '100.128.0.1', '10.100.0.1', '172.18.144.1', '', undefined]) assert.ok(!isTailscaleIp(ip), String(ip));
});
