import test from 'node:test';
import { verifyNativeObserver } from '../../scripts/host-observer-smoke.js';

test('stock OMP observes intentional switches without adopting writer continuations', { timeout: 300000 }, async () => {
  await verifyNativeObserver();
});
