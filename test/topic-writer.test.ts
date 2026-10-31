import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TopicWriter } from '../src/topic-writer.js';

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function unexpected(error: unknown): never {
  throw error;
}

test('writer converges to changes made during an outstanding request', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const sent: string[] = [];
  const writer = new TopicWriter(
    async (take) => {
      const value = take();
      if (value !== undefined) sent.push(value);
      if (sent.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return value;
    },
    () => true,
    unexpected,
  );
  const completion = writer.publish('A');
  await entered.promise;
  writer.publish('B');
  writer.publish('C');
  release.resolve();
  await completion;
  assert.deepEqual(sent, ['A', 'C']);
  await writer.publish('C');
  assert.deepEqual(sent, ['A', 'C']);
});

test('A to B to A remains work even when A was previously delivered', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const sent: string[] = [];
  const writer = new TopicWriter(
    async (take) => {
      const value = take();
      if (value !== undefined) sent.push(value);
      if (value === 'B') {
        entered.resolve();
        await release.promise;
      }
      return value;
    },
    () => true,
    unexpected,
  );
  await writer.publish('A');
  const completion = writer.publish('B');
  await entered.promise;
  writer.publish('A');
  writer.publish('B');
  writer.publish('A');
  release.resolve();
  await completion;
  assert.deepEqual(sent, ['A', 'B', 'A']);
});

test('unchanged healthy activity during and after await never duplicates delivery', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const writer = new TopicWriter(
    async (take) => {
      calls++;
      const value = take();
      entered.resolve();
      await release.promise;
      return value;
    },
    () => true,
    unexpected,
  );
  const completion = writer.publish('A');
  await entered.promise;
  writer.publish('A');
  writer.observe('A');
  writer.publish('A');
  release.resolve();
  await completion;
  await writer.publish('A');
  await writer.observe('A');
  assert.equal(calls, 1);
});

test('admission takes the latest value rather than the queued value', async () => {
  const queued = deferred<void>();
  const admit = deferred<void>();
  const sent: string[] = [];
  const writer = new TopicWriter(
    async (take) => {
      queued.resolve();
      await admit.promise;
      const value = take();
      if (value !== undefined) sent.push(value);
      return value;
    },
    () => true,
    unexpected,
  );
  const completion = writer.publish('A');
  await queued.promise;
  writer.publish('B');
  writer.publish('C');
  admit.resolve();
  await completion;
  assert.deepEqual(sent, ['C']);
});

test('failure stays pending without spinning and next unchanged activity retries', async () => {
  const failure = new Error('original transport error');
  const errors: unknown[] = [];
  const sent: string[] = [];
  let fail = true;
  const writer = new TopicWriter(
    async (take) => {
      const value = take();
      if (value !== undefined) sent.push(value);
      if (fail) throw failure;
      return value;
    },
    () => true,
    (error) => errors.push(error),
  );
  await writer.publish('A');
  await writer.completion;
  assert.deepEqual(sent, ['A']);
  assert.deepEqual(errors, [failure]);
  fail = false;
  await writer.publish('A');
  await writer.publish('A');
  assert.deepEqual(sent, ['A', 'A']);
});

test('conflicting observations repair while matching observations create no work', async () => {
  const sent: string[] = [];
  const writer = new TopicWriter(
    async (take) => {
      const value = take();
      if (value !== undefined) sent.push(value);
      return value;
    },
    () => true,
    unexpected,
  );
  await writer.publish('A');
  await writer.observe('A');
  assert.deepEqual(sent, ['A']);
  await writer.observe('human edit');
  assert.deepEqual(sent, ['A', 'A']);
});

test('matching observation during await cannot erase a pending conflict', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const sent: string[] = [];
  const writer = new TopicWriter(
    async (take) => {
      const value = take();
      if (value !== undefined) sent.push(value);
      if (sent.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return value;
    },
    () => true,
    unexpected,
  );
  const completion = writer.publish('A');
  await entered.promise;
  writer.observe('human edit');
  writer.observe('A');
  release.resolve();
  await completion;
  assert.deepEqual(sent, ['A', 'A']);
});

test('undefined disables queued dispatch and empty string remains a real value', async () => {
  const queued = deferred<void>();
  const admit = deferred<void>();
  const sent: string[] = [];
  const writer = new TopicWriter(
    async (take) => {
      queued.resolve();
      await admit.promise;
      const value = take();
      if (value !== undefined) sent.push(value);
      return value;
    },
    () => true,
    unexpected,
  );
  const completion = writer.publish('A');
  await queued.promise;
  writer.publish(undefined);
  writer.observe('human edit');
  admit.resolve();
  await completion;
  assert.deepEqual(sent, []);
  await writer.publish('');
  await writer.publish('');
  assert.deepEqual(sent, ['']);
});

test('inactive lifecycle prevents admitted dispatch and suppresses late diagnostics', async () => {
  const queued = deferred<void>();
  const admit = deferred<void>();
  const errors: unknown[] = [];
  let active = true;
  let calls = 0;
  const writer = new TopicWriter(
    async (take) => {
      calls++;
      queued.resolve();
      await admit.promise;
      assert.equal(take(), undefined);
      throw new Error('late disposed failure');
    },
    () => active,
    (error) => errors.push(error),
  );
  const completion = writer.publish('A');
  await queued.promise;
  active = false;
  admit.resolve();
  await completion;
  await writer.publish('B');
  await writer.observe('other');
  assert.equal(calls, 1);
  assert.deepEqual(errors, []);
});

test('reentrant delivery shares the installed worker and drains its new publication', async () => {
  const sent: string[] = [];
  let reentrant: Promise<void> | undefined;
  const writer: TopicWriter = new TopicWriter(
    async (take) => {
      const value = take();
      if (value !== undefined) sent.push(value);
      if (value === 'A') {
        reentrant = writer.publish('B');
        assert.equal(reentrant, writer.completion);
      }
      return value;
    },
    () => true,
    unexpected,
  );
  const completion = writer.publish('A');
  await completion;
  assert.equal(reentrant, completion);
  assert.deepEqual(sent, ['A', 'B']);
  await completion.then(() => writer.publish('C'));
  assert.deepEqual(sent, ['A', 'B', 'C']);
});

test('an unadmitted attempt waits for later activity instead of spinning', async () => {
  const sent: string[] = [];
  let admitted = false;
  let calls = 0;
  const writer = new TopicWriter(
    async (take) => {
      calls++;
      if (!admitted) return undefined;
      const value = take();
      if (value !== undefined) sent.push(value);
      return value;
    },
    () => true,
    unexpected,
  );
  await writer.publish('A');
  assert.equal(calls, 1);
  assert.deepEqual(sent, []);
  admitted = true;
  await writer.publish('A');
  assert.equal(calls, 2);
  assert.deepEqual(sent, ['A']);
});
