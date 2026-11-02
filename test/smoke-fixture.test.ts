import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const fixtureUrl = new URL('../scripts/telegram-smoke.ts', import.meta.url).href;
const dataUrl = new URL('./telegram-data.ts', import.meta.url).href;
const prelude = `
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { createSmokeApp } from ${JSON.stringify(fixtureUrl)};
import { botId, chatId } from ${JSON.stringify(dataUrl)};
`;

async function runFixtureScenario(source: string) {
  await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', prelude + source], {
    timeout: 15000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
}

test('fixture keeps working when every port released during startup is immediately occupied', async () => {
  await runFixtureScenario(`
const originalClose = Server.prototype.close;
const competitors = [];
let initializing = true;
Server.prototype.close = function (callback) {
  const address = this.address();
  return originalClose.call(this, error => {
    if (error || !initializing || !address || typeof address === 'string') {
      callback?.(error);
      return;
    }
    const competitor = createServer();
    competitors.push(competitor);
    competitor.once('error', error => callback?.(error));
    competitor.listen(address.port, '127.0.0.1', () => callback?.());
  });
};
const occupied = createServer();
occupied.listen(0, '127.0.0.1');
await once(occupied, 'listening');
try {
  const app = await createSmokeApp();
  initializing = false;
  try {
    const response = await fetch(app.url + '/healthz');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {ok:true});
    await app.update({text:'/setup'});
    assert.equal(app.store.isEnrolled(botId, chatId), true);
  } finally {
    await app.close();
  }
  await assert.rejects(access(app.config.dataDir), {code:'ENOENT'});
} finally {
  initializing = false;
  Server.prototype.close = originalClose;
  for (const server of [...competitors, occupied]) {
    server.closeAllConnections();
    const closed = once(server, 'close');
    originalClose.call(server);
    await closed;
  }
}
`);
});

test('failed gateway startup preserves the original error and releases earlier fixture listeners', async () => {
  await runFixtureScenario(`
const originalListen = Server.prototype.listen;
const addresses = [];
const failure = Object.assign(new Error('Forced gateway bind failure'), {code:'EADDRINUSE'});
Server.prototype.listen = function (...args) {
  if (this.listenerCount('upgrade') > 0) {
    queueMicrotask(() => this.emit('error', failure));
    return this;
  }
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address !== 'string') addresses.push(address);
  });
  return Reflect.apply(originalListen, this, args);
};
try {
  await assert.rejects(createSmokeApp(), error => error === failure);
} finally {
  Server.prototype.listen = originalListen;
}
for (const address of addresses) {
  const probe = createServer();
  probe.listen(address.port, address.address);
  await once(probe, 'listening');
  const closed = once(probe, 'close');
  probe.close();
  await closed;
}
`);
});
