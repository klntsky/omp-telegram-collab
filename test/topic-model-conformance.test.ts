import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  transitionTopicField,
  topicGoal,
  type TopicFieldState,
  type TopicTarget,
} from '../src/topic-projection.js';

type Action =
  | { kind: 'publish'; value: string; generation?: number }
  | { kind: 'disable' }
  | { kind: 'queue'; ticket: number }
  | { kind: 'dispatch'; ticket: number }
  | { kind: 'apply'; ticket: number }
  | { kind: 'ack'; ticket: number }
  | { kind: 'timeout'; ticket: number }
  | { kind: 'notice'; ticket: number }
  | { kind: 'expire' };

function replay(actions: Action[]) {
  let state: TopicFieldState = { kind: 'disabled' };
  let desired: TopicTarget | undefined;
  let remote = 'initial';
  let now = 0;
  let certificate: number | undefined;
  const requests = new Map<number, { target: TopicTarget; applied: boolean }>();
  const contradicted = new Set<number>();
  for (const action of actions) {
    switch (action.kind) {
      case 'publish':
        desired = { generation: action.generation ?? 1, value: action.value };
        state = transitionTopicField(state, { type: 'publish', target: desired });
        break;
      case 'disable':
        desired = undefined;
        state = transitionTopicField(state, { type: 'publish' });
        break;
      case 'queue':
        state = transitionTopicField(state, { type: 'queue', ticket: action.ticket, now });
        break;
      case 'dispatch': {
        state = transitionTopicField(state, { type: 'dispatch', ticket: action.ticket });
        if (state.kind === 'sending' && state.attempt.ticket === action.ticket) {
          assert.deepEqual(
            state.attempt.target,
            desired,
            'dispatch must use currently accepted intent',
          );
          assert.ok(!requests.has(action.ticket), 'attempt identities cannot be reused');
          requests.set(action.ticket, { target: { ...state.attempt.target }, applied: false });
        }
        break;
      }
      case 'apply': {
        const request = requests.get(action.ticket);
        assert.ok(request, 'only dispatched requests can affect the remote');
        assert.equal(request.applied, false, 'each simulated request applies once');
        request.applied = true;
        remote = request.target.value;
        break;
      }
      case 'notice': {
        const request = requests.get(action.ticket);
        assert.ok(request?.applied, 'a generated notice must describe an applied request');
        if (
          state.kind === 'sending' &&
          requests.get(state.attempt.ticket)?.target.value !== request.target.value
        ) {
          contradicted.add(state.attempt.ticket);
        }
        state = transitionTopicField(state, { type: 'notice', value: request.target.value });
        break;
      }
      case 'ack': {
        const request = requests.get(action.ticket);
        assert.ok(request?.applied, 'a success acknowledges application, not merely dispatch');
        const active: number | undefined =
          state.kind === 'sending' ? state.attempt.ticket : undefined;
        if (active !== undefined && active !== action.ticket) contradicted.add(active);
        state = transitionTopicField(state, {
          type: 'success',
          ticket: action.ticket,
          now,
          lifetime: 10,
        });
        if (state.kind === 'confirmed') {
          assert.equal(active, action.ticket, 'a late outcome cannot certify a different attempt');
          assert.deepEqual(request.target, desired, 'confirmation needs the immutable sent target');
          assert.ok(
            !contradicted.has(action.ticket),
            'observed conflicts must forbid confirmation',
          );
          certificate = action.ticket;
        }
        break;
      }
      case 'timeout':
        state = transitionTopicField(state, {
          type: 'failure',
          ticket: action.ticket,
          retryAt: now,
        });
        break;
      case 'expire':
        now += 11;
        state = transitionTopicField(state, { type: 'expire', now });
        break;
    }
    assert.deepEqual(topicGoal(state), desired, 'transitions cannot replace accepted intent');
    if (state.kind === 'confirmed') {
      assert.ok(certificate !== undefined, 'confirmation needs a successful request certificate');
      assert.deepEqual(requests.get(certificate)?.target, desired);
      assert.ok(!contradicted.has(certificate));
    }
  }
  return { state, remote, desired };
}

const oldRequest: Action[] = [
  { kind: 'publish', value: 'a' },
  { kind: 'queue', ticket: 1 },
  { kind: 'dispatch', ticket: 1 },
  { kind: 'timeout', ticket: 1 },
];
const newRequest: Action[] = [
  ...oldRequest,
  { kind: 'publish', value: 'b' },
  { kind: 'queue', ticket: 2 },
  { kind: 'dispatch', ticket: 2 },
];
const repair: Action[] = [
  { kind: 'queue', ticket: 3 },
  { kind: 'dispatch', ticket: 3 },
  { kind: 'apply', ticket: 3 },
  { kind: 'ack', ticket: 3 },
];

test('TLC stale-ack trace cannot certify an abandoned attempt', () => {
  const result = replay([...oldRequest, { kind: 'apply', ticket: 1 }, { kind: 'ack', ticket: 1 }]);
  assert.equal(result.state.kind, 'dirty');
  assert.equal(result.remote, 'a');
});

for (const disabled of [false, true]) {
  test(`TLC notice ABA trace preserves request evidence while ${disabled ? 'disabled draining' : 'the goal changes'}`, () => {
    const trace: Action[] = [
      ...newRequest,
      { kind: 'apply', ticket: 2 },
      disabled ? { kind: 'disable' } : { kind: 'publish', value: 'a' },
      { kind: 'apply', ticket: 1 },
      { kind: 'notice', ticket: 1 },
      { kind: 'publish', value: 'b' },
      { kind: 'notice', ticket: 2 },
      { kind: 'ack', ticket: 2 },
    ];
    const pending = replay(trace);
    assert.equal(pending.state.kind, 'dirty');
    assert.equal(pending.remote, 'a');
    const corrected = replay([...trace, ...repair]);
    assert.equal(corrected.remote, 'b');
    assert.equal(corrected.state.kind, 'confirmed');
  });
}

test('TLC missing-lease trace repairs an unobserved late remote effect', () => {
  const trace: Action[] = [
    ...newRequest,
    { kind: 'apply', ticket: 2 },
    { kind: 'ack', ticket: 2 },
    { kind: 'apply', ticket: 1 },
  ];
  const before = replay(trace);
  assert.equal(before.state.kind, 'confirmed');
  assert.equal(before.remote, 'a');
  const after = replay([...trace, { kind: 'expire' }, ...repair]);
  assert.equal(after.remote, 'b');
  assert.equal(after.state.kind, 'confirmed');
});

test('equal metadata values cannot acknowledge an older generation', () => {
  const result = replay([
    { kind: 'publish', value: 'a' },
    { kind: 'queue', ticket: 1 },
    { kind: 'dispatch', ticket: 1 },
    { kind: 'apply', ticket: 1 },
    { kind: 'publish', value: 'a', generation: 2 },
    { kind: 'ack', ticket: 1 },
  ]);
  assert.equal(result.state.kind, 'dirty');
  assert.deepEqual(result.desired, { generation: 2, value: 'a' });
});

test('stale dispatch and timeout tickets cannot replace a newer queued or sending request', () => {
  const trace: Action[] = [
    ...oldRequest,
    { kind: 'publish', value: 'b' },
    { kind: 'queue', ticket: 2 },
    { kind: 'dispatch', ticket: 1 },
    { kind: 'timeout', ticket: 1 },
    { kind: 'dispatch', ticket: 2 },
    { kind: 'timeout', ticket: 1 },
  ];
  const pending = replay(trace);
  assert.equal(pending.state.kind, 'sending');
  if (pending.state.kind === 'sending') assert.equal(pending.state.attempt.ticket, 2);
  const completed = replay([...trace, { kind: 'apply', ticket: 2 }, { kind: 'ack', ticket: 2 }]);
  assert.equal(completed.remote, 'b');
  assert.equal(completed.state.kind, 'confirmed');
});

test('matching notices do not renew confirmation or establish one before acknowledgment', () => {
  const trace: Action[] = [
    { kind: 'publish', value: 'a' },
    { kind: 'queue', ticket: 1 },
    { kind: 'dispatch', ticket: 1 },
    { kind: 'apply', ticket: 1 },
    { kind: 'notice', ticket: 1 },
  ];
  assert.equal(replay(trace).state.kind, 'sending');
  const acknowledged = [...trace, { kind: 'ack', ticket: 1 } as const];
  const before = replay(acknowledged);
  const after = replay([...acknowledged, { kind: 'notice', ticket: 1 }]);
  assert.deepEqual(after.state, before.state);
  assert.equal(
    replay([...acknowledged, { kind: 'disable' }, { kind: 'notice', ticket: 1 }]).state.kind,
    'disabled',
  );
});
