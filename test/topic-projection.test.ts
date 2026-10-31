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
