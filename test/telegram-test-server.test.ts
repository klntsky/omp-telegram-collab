import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BaseTelegramClient, TelegramClient, MemoryStorage, PeersIndex, Long, User, tl } from '@mtcute/node';
import { TelegramTokenPool } from '../scripts/lib/telegram-test-pool.js';
import { TelegramSessionService } from '../scripts/lib/telegram-test-service.js';
import { connectTelegramTestSession, type TelegramTestSession } from '../scripts/lib/telegram-test-client.js';
import { createCentralTelegramTestClient } from '../scripts/lib/telegram-test-central-client.js';
import { teardownTelegramTestResources } from './e2e/helpers/telegram-fixture.js';
import { createCentralTestBot } from '../scripts/lib/telegram-test-botfather.js';

class ControlledTelegram extends BaseTelegramClient {
  readonly operations = new Map<string, (signal?: AbortSignal) => Promise<unknown>>();
  constructor() { super({ apiId: 1, apiHash: 'controlled', storage: new MemoryStorage(), testMode: true }); }
  override async connect(): Promise<void> { await this.prepare(); }
  override async call<T extends tl.RpcMethod>(request: T, options?: Parameters<BaseTelegramClient['call']>[1]): Promise<tl.RpcCallReturn[T['_']]> {
    const key = request._ === 'help.getAppConfig' ? String(request.hash) : request._;
    const operation = this.operations.get(key);
    if (!operation) throw new Error(`Unexpected controlled Telegram operation ${key}`);
    const signal = options?.abortSignal ? AbortSignal.any([options.abortSignal, this.stopSignal]) : this.stopSignal;
    return await operation(signal) as tl.RpcCallReturn[T['_']];
  }
}
async function fixture(t: { after(fn: () => Promise<void>): void }, create: () => Promise<string> = async () => 'created-token') {
  const directory = await mkdtemp(join(tmpdir(), 'omp-session-'));
  const socket = join(directory, 'session.sock');
  const database = join(directory, 'bots.sqlite');
  const backend = new ControlledTelegram();
  const pool = new TelegramTokenPool(database);
  const service = new TelegramSessionService({ client: backend, onLastDisconnected: 'nothing' }, pool, create);
  await service.listen(socket);
  const clients: TelegramTestSession[] = [];
  const client = async () => { const value = await connectTelegramTestSession(socket); clients.push(value); return value; };
  t.after(async () => { for (const value of clients) await value.close(); await service.close(socket); await backend.destroy(); await rm(directory, { recursive: true, force: true }); });
  return { pool, backend, service, client, socket, database };
}

test('public highlevel getMe reconstructs a real User over IPC without exposing auth', async t => {
  const f = await fixture(t);
  const raw: tl.RawUser = { _: 'user', id: 901, self: true, firstName: 'Central account', accessHash: Long.fromString('9223372036854775806') };
  await f.backend.prepare();
  await f.backend.storage.self.storeFrom(raw);
  let requests = 0;
  f.backend.operations.set('users.getUsers', async () => { requests++; return [raw]; });
  const session = await f.client();
  const user = await session.client.getMe();
  assert(user instanceof User);
  assert.equal(user.id, raw.id);
  assert.deepEqual(user.raw, raw);
  assert(Long.isLong(user.raw.accessHash));
  assert.equal(requests, 1);
  await session.close();
  assert.equal(f.backend.stopSignal.aborted, false);
});

test('owner shutdown aborts an unresolved BotFather creation without waiting for its conversation timeout', { timeout: 2000 }, async t => {
  const stopping = new AbortController();
  let owner: TelegramClient | undefined;
  const f = await fixture(t, () => {
    if (!owner) throw new Error('Missing controlled owner');
    return createCentralTestBot(owner, stopping.signal);
  });
  owner = new TelegramClient({ client: f.backend, skipConversationUpdates: false });
  const entered = Promise.withResolvers<void>();
  f.backend.operations.set('contacts.resolveUsername', signal => { entered.resolve(); return delay(60000, undefined, { signal }); });
  const session = await f.client();
  const acquiring = assert.rejects(session.acquire());
  await entered.promise;
  stopping.abort(new Error('Owner stopping'));
  await f.backend.destroy();
  await acquiring;
  assert.equal(f.pool.db.prepare('SELECT count(*) AS n FROM bots').get()?.n, 0);
});

test('IPC allocation is exclusive, token-only, owner-enforced and reuses released bots', async t => {
  let created = 0;
  const f = await fixture(t, async () => `token-${++created}`);
  assert.equal((await stat(f.socket)).mode & 0o777, 0o600);
  assert.equal((await stat(f.database)).mode & 0o777, 0o600);
  const a = await f.client(); const b = await f.client();
  const [one, two] = await Promise.all([a.acquire(), b.acquire()]);
  assert.equal(typeof one, 'string'); assert.notEqual(one, two);
  await assert.rejects(b.release(one), /not owned/);
  await a.release(one);
  assert.equal(await b.acquire(), one);
  assert.equal(created, 2);
});

test('whole creation is serialized and BotFather failure does not mask or create a free token', async t => {
  let concurrent = 0; let maximum = 0; let sequence = 0;
  const f = await fixture(t, async () => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    try { await delay(15); if (++sequence === 1) throw new Error('BotFather says:\nToo many bots'); return `bot-${sequence}`; }
    finally { concurrent--; }
  });
  const a = await f.client(); const b = await f.client();
  const failed = assert.rejects(a.acquire(), { message: 'BotFather says:\nToo many bots' });
  const token = b.acquire(); await failed;
  assert.equal(await token, 'bot-2'); assert.equal(maximum, 1);
  assert.equal(f.pool.db.prepare('SELECT count(*) AS n FROM bots').get()?.n, 1);
});

test('late creation after client disconnect is durably quarantined, never returned free', async t => {
  const creating = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<void>();
  const f = await fixture(t, () => { entered.resolve(); return creating.promise; });
  const a = await f.client();
  const pending = a.acquire();
  const rejected = assert.rejects(pending);
  await entered.promise;
  await a.close();
  creating.resolve('late-token');
  await rejected;
  for (let i = 0; i < 50 && !f.pool.db.prepare('SELECT state FROM bots WHERE token=?').get('late-token'); i++) await delay(2);
  assert.equal(f.pool.db.prepare('SELECT state FROM bots WHERE token=?').get('late-token')?.state, 'quarantined');
  assert.throws(() => new TelegramTokenPool(f.database), /locked/);
});

test('disconnect and restart quarantine tokens until explicit offline recovery', async t => {
  const f = await fixture(t);
  const a = await f.client(); const token = await a.acquire();
  await a.close();
  for (let i = 0; i < 50 && f.pool.db.prepare('SELECT state FROM bots WHERE token=?').get(token)?.state !== 'quarantined'; i++) await delay(2);
  assert.equal(f.pool.db.prepare('SELECT state FROM bots WHERE token=?').get(token)?.state, 'quarantined');
  f.pool.recover(token);
  const b = await f.client(); assert.equal(await b.acquire(), token);
  const restartPath = `${f.database}.restart`;
  const crashed = new TelegramTokenPool(restartPath);
  await crashed.acquire('old-connection', async () => token, () => true);
  await crashed.close();
  const recovered = new TelegramTokenPool(restartPath);
  assert.equal(recovered.db.prepare('SELECT state FROM bots WHERE token=?').get(token)?.state, 'quarantined');
  recovered.recover(token);
  assert.equal(recovered.db.prepare('SELECT state FROM bots WHERE token=?').get(token)?.state, 'free');
  await recovered.close();
});

test('unsettled bot polling quarantines its token even after forum teardown completes', async t => {
  const f = await fixture(t);
  const session = await f.client();
  const token = await session.acquire();
  let deleted = 0;
  f.backend.operations.set('channels.deleteChannel', async () => {
    deleted++;
    return { _: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0 };
  });
  const polling = Promise.withResolvers<void>();
  let settled = false;
  void polling.promise.then(() => { settled = true; });
  await teardownTelegramTestResources({
    user: { close: session.close, releaseBot: session.release },
    token,
    canReleaseBot: () => settled,
    forumSetup: Promise.resolve({
      close: async () => { await session.client.call({ _: 'channels.deleteChannel', channel: { _: 'inputChannelEmpty' } }); },
    }),
  });
  assert.equal(deleted, 1);
  assert.equal(f.pool.db.prepare('SELECT state FROM bots WHERE token=?').get(token)?.state, 'quarantined');
  polling.resolve();
  await polling.promise;
  assert.equal(f.pool.db.prepare('SELECT state FROM bots WHERE token=?').get(token)?.state, 'quarantined');
});

test('central SDK network boundary forwards consecutive flood and internal errors without caching or retry', { timeout: 2000 }, async () => {
  let attempts = 0;
  const flood = { _: 'mt_rpc_error', errorCode: 420, errorMessage: 'FLOOD_WAIT_17' };
  const internal = { _: 'mt_rpc_error', errorCode: 500, errorMessage: 'INTERNAL' };
  const client = createCentralTelegramTestClient({ apiId: 1, apiHash: 'controlled' }, async () => {
    attempts++;
    if (attempts === 1) return flood;
    if (attempts === 3) return internal;
    return { _: 'help.appConfigNotModified' };
  });
  try {
    const request = { _: 'help.getAppConfig', hash: 0 } as const;
    const options = { maxRetryCount: 0, floodSleepThreshold: 0 };
    assert.deepEqual(await client.mt.network.call(request, options), flood);
    assert.deepEqual(await client.mt.network.call(request, options), { _: 'help.appConfigNotModified' });
    assert.equal(attempts, 2);
    assert.deepEqual(await client.mt.network.call(request, options), internal);
    assert.equal(attempts, 3);
    assert.deepEqual(await client.mt.network.call(request, options), { _: 'help.appConfigNotModified' });
    assert.equal(attempts, 4);
  } finally { await client.destroy(); }
});

test('the original coded IPC failure reaches the pending RPC, not a generic worker-closed error', async t => {
  const f = await fixture(t);
  const session = await f.client();
  const entered = Promise.withResolvers<void>();
  f.backend.operations.set('5', signal => { entered.resolve(); return delay(60000, undefined, { signal }); });
  let original: Error | undefined;
  session.client.onError.add(error => { original = error; });
  const pending = session.client.call({ _: 'help.getAppConfig', hash: 5 }, { abortSignal: new AbortController().signal });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error, original);
    assert.equal((error as NodeJS.ErrnoException).code, 'ERR_TELEGRAM_TEST_FRAME_TOO_LARGE');
    assert.equal((error as Error).message, 'IPC frame too large');
    return true;
  });
  await entered.promise;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(64 * 1024 * 1024 + 1);
  for (const socket of f.service.sockets) socket.write(header);
  await rejected;
});

test('pending RPCs correlate out of order, cancellation is isolated, errors and binary values survive', async t => {
  const f = await fixture(t); const a = await f.client(); const b = await f.client();
  const first = Promise.withResolvers<unknown>(); const second = Promise.withResolvers<unknown>();
  let cancelled = false;
  f.backend.operations.set('1', signal => { signal?.addEventListener('abort', () => { cancelled = true; first.reject(new Error('operation cancelled')); }, { once: true }); return first.promise; });
  f.backend.operations.set('2', () => second.promise);
  const later = Promise.withResolvers<unknown>();
  f.backend.operations.set('4', () => later.promise);
  const controller = new AbortController();
  const pending = a.client.call({ _: 'help.getAppConfig', hash: 1 }, { abortSignal: controller.signal });
  const rejection = assert.rejects(pending);
  const independent = b.client.call({ _: 'help.getAppConfig', hash: 2 });
  const reordered = b.client.call({ _: 'help.getAppConfig', hash: 4 });
  later.resolve({ _: 'help.appConfigNotModified' });
  assert.deepEqual(await reordered, { _: 'help.appConfigNotModified' });
  const payload = { _: 'testPayload', id: 9223372036854775807n, bytes: Buffer.from([0, 128, 255]) };
  second.resolve(payload);
  assert.deepEqual(await independent, payload);
  controller.abort(); await rejection;
  for (let i = 0; i < 50 && !cancelled; i++) await delay(2);
  assert.equal(cancelled, true);
  const error = tl.RpcError.fromTl({ _: 'mt_rpc_error', errorCode: 420, errorMessage: 'FLOOD_WAIT_17' }); error.message = 'original\nTelegram message';
  f.backend.operations.set('3', async () => { throw error; });
  await assert.rejects(b.client.call({ _: 'help.getAppConfig', hash: 3 }), received => {
    assert(tl.RpcError.is(received, 'FLOOD_WAIT_%d'));
    assert.equal(received.code, error.code); assert.equal(received.text, error.text);
    assert.equal(received.seconds, 17); assert.equal(received.message, 'original\nTelegram message'); return true;
  });
  assert.equal(f.backend.stopSignal.aborted, false);
});

test('updates broadcast without id rewriting and disconnect removes only that subscriber', async t => {
  const f = await fixture(t); const a = await f.client(); const b = await f.client();
  const left: tl.TypeUpdates[] = []; const right: tl.TypeUpdates[] = [];
  a.client.onServerUpdate.add(update => left.push(update)); b.client.onServerUpdate.add(update => right.push(update));
  const rawLeft: unknown[] = []; const rawRight: unknown[] = [];
  const snapshot = ({ update, peers }: Parameters<Parameters<typeof a.client.onRawUpdate.add>[0]>[0]) => ({ update, users: [...peers.users], chats: [...peers.chats], hasMin: peers.hasMin });
  a.client.onRawUpdate.add(value => rawLeft.push(snapshot(value)));
  b.client.onRawUpdate.add(value => rawRight.push(snapshot(value)));
  const user: tl.RawUser = { _: 'user', id: 902, firstName: 'Peer', min: true };
  const chat: tl.RawChatForbidden = { _: 'chatForbidden', id: 903, title: 'Peer chat' };
  const peers = PeersIndex.from({ users: [user], chats: [chat] });
  const raw: tl.TypeUpdate = { _: 'updateDeleteMessages', messages: [71], pts: 8, ptsCount: 1 };
  f.backend.onRawUpdate.emit({ update: raw, peers });
  for (let i = 0; i < 50 && (!rawLeft.length || !rawRight.length); i++) await delay(2);
  assert.deepEqual(rawLeft, [{ update: raw, users: [[902, user]], chats: [[903, chat]], hasMin: true }]);
  assert.deepEqual(rawRight, rawLeft);
  const update: tl.TypeUpdates = { _: 'updateShort', update: { _: 'updateDeleteMessages', messages: [71, 72], pts: 8, ptsCount: 2 }, date: 10 };
  f.backend.onServerUpdate.emit(update);
  for (let i = 0; i < 50 && (!left.length || !right.length); i++) await delay(2);
  assert.deepEqual(left, [update]); assert.deepEqual(right, [update]);
  await a.close();
  f.backend.onServerUpdate.emit({ ...update, date: 11 });
  for (let i = 0; i < 50 && right.length < 2; i++) await delay(2);
  assert.equal(left.length, 1); assert.equal(right.length, 2);
  assert.equal(right[1]?.date, 11);
});
