import { randomBytes } from 'node:crypto';
import type { Context } from 'telegraf';
import type { TopicSession } from '../shared/contracts.js';
import type { Store, PendingSkillKey } from './store.js';
import { isMentionableSkillName } from './skill-commands.js';

export interface SkillCatalogEntry { name: string; description: string }
interface Picker {
  key: PendingSkillKey;
  instancePath: string;
  skills: SkillCatalogEntry[];
  expires: number;
}
interface Options {
  store: Store;
  botId: () => number;
  username: () => string;
  authorize: (chatId: number, userId: number) => Promise<void>;
  instancePath: (chatId: number) => string;
  listSkills: (instancePath: string, session?: TopicSession) => Promise<SkillCatalogEntry[]>;
}
export class SkillPicker {
  private readonly pickers = new Map<string, Picker>();
  constructor(private readonly options: Options) {}
  key(ctx: Context): PendingSkillKey {
    const message = ctx.message ?? (ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined);
    return { botId: this.options.botId(), chatId: ctx.chat!.id,
      threadId: message && 'message_thread_id' in message ? message.message_thread_id ?? 1 : 1, userId: ctx.from!.id };
  }
  private prune(): void {
    for (const [token, picker] of this.pickers) if (picker.expires <= Date.now()) this.pickers.delete(token);
  }
  async open(ctx: Context, session?: TopicSession, clear = false): Promise<void> {
    const key = this.key(ctx);
    await this.options.authorize(key.chatId, key.userId);
    if (clear) {
      this.options.store.clearPendingSkills(key);
      await ctx.reply('Pending skills cleared.', {message_thread_id:key.threadId});
      return;
    }
    const instancePath = this.options.instancePath(key.chatId);
    const catalog = await this.options.listSkills(instancePath, session);
    const skills = catalog.filter(skill => isMentionableSkillName(skill.name));
    const unsupported = catalog.length - skills.length;
    if (this.options.instancePath(key.chatId) !== instancePath) throw new Error('The group instance assignment changed');
    this.prune();
    if (this.pickers.size >= 1024) throw new Error('Too many active skill pickers. Try again after a picker expires.');
    const token = randomBytes(12).toString('hex');
    this.pickers.set(token, { key, instancePath, skills, expires: Date.now() + 600000 });
    const pending = this.options.store.getPendingSkills(key);
    await ctx.reply(`${pending.length ? `Your next message will mention ${pending.map(name => `/skill:${name}`).join(', ')}.` : 'No skills selected.'}\nChoose skills for your next prompt. In General, send /p or /new followed by your task.${unsupported ? `\n${unsupported} skill name(s) cannot be represented as /skill:name because they contain whitespace or control/path characters.` : ''}`, {
      message_thread_id: key.threadId,
      reply_markup: { inline_keyboard: [
        [{ text: 'Search skills', switch_inline_query_current_chat: `skills ${token} ` }],
        ...skills.slice(0, 20).map((skill, index) => [{ text: `/skill:${skill.name}`, callback_data: `skills:add:${token}:${index}` }]),
        [{ text: 'Clear skills', callback_data: `skills:clear:${token}` }],
      ] },
    });
  }
  async choose(ctx: Context, name: string, session?: TopicSession): Promise<void> {
    const key = this.key(ctx);
    await this.options.authorize(key.chatId, key.userId);
    const instancePath = this.options.instancePath(key.chatId);
    const skills = (await this.options.listSkills(instancePath, session)).filter(skill => isMentionableSkillName(skill.name));
    const index = skills.findIndex(skill => skill.name === name);
    if (index === -1) throw new Error(`Skill is no longer available: /skill:${name}`);
    this.prune();
    if (this.pickers.size >= 1024) throw new Error('Too many active skill pickers. Try again after a picker expires.');
    const token = randomBytes(12).toString('hex');
    this.pickers.set(token, { key, instancePath, skills, expires: Date.now() + 600000 });
    await this.select(ctx, token, index, session);
  }
  async inline(ctx: Context): Promise<void> {
    if (!ctx.inlineQuery || !ctx.from || ctx.from.is_bot) return;
    this.prune();
    const match = ctx.inlineQuery.query.match(/^skills ([a-f0-9]{24})(?:\s+([\s\S]*))?$/);
    const picker = match ? this.pickers.get(match[1]!) : undefined;
    if (!picker || picker.key.userId !== ctx.from.id) {
      await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
      return;
    }
    await this.options.authorize(picker.key.chatId, ctx.from.id);
    if (this.options.instancePath(picker.key.chatId) !== picker.instancePath) throw new Error('The group instance assignment changed');
    const query = (match![2] ?? '').trim().toLowerCase();
    await ctx.answerInlineQuery(picker.skills.flatMap((skill, index) => {
      if (!`${skill.name} ${skill.description}`.toLowerCase().includes(query)) return [];
      const text = `/skill:${skill.name}`;
      return [{ type: 'article' as const, id: `${match![1]}:${index}`, title: text,
        description: skill.description.slice(0, 256), input_message_content: {
          message_text: text, entities: [{ type: 'text_link' as const, offset: 0, length: text.length,
            url: `https://t.me/${this.options.username()}?start=skill_${match![1]}_${index}` }],
        } }];
    }).slice(0, 50), { cache_time: 0, is_personal: true });
  }
  async callback(ctx: Context, data: string, session?: TopicSession): Promise<boolean> {
    const match = data.match(/^skills:(add|clear):([a-f0-9]{24})(?::(\d+))?$/);
    if (!match) return false;
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!message || !('from' in message) || message.from?.id !== this.options.botId()) return true;
    await this.select(ctx, match[2]!, match[1] === 'clear' ? undefined : Number(match[3]), session);
    return true;
  }
  async message(ctx: Context, text: string, session?: TopicSession): Promise<boolean> {
    if (!/^\/skill:[^\s]+$/.test(text)) return false;
    const message = ctx.message;
    if (!message || !('via_bot' in message) || message.via_bot?.id !== this.options.botId()) {
      await ctx.reply('Use /skills to select a skill for your next prompt.');
      return true;
    }
    const entity = 'entities' in message ? message.entities?.find(entity => entity.type === 'text_link' && entity.offset === 0 && entity.length === text.length) : undefined;
    const match = entity && 'url' in entity ? entity.url.match(/\?start=skill_([a-f0-9]{24})_(\d+)$/) : undefined;
    if (!match) { await ctx.reply('This skill selection is invalid. Open /skills again.'); return true; }
    const picker = this.pickers.get(match[1]!);
    if (picker?.skills[Number(match[2])]?.name !== text.slice(7)) { await ctx.reply('This skill selection expired. Open /skills again.'); return true; }
    await this.select(ctx, match[1]!, Number(match[2]), session);
    return true;
  }
  private async select(ctx: Context, token: string, index: number | undefined, session?: TopicSession): Promise<void> {
    this.prune();
    const picker = this.pickers.get(token);
    const key = this.key(ctx);
    if (!picker || picker.key.userId !== key.userId || picker.key.chatId !== key.chatId || picker.key.threadId !== key.threadId) {
      await ctx.reply('This skill picker belongs to another user or topic, or expired. Open /skills here.');
      return;
    }
    await this.options.authorize(key.chatId, key.userId);
    if (this.options.instancePath(key.chatId) !== picker.instancePath) throw new Error('The group instance assignment changed');
    if (session && session.status !== 'open') { await ctx.reply('Reopen this topic before selecting skills.'); return; }
    if (index === undefined) this.options.store.clearPendingSkills(key);
    else {
      const skill = picker.skills[index];
      if (!skill) throw new Error('Unknown skill selection');
      const available = await this.options.listSkills(picker.instancePath, session);
      if (!available.some(entry => entry.name === skill.name)) throw new Error(`Skill is no longer available: /skill:${skill.name}`);
      if (this.options.instancePath(key.chatId) !== picker.instancePath) throw new Error('The group instance assignment changed');
      this.options.store.addPendingSkill(key, skill.name);
    }
    const skills = this.options.store.getPendingSkills(key);
    await ctx.reply(skills.length ? `Your next message will mention ${skills.map(name => `/skill:${name}`).join(', ')}.` : 'Pending skills cleared.', {
      message_thread_id: key.threadId,
      reply_markup: { inline_keyboard: [[{ text: 'Add another skill', switch_inline_query_current_chat: `skills ${token} ` }],
        [{ text: 'Clear skills', callback_data: `skills:clear:${token}` }]] },
    });
  }
}
