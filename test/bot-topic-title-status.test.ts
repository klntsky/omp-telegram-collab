import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSmokeApp } from '../scripts/telegram-smoke.js';
import { eventually } from './bot-test-helpers.js';
import { botId } from './telegram-data.js';

const state = {cwd:'/fixture/project',isStreaming:false,queuedMessageCount:0,participants:[]};
test('a superseded successful Telegram edit reconciles an unchanged-name response', async () => {
  const app = await createSmokeApp();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await app.update({text:'/setup'});
    await app.update({message_thread_id:42,forum_topic_created:{name:'Readable title'}});
    const session = app.store.listSessions(botId)[0]!;
    await app.service.ensureMirroring(session,await app.runtime.ensure(session));
    await eventually(() => app.store.getPendingSessionTitle(session.id) === undefined);
    let attempts = 0;
    app.bot.api.config.use(async (previous,method,payload,signal) => {
      if (method === 'editForumTopic' && 'name' in payload && payload.name === 'feature/race Readable title') {
        attempts++;
        if (attempts > 1) return {ok:false,error_code:400,description:'Bad Request: TOPIC_NOT_MODIFIED'};
        const result = await previous(method,payload,signal);
        entered.resolve();
        await release.promise;
        return result;
      }
      return previous(method,payload,signal);
    });
    app.topicTitleStatuses.set(session.id,{worktree:false,branch:'feature/race'});
    app.emit({t:'state',state});
    await entered.promise;
    app.emit({t:'state',state});
    release.resolve();
    await eventually(() => attempts === 2);
    assert.equal(attempts,2);
  } finally { release.resolve(); await app.close(); }
});
