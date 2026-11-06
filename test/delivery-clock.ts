import { setImmediate as settle } from 'node:timers/promises';
import type { TestContext } from 'node:test';

export function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  return async (ms: number) => {
    await settle();
    t.mock.timers.tick(ms);
    await settle();
  };
}
