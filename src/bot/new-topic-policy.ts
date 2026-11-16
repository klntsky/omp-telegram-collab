import { randomBytes } from 'node:crypto';
import { accessSync, constants, opendirSync, realpathSync } from 'node:fs';
import type { Context } from 'grammy';
import { findInstance, readConfig, refreshTermination } from '../config.js';
import { contextDestination, replyTo } from '../telegram-destination.js';
import type { InputLifecycleDependencies } from './input-lifecycle.js';
import type { MessageContext } from './input-router.js';

type Choice = { token: string; chat_id: number; thread_id: number; message_id: number; creator_id: number; title: string; instance_id: number; fingerprint: string; state: 'pending' | 'kept' | 'connected'; closed: number };

/** Owns manual-topic admission only; explicit session commands never consult this state. */
export class ManualTopicPolicy {
  constructor(private readonly deps: InputLifecycleDependencies) {}

  async created(ctx: MessageContext): Promise<void> {
    const d = this.deps;
    const destination = contextDestination(ctx);
    if (destination.kind !== 'topic') return;
    const assigned = findInstance(readConfig(d.config.configPath), d.id, ctx.chat.id);
    const policy = assigned?.instance.chats.find(chat => chat.botId === d.id && chat.chatId === ctx.chat.id)?.new_topic_policy ?? 'agent';
    if (policy === 'chat-only') return;
    if (policy === 'agent') {
      await this.connect(ctx, undefined, ctx.from!.id, ctx.message.forum_topic_created!.name);
      return;
    }
    if (d.store.db.prepare('SELECT 1 FROM manual_topic_choices WHERE bot_id=? AND chat_id=? AND thread_id=?').get(d.id, destination.chatId, destination.threadId)) return;
    const token = randomBytes(16).toString('base64url');
    const message = await replyTo(ctx, destination, 'This topic is not yet connected to an AI agent session.', {
      reply_markup: { inline_keyboard: [
        [{ text: 'Connect a new agent', callback_data: `topic-policy:${token}:connect` }],
        [{ text: 'Keep this topic chat-only', callback_data: `topic-policy:${token}:keep` }],
      ] },
    });
    d.store.db.prepare('INSERT INTO manual_topic_choices (bot_id,token,chat_id,thread_id,message_id,creator_id,title,instance_id,fingerprint,state) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      d.id, token, destination.chatId, destination.threadId, message.message_id, ctx.from!.id,
      ctx.message.forum_topic_created!.name, d.assignedId(ctx.chat.id), JSON.stringify(d.folderSettings(ctx.chat.id)), 'pending');
  }

  async callback(ctx: Context, data: string): Promise<void> {
    await this.choose(ctx, data);
    await ctx.answerCallbackQuery();
  }

  private async choose(ctx: Context, data: string): Promise<void> {
    const d = this.deps;
    const match = /^topic-policy:([A-Za-z0-9_-]{22}):(connect|keep)$/.exec(data);
    const message = ctx.callbackQuery?.message;
    if (!match || !message || !('from' in message) || message.from?.id !== d.id ||
        'forward_origin' in message || 'forward_date' in message || !ctx.chat || !ctx.from || ctx.from.is_bot) return;
    const destination = contextDestination(ctx);
    const row = d.store.db.prepare('SELECT * FROM manual_topic_choices WHERE bot_id=? AND token=?').get(d.id, match[1]!) as Choice | undefined;
    if (!row || destination.kind !== 'topic' || row.chat_id !== destination.chatId || row.thread_id !== destination.threadId ||
        row.message_id !== message.message_id || row.state !== 'pending' || row.closed || d.store.getTopic({ botId: d.id, destination }) ||
        d.store.getTopicKind({ botId: d.id, chatId: row.chat_id, threadId: row.thread_id }) === 'detached') return;
    if (!d.store.isEnrolled(d.id, row.chat_id) || d.stopped || refreshTermination(d.config)) return;
    await d.authorize(row.chat_id, ctx.from.id);
    if (!(await d.currentAdmin(ctx))) return;
    if (d.assignedId(row.chat_id) !== row.instance_id || JSON.stringify(d.folderSettings(row.chat_id)) !== row.fingerprint) return;
    // Keep pending during folder selection: cancellation/restart permits choosing again.
    // Session registration is synchronous and rechecks the binding, preventing duplicates.
    if (match[2] === 'connect') {
      await this.connect(ctx, ctx, row.creator_id, row.title, () =>
        Boolean(d.store.db.prepare("SELECT 1 FROM manual_topic_choices WHERE bot_id=? AND token=? AND state='pending' AND closed=0").get(d.id, row.token)));
    } else {
      d.store.db.prepare("UPDATE manual_topic_choices SET state='kept' WHERE bot_id=? AND token=? AND state='pending'").run(d.id, row.token);
    }
  }
  private async connect(source: Context, authority: Context | undefined, creatorId: number, title: string, active?: () => boolean): Promise<void> {
    const d = this.deps;
    const destination = contextDestination(source);
    if (destination.kind !== 'topic') return;
    const defaultSkills = d.defaultNewTopicSkills(destination.chatId);
    const fingerprint = JSON.stringify(d.folderSettings(destination.chatId));
    const epoch = d.admissionEpoch;
    await d.chooseFolder(source, authority, async (cwd, currentAuthority) => {
      await d.authorize(destination.chatId, creatorId);
      if (currentAuthority.callbackQuery) {
        await d.authorize(destination.chatId, currentAuthority.from!.id);
        if (!(await d.currentAdmin(currentAuthority))) throw new Error('Administrator access changed before manual session registration.');
      }
      if (epoch !== d.admissionEpoch || d.stopped || refreshTermination(d.config) ||
          fingerprint !== JSON.stringify(d.folderSettings(destination.chatId)))
        throw new Error('Folder settings or service state changed before manual session registration.');
      if (active?.() === false) return;
      opendirSync(cwd).closeSync();
      accessSync(cwd, constants.R_OK | constants.X_OK);
      if (realpathSync(cwd) !== cwd) throw new Error('Managed working directory identity changed');
      if (d.store.getTopic({ botId: d.id, destination }) || d.store.getTopicKind({ botId: d.id, chatId: destination.chatId, threadId: destination.threadId }) === 'detached') return;
      const created = d.store.createSession({ botId: d.id, chatId: destination.chatId, threadId: destination.threadId,
        instanceId: d.assignedId(destination.chatId), cwd }, title, { kind: 'managed' });
      d.store.db.prepare("UPDATE manual_topic_choices SET state='connected' WHERE bot_id=? AND chat_id=? AND thread_id=?").run(d.id, destination.chatId, destination.threadId);
      if (defaultSkills.length) d.store.setNewTopicSkills(created.id, defaultSkills);
      if (d.createsTopicWorktrees(destination.chatId)) {
        await d.authorize(destination.chatId, currentAuthority.from!.id);
        if (!(await d.currentAdmin(currentAuthority))) throw new Error('Administrator access changed before worktree creation.');
        await d.createTopicWorktree(created);
      }
      await d.announce(created);
      await d.refreshTopicStatus(created);
    }, active);
  }
}
