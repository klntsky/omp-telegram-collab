import type { Bot, Context } from 'grammy';
import type { AppConfig } from '../../shared/contracts.js';
import type { Store } from '../store.js';
import type { SkillCatalogEntry } from '../skill-picker.js';
import { skillCommandAliases } from '../skill-commands.js';
import type { AbortSignal as TelegramAbortSignal } from 'abort-controller';
import { groupCommands, cliCommand } from './commands.js';

interface CommandMenuDependencies {
 bot: Bot<Context>; config: AppConfig; store: Store; signal: TelegramAbortSignal;
 botId(): number; stopped(): boolean; presetDescription(instanceId: number): string;
}

export class BotCommandMenus {
 private readonly commandMenus = new Map<number, string>();
 private globalCommandMenu?: string;
 readonly skillAliases = new Map<number, Map<string, SkillCatalogEntry>>();
 private menuTail: Promise<void> = Promise.resolve();
 constructor(private readonly deps: CommandMenuDependencies) {}
 completion(): Promise<void> { return this.menuTail; }

syncCommandMenus(): Promise<void> {
    const operation = this.menuTail.then(() => this.publishCommandMenus());
    this.menuTail = operation.catch(() => {});
    return operation;
  }

  private async publishCommandMenus(): Promise<void> {
    const baseCommands = this.deps.config.publicUrl ? groupCommands : groupCommands.filter(command => command.command !== 'agent');
    const globalFingerprint = JSON.stringify(baseCommands);
    if (this.globalCommandMenu !== globalFingerprint) {
      await this.deps.bot.api.setMyCommands(baseCommands, {scope:{type:'all_group_chats'}}, this.deps.signal);
      this.globalCommandMenu = globalFingerprint;
    }
    const current = new Set<number>();
    for (const instance of this.deps.config.instances) {
      const instanceId = instance.id;
      const chats = instance.chats.filter(chat => chat.botId === this.deps.botId());
      if (!chats.length) continue;
      for (const chat of chats) current.add(chat.chatId);
      const skills = this.deps.store.getSkillCatalog(instanceId) ?? [];
      if (this.deps.stopped()) return;
      const aliases = new Map([...skillCommandAliases(skills)].slice(0, 100 - baseCommands.length));
      const instanceCommands = baseCommands.map(command => command.command === 'modelpreset' ? {...command, description:this.deps.presetDescription(instanceId)} : command);
      const commands = [...instanceCommands, ...[...aliases].map(([command, skill]) => ({
        command, description: `Select /skill:${skill.name}`.slice(0, 256),
      }))];
      const fingerprint = JSON.stringify([instanceId, commands]);
      for (const chat of chats) {
        if (!this.deps.config.instances.find(current => current.id === instanceId)?.chats.some(assigned => assigned.botId === this.deps.botId() && assigned.chatId === chat.chatId)) continue;
        current.add(chat.chatId);
        if (this.commandMenus.get(chat.chatId) === fingerprint) {
          this.skillAliases.set(chat.chatId, aliases);
          continue;
        }
        await this.deps.bot.api.setMyCommands(commands, {scope:{type:'chat',chat_id:chat.chatId}}, this.deps.signal);
        await this.deps.bot.api.setMyCommands([...instanceCommands,cliCommand,...commands.slice(instanceCommands.length)].slice(0,100), {scope:{type:'chat_administrators',chat_id:chat.chatId}}, this.deps.signal);
        if (this.deps.stopped() || !this.deps.config.instances.find(current => current.id === instanceId)?.chats.some(assigned => assigned.botId === this.deps.botId() && assigned.chatId === chat.chatId)) continue;
        this.commandMenus.set(chat.chatId, fingerprint);
        this.skillAliases.set(chat.chatId, aliases);
      }
    }
    for (const chatId of this.commandMenus.keys()) {
      if (current.has(chatId)) continue;
      await this.deps.bot.api.deleteMyCommands({scope:{type:'chat',chat_id:chatId}}, this.deps.signal);
      await this.deps.bot.api.deleteMyCommands({scope:{type:'chat_administrators',chat_id:chatId}}, this.deps.signal);
      this.commandMenus.delete(chatId);
      this.skillAliases.delete(chatId);
    }
  }
}
