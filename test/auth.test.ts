import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isActiveMember, TicketStore, validateGuestFrame, validateInitData } from '../src/auth.js';
import { botToken, ownerId, signedInitData } from './telegram-data.js';

const sessionId = 'RkJQtSOXgS9CFpCqE_BxYg';
const seconds = 1_800_000_000;
const now = seconds * 1000;

function init(extra: Record<string, string> = {}) {
  return signedInitData(sessionId, { authDate: seconds, extra });
}

test('signed Telegram identity retains the signed session parameter and modern signature field', () => {
  const data = validateInitData(init({ signature: 'telegram-ed25519-signature' }), botToken, { now });
  assert.equal(data.user.id, ownerId);
  assert.equal(data.startParam, `s_${sessionId}`);
  assert.equal(data.authDate, seconds);
});

test('signed data cannot be reused with a different bot or modified identity', () => {
  assert.throws(() => validateInitData(init(), '987654321:different-token', { now }));
  const values = new URLSearchParams(init());
  values.set('user', JSON.stringify({ id: 999, first_name: 'Mallory' }));
  assert.throws(() => validateInitData(values.toString(), botToken, { now }));
});

test('expired and future-dated initialization is rejected', () => {
  assert.throws(() => validateInitData(signedInitData(sessionId, { authDate: seconds - 3601 }), botToken, { now }));
  assert.throws(() => validateInitData(signedInitData(sessionId, { authDate: seconds + 31 }), botToken, { now }));
});

test('duplicate identity, session, and hash parameters cannot create parsing disagreement', () => {
  for (const suffix of ['&user=%7B%22id%22%3A999%7D', '&start_param=s_other', '&hash=' + '0'.repeat(64)]) {
    assert.throws(() => validateInitData(init() + suffix, botToken, { now }));
  }
});

test('a valid HMAC does not admit a malformed user identity', () => {
  for (const user of ['not-json', '{}', '{"id":-1,"first_name":"A"}', '{"id":"42","first_name":"A"}', '{"id":42,"is_bot":true,"first_name":"A"}']) {
    assert.throws(() => validateInitData(init({ user }), botToken, { now }));
  }
});

test('only current group members receive session access', () => {
  for (const status of ['creator', 'administrator', 'member']) {
    assert.equal(isActiveMember({ status }), true);
  }
  assert.equal(isActiveMember({ status: 'restricted', is_member: true }), true);
  for (const member of [{ status: 'left' }, { status: 'kicked' }, { status: 'restricted', is_member: false }]) {
    assert.equal(isActiveMember(member), false);
  }
  assert.equal(isActiveMember({ status: 'member', user: { is_bot: true } }), false);
});

test('gateway rejects identity injection, unknown actions, and invalid transcript offsets', () => {
  for (const value of [
    { t: 'hello', proto: 3, name: 'forged', writeToken: 'secret' },
    { t: 'exec', command: 'pwd' },
    { t: 'prompt', text: '' },
    { t: 'prompt', text: 'x'.repeat(100_001) },
    { t: 'fetch-transcript', reqId: 1, agentId: 'a', fromByte: -1 },
    { t: 'agent-cmd', cmd: 'shell', agentId: 'a' },
  ]) {
    assert.throws(() => validateGuestFrame(value));
  }
});

test('gateway preserves valid domain actions without admitting a supplied identity', () => {
  assert.deepEqual(validateGuestFrame({ t: 'prompt', text: 'Fix the login redirect.' }), { t: 'prompt', text: 'Fix the login redirect.' });
  assert.deepEqual(validateGuestFrame({ t: 'fetch-transcript', reqId: 2, agentId: 'worker', fromByte: 4096 }), {
    t: 'fetch-transcript', reqId: 2, agentId: 'worker', fromByte: 4096,
  });
});

test('WebSocket tickets are single-use and expire at their boundary', () => {
  const tickets = new TicketStore();
  const identity = { botId: 123, sessionId, generation: 0, userId: ownerId, displayName: 'Ada', authDate: seconds };
  const ticket = tickets.issue(identity, now);
  assert.deepEqual(tickets.consume(ticket, now + 59_999), identity);
  assert.equal(tickets.consume(ticket, now + 59_999), undefined);
  const expired = tickets.issue(identity, now);
  assert.equal(tickets.consume(expired, now + 60_000), undefined);
});
