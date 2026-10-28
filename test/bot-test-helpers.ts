import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Expected state transition did not occur');
    await delay(20);
  }
}
