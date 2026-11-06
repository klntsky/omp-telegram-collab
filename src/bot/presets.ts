import type { Bot, Context } from 'grammy';
import type { AppConfig, TopicSession } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import { findInstance, writeConfig } from '../config.js';
import { contextDestination, replyTo, sendTo } from '../telegram-destination.js';
import { sameTopicDestination } from '../../shared/topic-destination.js';
import { withCancellation } from '../cancellation.js';
import type { PresetAction, PresetPanel } from './types.js';
import { groupCommands } from './commands.js';

export interface PresetDependencies {
  botId: number;
  api: Bot<Context>['api'];
  config: AppConfig;
  store: BotOptions['store'];
  runtime: BotOptions['runtime'];
  isStopped(): boolean;
  catalogSignal(): AbortSignal;
  runBackground(phase: string, operation: (signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void>;
  syncCommandMenus(): Promise<void>;
  requireSessionAssignment(session: TopicSession): void;
  assignedId(chatId: number): number;
  settingsAccess(ctx: Context, panel: {chatId: number; instanceId: number}, writable?: boolean): Promise<AppConfig>;
  authorize(chatId: number, userId: number): Promise<unknown>;
  currentAdmin(ctx: Context): Promise<boolean>;
}

export class BotPresets {
  private readonly presetPanels = new Map<string, PresetPanel>();
  private readonly presetCatalogs = new Map<number, string[]>();
  private presetRefresh?: Promise<void>;

  constructor(private readonly dependencies: PresetDependencies) {}

  resetCatalogRefresh(): void {
    this.presetRefresh = undefined;
  }

  presetSession(panel: PresetPanel): TopicSession {
    const session = this.dependencies.store.getTopic({botId: this.dependencies.botId, destination: panel.destination});
    if (!session || session.id !== panel.sessionId || session.status !== 'open' ||
        this.dependencies.store.getSessionGeneration(session.id) !== panel.generation)
      throw new Error('The session changed before the model preset command could run');
    this.dependencies.requireSessionAssignment(session);
    return session;
  }
  checkPresetPanel(panel: PresetPanel): void {
    if (panel.continuation) {
      if (!panel.continuation.active || panel.expires <= Date.now())
        throw new Error('This model preset selection is no longer active.');
      panel.continuation.check();
    }
    else this.presetSession(panel);
  }
  async renderPresetPanel(panel: PresetPanel): Promise<void> {
    this.checkPresetPanel(panel);
    const choices: PresetAction[] = [];
    const rows: Array<Array<{text: string; callback_data: string}>> = [];
    const revision = panel.revision + 1;
    const button = (text: string, action: PresetAction) => {
      rows.push([{text: text.slice(0, 100), callback_data: `preset:${panel.token}:${revision}:${choices.length}`}]);
      choices.push(action);
    };
    let text = 'Model presets are pre-defined groups of models and their effort levels that map to various agent roles';
    if (panel.selected !== undefined) {
      const preset = await this.dependencies.runtime.modelPresetDetails(panel.instanceId, panel.selected, panel.continuation?.cwd ?? this.dependencies.store.getSession(panel.sessionId)?.cwd);
      text = `${panel.selected}\n\n${Object.entries(preset.modelRoles).map(([role, selector]) => `${role}: ${selector}`).join('\n')}${preset.defaultThinkingLevel === undefined ? '' : `\nDefault effort: ${preset.defaultThinkingLevel}`}`;
      button('Use', {kind: 'use'});
      if (!panel.continuation) button('Make default', {kind: 'default'});
      button('Back', {kind: 'back'});
      if (panel.detailOffset >= text.length) panel.detailOffset = 0;
      let end = Math.min(panel.detailOffset + 4000, text.length);
      if (end < text.length && text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF) end--;
      if (panel.detailOffset > 0) button('First page', {kind: 'page', offset: 0});
      if (end < text.length) button('Next', {kind: 'page', offset: end});
      text = text.slice(panel.detailOffset, end);
    } else {
      const names = await this.dependencies.runtime.availableModelPresets(panel.instanceId, panel.continuation?.cwd ?? this.dependencies.store.getSession(panel.sessionId)?.cwd);
      if (panel.listOffset >= names.length) panel.listOffset = 0;
      for (const name of names.slice(panel.listOffset, panel.listOffset + 8))
        button(name, {kind: 'select', name});
      if (panel.listOffset > 0) button('Previous', {kind: 'page', offset: Math.max(0, panel.listOffset - 8)});
      if (panel.listOffset + 8 < names.length) button('Next', {kind: 'page', offset: panel.listOffset + 8});
    }
    if (panel.continuation) button('Cancel', {kind: 'cancel'});
    this.checkPresetPanel(panel);
    if (this.dependencies.assignedId(panel.chatId) !== panel.instanceId) throw new Error('The group instance assignment changed');
    const extra = {reply_markup: {inline_keyboard: rows}};
    if (panel.messageId === 0) {
      const message = await sendTo(this.dependencies.api, panel.destination, text, extra);
      panel.messageId = message.message_id;
    } else {
      await this.dependencies.api.editMessageText(panel.chatId, panel.messageId, text, extra);
    }
    if (panel.continuation) this.checkPresetPanel(panel);
    panel.choices = choices;
    panel.revision = revision;
    for (const [token, entry] of this.presetPanels) if (entry.expires <= Date.now()) this.presetPanels.delete(token);
    this.presetPanels.set(panel.token, panel);
  }
  async presetCallback(ctx: Context, data: string): Promise<void> {
    const match = /^preset:([A-Za-z0-9_-]{22}):(\d+):(\d+)$/.exec(data);
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!match || !message || ctx.chat?.type !== 'supergroup' || !('from' in message) ||
        message.from?.id !== this.dependencies.botId || 'forward_origin' in message || 'forward_date' in message) return;
    const panel = this.presetPanels.get(match[1]!);
    if (!panel || panel.expires <= Date.now()) {
      if (panel) this.presetPanels.delete(panel.token);
      await ctx.answerCallbackQuery({text: 'This model preset panel expired. Open /model_preset again.'});
      return;
    }
    if (ctx.chat.id !== panel.chatId || message.message_id !== panel.messageId ||
        !sameTopicDestination(contextDestination(ctx), panel.destination)) return;
    if (panel.continuation && ctx.from?.id !== panel.continuation.source.from?.id) {
      await ctx.answerCallbackQuery({text: 'Only the original requester can choose this preset.'});
      return;
    }
    await this.dependencies.settingsAccess(ctx, panel);
    this.checkPresetPanel(panel);
    if (panel.continuation && this.presetPanels.get(panel.token) !== panel) return;
    if (Number(match[2]) !== panel.revision) {
      await ctx.answerCallbackQuery({text: 'This selection is stale. Use the current buttons.'});
      return;
    }
    const action = panel.choices[Number(match[3])];
    if (!action) return;
    if (action.kind === 'cancel') {
      this.presetPanels.delete(panel.token);
      if (panel.continuation) panel.continuation.active = false;
      await ctx.editMessageText('Prompt cancelled.', {reply_markup: {inline_keyboard: []}});
      await ctx.answerCallbackQuery();
      return;
    }
    if (action.kind === 'select') {
      panel.selected = action.name;
      panel.detailOffset = 0;
    } else if (action.kind === 'back') delete panel.selected;
    else if (action.kind === 'page') {
      if (panel.selected === undefined) panel.listOffset = action.offset;
      else panel.detailOffset = action.offset;
    }
    else {
      const name = panel.selected;
      if (name === undefined) return;
      await this.dependencies.runtime.modelPresetDetails(panel.instanceId, name, panel.continuation?.cwd ?? this.dependencies.store.getSession(panel.sessionId)?.cwd);
      if (panel.continuation) {
        const pending = panel.continuation;
        await this.dependencies.authorize(panel.chatId, pending.source.from!.id);
        if (!(await this.dependencies.currentAdmin(pending.source))) throw new Error('Prompt preparations require a group administrator.');
        pending.check();
        if (panel.expires <= Date.now() || this.presetPanels.get(panel.token) !== panel) return;
        this.presetPanels.delete(panel.token);
        pending.active = false;
        await ctx.editMessageReplyMarkup({reply_markup: {inline_keyboard: []}});
        await ctx.answerCallbackQuery();
        pending.check();
        await pending.resume(name);
        return;
      }
      if (action.kind === 'default') {
        const config = await this.dependencies.settingsAccess(ctx, panel, true);
        this.presetSession(panel);
        const chat = findInstance(config, this.dependencies.botId, panel.chatId)!.instance.chats.find(chat => chat.botId === this.dependencies.botId && chat.chatId === panel.chatId)!;
        chat.default_model_preset = name;
        writeConfig(config);
        const live = this.dependencies.config.instances.find(instance => instance.id === panel.instanceId)!.chats.find(chat => chat.botId === this.dependencies.botId && chat.chatId === panel.chatId)!;
        live.default_model_preset = name;
      } else {
        const session = this.presetSession(panel);
        const release = this.dependencies.runtime.retain(session.id);
        try {
          await this.dependencies.runtime.ensure(session);
          await this.dependencies.settingsAccess(ctx, panel);
          this.presetSession(panel);
          await this.dependencies.runtime.modelPresets(session, name);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'OMP host is busy; wait for the current turn and queued messages to finish before switching model presets') throw error;
          await replyTo(ctx, panel.destination, "Can't change model preset while busy. /stop first");
        } finally {
          release();
        }
      }
    }
    await this.renderPresetPanel(panel);
    await ctx.answerCallbackQuery();
  }
  refreshPresetCatalogs(): Promise<void> {
    if (this.dependencies.isStopped() || this.dependencies.config.terminated) return Promise.resolve();
    if (this.presetRefresh) return this.presetRefresh;
    const signal = this.dependencies.catalogSignal();
    const tasks = this.dependencies.config.instances
      .filter(instance => instance.chats.some(chat => chat.botId === this.dependencies.botId))
      .map(instance => this.dependencies.runBackground(`presets:${instance.id}`, async () => {
        const instanceId = instance.id;
        const names = await withCancellation(this.dependencies.runtime.availableModelPresets(instanceId), signal);
        signal.throwIfAborted();
        if (!this.dependencies.config.instances.find(current => current.id === instanceId && current.defaultDir === instance.defaultDir)?.chats.some(chat => chat.botId === this.dependencies.botId)) return;
        this.presetCatalogs.set(instanceId, names);
        await this.dependencies.syncCommandMenus();
      }, signal));
    const task = Promise.all(tasks).then(() => {});
    this.presetRefresh = task;
    void task.finally(() => { if (this.presetRefresh === task) this.presetRefresh = undefined; });
    return task;
  }
  presetDescription(instanceId: number): string {
    let description = groupCommands.find(command => command.command === 'model_preset')!.description;
    const names = [...(this.presetCatalogs.get(instanceId) ?? [])].sort((a, b) => a.length - b.length || a.localeCompare(b));
    let separator = '. Presets: ';
    for (const name of names) {
      if (description.length + separator.length + name.length > 256) break;
      description += separator + name;
      separator = ', ';
    }
    return description;
  }
  async replyPresetUsage(ctx: Context, instanceId: number, guidance = ''): Promise<void> {
    const names = await this.dependencies.runtime.availableModelPresets(instanceId);
    await this.replyPresetText(ctx, `Usage: /model_preset to list presets, or /model_preset <name> to switch an idle session.\nAvailable presets:\n${names.length ? names.join('\n') : '(none configured)'}${guidance}`);
  }
  async replyPresetText(ctx: Context, text: string): Promise<void> {
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset+4000,text.length);
      if (end < text.length && text.charCodeAt(end-1) >= 0xD800 && text.charCodeAt(end-1) <= 0xDBFF) end--;
      await replyTo(ctx, contextDestination(ctx), text.slice(offset,end));
      offset = end;
    }
  }
}
