import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomInt } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTelegramTestBotTokens } from '../scripts/lib/telegram-test-bots.js';
import { acquireTelegramTestLock } from '../scripts/lib/telegram-test-lock.js';

const moduleUrl = new URL('../scripts/lib/telegram-test-bots.ts', import.meta.url).href;
const lockUrl = new URL('../scripts/lib/telegram-test-lock.ts', import.meta.url).href;
const token = (id: number, secret = 'a') => `${id}:${secret.repeat(35)}`;
const signal = () => new AbortController().signal;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'telegram-bot-pool-'));
  const tokens = [token(randomInt(100000000, 900000000)), token(randomInt(1000000000, 1900000000))];
  const envFile = join(root, '.env');
  await writeFile(envFile, `TELEGRAM_TEST_BOT_TOKENS='${JSON.stringify(tokens)}'\n`, { mode: 0o600 });
  const checkout = join(root, 'checkout');
  await mkdir(checkout);
  return { root, tokens, envFile, checkout };
}

function worker(envFile: string, checkout: string, body: string) {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { acquireTelegramTestBot } from ${JSON.stringify(moduleUrl)};
    import { acquireTelegramTestLock } from ${JSON.stringify(lockUrl)};
    const controller = new AbortController();
    const reason = new Error('original cancellation');
    process.on('message', message => { if (message === 'abort') controller.abort(reason); });
    const pending = acquireTelegramTestBot(controller.signal, { checkoutPath: ${JSON.stringify(checkout)} });
    process.send('waiting');
    ${body}
  `], { env: { ...process.env, TELEGRAM_TEST_ENV_FILE: envFile, TELEGRAM_TEST_BOT_TOKENS: JSON.stringify([token(1)]) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
}

async function probe(tokens: string[]) {
  for (const value of tokens) {
    const release = await acquireTelegramTestLock(`bot:${value.split(':')[0]}`, signal(), true);
    assert(release, 'all bot leases must be released');
    await release();
  }
}

test('bot token array validation rejects malformed values and duplicate bot identities without disclosing secrets', () => {
  const good = token(123);
  assert.deepEqual(readTelegramTestBotTokens({ TELEGRAM_TEST_BOT_TOKENS: JSON.stringify([good, token(456)]) }), [good, token(456)]);
  for (const value of [undefined, '', 'not-json', '{}', '[]', 'null', JSON.stringify([null]), JSON.stringify(['']), JSON.stringify([` ${good}`]), JSON.stringify([good, good]), JSON.stringify([good, token(123, 'b')]), JSON.stringify(['0:' + 'a'.repeat(35)])]) {
    assert.throws(() => readTelegramTestBotTokens({ TELEGRAM_TEST_BOT_TOKENS: value }), error => error instanceof Error && !error.message.includes(good));
  }
});

test('cross-process allocator waits for any bot, keeps it exclusive, and joins losing waiters', { timeout: 15000 }, async () => {
  const f = await fixture();
  const held = await Promise.all(f.tokens.map(value => acquireTelegramTestLock(`bot:${value.split(':')[0]}`, signal())));
  const child = worker(f.envFile, f.checkout, `
    const lease = await pending;
    assert.equal(lease.token, ${JSON.stringify(f.tokens[1])});
    process.send('acquired');
    const released = Promise.withResolvers();
    process.on('message', message => { if (message === 'release') released.resolve(); });
    await released.promise;
    const first = lease.release();
    assert.equal(lease.release(), first);
    await first;
    process.disconnect();
  `);
  const exited = once(child, 'exit');
  try {
    assert.equal((await once(child, 'message'))[0], 'waiting');
    const acquired = once(child, 'message');
    await held[1]!();
    assert.equal((await acquired)[0], 'acquired');
    assert.equal(await acquireTelegramTestLock(`bot:${f.tokens[1].split(':')[0]}`, signal(), true), undefined);
    await held[0]!();
    const loser = await acquireTelegramTestLock(`bot:${f.tokens[0].split(':')[0]}`, signal(), true);
    assert(loser, 'losing waiter must have settled before returning the winning lease');
    await loser();
    child.send('release');
    assert.equal((await exited)[0], 0);
    await probe(f.tokens);
  } finally {
    child.kill('SIGKILL');
    await Promise.all(held.map(release => release!()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test('cancellation preserves reason, joins descriptors, and releases checkout ownership', { timeout: 15000 }, async () => {
  const f = await fixture();
  const held = await Promise.all(f.tokens.map(value => acquireTelegramTestLock(`bot:${value.split(':')[0]}`, signal())));
  const child = worker(f.envFile, f.checkout, `
    await assert.rejects(pending, error => error === reason);
    const release = await acquireTelegramTestLock('bot-checkout:' + ${JSON.stringify(f.checkout)}, new AbortController().signal, true);
    assert(release);
    await release();
    const probe = Promise.withResolvers();
    process.on('message', message => { if (message === 'probe') probe.resolve(); });
    process.send('cancelled');
    await probe.promise;
    for (const token of ${JSON.stringify(f.tokens)}) {
      const release = await acquireTelegramTestLock('bot:' + token.split(':')[0], new AbortController().signal, true);
      assert(release);
      await release();
    }
    process.disconnect();
  `);
  const exited = once(child, 'exit');
  try {
    await once(child, 'message');
    const cancelled = once(child, 'message');
    child.send('abort');
    assert.equal((await cancelled)[0], 'cancelled');
    await Promise.all(held.map(release => release!()));
    child.send('probe');
    assert.equal((await exited)[0], 0);
    await probe(f.tokens);
  } finally {
    child.kill('SIGKILL');
    await Promise.all(held.map(release => release!()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test('checkout ownership serializes acquisition even when pool bots are free', { timeout: 15000 }, async () => {
  const f = await fixture();
  const releaseCheckout = await acquireTelegramTestLock(`bot-checkout:${f.checkout}`, signal());
  const child = worker(f.envFile, f.checkout, `
    await assert.rejects(pending, error => error === reason);
    process.disconnect();
  `);
  const exited = once(child, 'exit');
  try {
    await once(child, 'message');
    await probe(f.tokens);
    child.send('abort');
    assert.equal((await exited)[0], 0);
    assert.equal(await acquireTelegramTestLock(`bot-checkout:${f.checkout}`, signal(), true), undefined);
  } finally {
    child.kill('SIGKILL');
    await releaseCheckout!();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rotated credentials for one bot contend on the same cross-process identity lock', { timeout: 15000 }, async () => {
  const f = await fixture();
  await writeFile(f.envFile, `TELEGRAM_TEST_BOT_TOKENS='${JSON.stringify([f.tokens[0].replace(/a/g, 'b')])}'\n`);
  const release = await acquireTelegramTestLock(`bot:${f.tokens[0].split(':')[0]}`, signal());
  const child = worker(f.envFile, f.checkout, `
    const lease = await pending;
    const released = Promise.withResolvers();
    process.on('message', message => { if (message === 'release') released.resolve(); });
    process.send('acquired');
    await released.promise;
    await lease.release();
    process.disconnect();
  `);
  const exited = once(child, 'exit');
  try {
    await once(child, 'message');
    const acquired = once(child, 'message');
    await release!();
    assert.equal((await acquired)[0], 'acquired');
    assert.equal(await acquireTelegramTestLock(`bot:${f.tokens[0].split(':')[0]}`, signal(), true), undefined);
    child.send('release');
    assert.equal((await exited)[0], 0);
  } finally {
    child.kill('SIGKILL');
    await release!();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('one active bot per checkout while another checkout can hold a different bot', { timeout: 15000 }, async () => {
  const f = await fixture();
  const otherCheckout = join(f.root, 'other-checkout');
  await mkdir(otherCheckout);
  const hold = `
    const lease = await pending;
    const released = Promise.withResolvers();
    process.on('message', message => { if (message === 'release') released.resolve(); });
    process.send({ token: lease.token });
    await released.promise;
    await lease.release();
    process.disconnect();
  `;
  const first = worker(f.envFile, f.checkout, hold);
  const firstExit = once(first, 'exit');
  let same: ReturnType<typeof worker> | undefined;
  let other: ReturnType<typeof worker> | undefined;
  try {
    await once(first, 'message');
    const [owned] = await once(first, 'message');
    assert.equal(await acquireTelegramTestLock(`bot-checkout:${f.checkout}`, signal(), true), undefined);
    const free = f.tokens.find(value => value !== owned.token)!;
    await probe([free]);
    same = worker(f.envFile, f.checkout, `
      await assert.rejects(pending, error => error === reason);
      process.disconnect();
    `);
    const sameExit = once(same, 'exit');
    await once(same, 'message');
    same.send('abort');
    assert.equal((await sameExit)[0], 0);
    other = worker(f.envFile, otherCheckout, hold);
    const otherExit = once(other, 'exit');
    await once(other, 'message');
    const [otherOwned] = await once(other, 'message');
    assert.equal(otherOwned.token, free);
    other.send('release');
    assert.equal((await otherExit)[0], 0);
    first.send('release');
    assert.equal((await firstExit)[0], 0);
  } finally {
    first.kill('SIGKILL');
    same?.kill('SIGKILL');
    other?.kill('SIGKILL');
    await rm(f.root, { recursive: true, force: true });
  }
});
