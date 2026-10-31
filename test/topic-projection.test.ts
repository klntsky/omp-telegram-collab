import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  transitionTopicField,
  type TopicFieldEvent,
  type TopicFieldState,
} from '../src/topic-projection.js';

function replay(events: TopicFieldEvent[]): TopicFieldState {
  let state: TopicFieldState = { kind: 'disabled' };
  for (const event of events) {
    state = transitionTopicField(state, event);
  }
  return state;
}
const a = { generation: 1, value: 'A' };
const b = { generation: 1, value: 'B' };
const send: TopicFieldEvent[] = [
  { type: 'publish', target: a },
  { type: 'queue', ticket: 1, now: 0 },
  { type: 'dispatch', ticket: 1 },
];

test('topic reducer coalesces latest queued target under the same admission ticket', () => {
  const state = replay([
    { type: 'publish', target: a },
    { type: 'queue', ticket: 1, now: 0 },
    { type: 'publish', target: b },
    { type: 'dispatch', ticket: 1 },
  ]);
  assert.deepEqual(state, {
    kind: 'sending',
    goal: b,
    attempt: { ticket: 1, target: b },
    evidence: 'undisturbed',
  });
});
test('topic reducer preserves failure backoff when desired payload changes', () => {
  const state = replay([
    ...send,
    { type: 'failure', ticket: 1, retryAt: 30 },
    { type: 'publish', target: b },
    { type: 'queue', ticket: 2, now: 29 },
  ]);
  assert.deepEqual(state, { kind: 'dirty', target: b, retryAt: 30 });
  assert.deepEqual(transitionTopicField(state, { type: 'queue', ticket: 2, now: 30 }), {
    kind: 'queued',
    target: b,
    ticket: 2,
  });
});
test('topic reducer copies targets and retains explicit empty icon values', () => {
  const input = { generation: 1, value: '' };
  const state = replay([{ type: 'publish', target: input }]);
  input.value = 'changed';
  assert.deepEqual(state, { kind: 'dirty', target: { generation: 1, value: '' }, retryAt: 0 });
});

test('late topic success does not acknowledge an abandoned edit', () => {
  const state = replay([
    ...send,
    { type: 'failure', ticket: 1, retryAt: 0 },
    { type: 'success', ticket: 1, now: 0, lifetime: 10 },
  ]);
  assert.deepEqual(state, { kind: 'dirty', target: a, retryAt: 0 });
});

for (const disabled of [false, true]) {
  test(`conflicting topic notices survive ${disabled ? 'disabled publication' : 'a changed target'}`, () => {
    const state = replay([
      ...send,
      { type: 'failure', ticket: 1, retryAt: 0 },
      { type: 'publish', target: b },
      { type: 'queue', ticket: 2, now: 0 },
      { type: 'dispatch', ticket: 2 },
      disabled ? { type: 'publish' } : { type: 'publish', target: a },
      { type: 'notice', value: a.value },
      { type: 'publish', target: b },
      { type: 'notice', value: b.value },
      { type: 'success', ticket: 2, now: 0, lifetime: 10 },
    ]);
    assert.deepEqual(state, { kind: 'dirty', target: b, retryAt: 0 });
    const repair: TopicFieldEvent[] = [
      { type: 'queue', ticket: 3, now: 0 },
      { type: 'dispatch', ticket: 3 },
      { type: 'success', ticket: 3, now: 0, lifetime: 10 },
    ];
    const completed = repair.reduce<TopicFieldState>(transitionTopicField, state);
    assert.deepEqual(completed, { kind: 'confirmed', target: b, expiresAt: 10 });
  });
}

test('older session generation cannot acknowledge identical metadata', () => {
  const target = { ...a, generation: 2 };
  const state = replay([
    ...send,
    { type: 'publish', target },
    { type: 'success', ticket: 1, now: 0, lifetime: 10 },
  ]);
  assert.deepEqual(state, { kind: 'dirty', target, retryAt: 0 });
});

test('obsolete topic jobs cannot replace newer pending edits', () => {
  const state = replay([
    ...send,
    { type: 'failure', ticket: 1, retryAt: 0 },
    { type: 'publish', target: b },
    { type: 'queue', ticket: 2, now: 0 },
    { type: 'dispatch', ticket: 1 },
    { type: 'failure', ticket: 1, retryAt: 30 },
    { type: 'dispatch', ticket: 2 },
    { type: 'failure', ticket: 1, retryAt: 30 },
    { type: 'success', ticket: 2, now: 0, lifetime: 10 },
  ]);
  assert.deepEqual(state, { kind: 'confirmed', target: b, expiresAt: 10 });
});
