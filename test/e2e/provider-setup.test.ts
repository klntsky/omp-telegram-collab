import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { readConfig, writeConfig } from '../../src/config.js';
import { OmpProviderSetupError } from '../../src/runtime/provider-setup-error.js';
import { setupCollaborationTest } from './helpers/collaboration-fixture.js';
import { enrollForum } from './helpers/telegram-actions.js';

test('missing OMP providers notify the enrolled forum once across catalog refreshes', { timeout: 240000 }, async t => {
  const app = await setupCollaborationTest(t, { scenarios: [] });
  await enrollForum(app);
  await app.pause();
  const modelsPath = join(dirname(app.omp.agentConfigPath), 'models.yml');
  await rm(modelsPath);
  await writeFile(app.omp.agentConfigPath, JSON.stringify({ startup: { checkUpdate: false, setupWizard: false } }), { mode: 0o600 });
  const config = readConfig(app.config.configPath);
  config.omp.args = config.omp.args.filter((arg, index, args) =>
    !['--model', '--smol', '--slow'].includes(arg) && !['--model', '--smol', '--slow'].includes(args[index - 1] ?? ''));
  writeConfig(config);
  const start = app.apiCalls.length;
  await app.restart();
  await app.service.refreshSkillCatalogs();
  await assert.rejects(app.runtime.listSkills(1), OmpProviderSetupError);
  const notices = () => app.apiCalls.slice(start).filter(call => call.method === 'sendMessage');
  assert.equal(notices().length, 1);
  const notice = notices()[0]!;
  const payload = notice.payload as { chat_id: number };
  const response = notice.result as { ok: boolean; result: { message_id: number } };
  assert.equal(payload.chat_id, app.telegram.forum.chatId);
  assert.equal(response.ok, true);
  const [delivered] = await app.telegram.user.client.getMessages(app.telegram.forum.chatId, response.result.message_id);
  assert.equal(delivered?.id, response.result.message_id);
  t.diagnostic(`Delivered provider notice: ${delivered?.text}`);
  await app.service.refreshSkillCatalogs();
  assert.equal(notices().length, 1);
  assert.deepEqual(app.store.listSessions(), []);
});
