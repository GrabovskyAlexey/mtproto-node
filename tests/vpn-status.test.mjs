import test from 'node:test';
import assert from 'node:assert/strict';
import { createVpnStatusChecker } from '../src/services/vpn-status.ts';

test('disabled skips inspection and stopped skips tunnel probe', async () => {
  let inspections = 0;
  const checker = createVpnStatusChecker({ inspect: async () => { inspections++; return { running: false, identity: 'a' }; }, probe: async () => { throw Error('unexpected'); } });
  assert.equal((await checker.check('x', false)).state, 'disabled');
  assert.equal(inspections, 0);
  assert.equal((await checker.check('x', true)).state, 'stopped');
});
test('caches successful probe but invalidates on container identity change', async () => {
  let identity = 'a', probes = 0;
  const checker = createVpnStatusChecker({ inspect: async () => ({ running: true, identity }), probe: async () => { probes++; return 12; } });
  assert.equal((await checker.check('x', true)).state, 'connected');
  await checker.check('x', true);
  assert.equal(probes, 1);
  identity = 'b';
  await checker.check('x', true);
  assert.equal(probes, 2);
});
test('probe failure is disconnected and inspect failure unknown without leaking errors', async () => {
  const checker = createVpnStatusChecker({ inspect: async () => ({ running: true, identity: 'a' }), probe: async () => { throw Error('secret'); } });
  assert.equal((await checker.check('x', true)).state, 'disconnected');
  const failed = createVpnStatusChecker({ inspect: async () => { throw Error('secret'); }, probe: async () => {} });
  assert.equal((await failed.check('x', true)).state, 'unknown');
  assert.ok(!JSON.stringify(await failed.check('x', true)).includes('secret'));
});
test('concurrent checks share a probe and expire after thirty seconds', async () => {
  let now = 1000, probes = 0;
  const checker = createVpnStatusChecker({ now: () => now, inspect: async () => ({ running: true, identity: 'a' }), probe: async () => { probes++; await new Promise(r => setTimeout(r, 10)); } });
  await Promise.all([checker.check('x', true), checker.check('x', true)]);
  assert.equal(probes, 1);
  now += 30001;
  await checker.check('x', true);
  assert.equal(probes, 2);
});
test('hanging Docker inspection and probe are bounded', async () => {
  const never = () => new Promise(() => {});
  const inspecting = createVpnStatusChecker({ inspect: never, probe: async () => {} });
  const probing = createVpnStatusChecker({ inspect: async () => ({ running: true, identity: 'a' }), probe: never });
  const [unknown, disconnected] = await Promise.all([inspecting.check('x', true), probing.check('x', true)]);
  assert.equal(unknown.state, 'unknown');
  assert.equal(disconnected.state, 'disconnected');
});
