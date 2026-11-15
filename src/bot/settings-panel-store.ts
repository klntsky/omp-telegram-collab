import { BotSettingsRejectedError } from './errors.js';
import { AuthorizationDeniedError } from './types.js';
import type { Context, Bot } from 'grammy';
import type { AppConfig } from '../../shared/contracts.js';
import type { BotOptions } from '../bot.js';
import type { SettingsPanel, SettingsKey } from './types.js';
import { configWritable, readConfig, findInstance } from '../config.js';
import { isAdministrator } from '../auth.js';
import { sameTopicDestination } from '../../shared/topic-destination.js';
import { contextDestination } from '../telegram-destination.js';

export interface SettingsAccessDependencies {
  id: () => number;
  api: Bot<Context>['api'];
  config: BotOptions['config'];
  store: BotOptions['store'];
  configWritable?: BotOptions['configWritable'];
  authorize: (chatId: number, userId: number) => Promise<void>;
  assignedId: (chatId: number) => number;
}

export class SettingsPanelStore {
  constructor(private readonly deps: SettingsAccessDependencies) {}
  save(panel: SettingsPanel): void {
    this.deps.store.db.prepare('INSERT INTO settings_panels VALUES (?,?,?) ON CONFLICT(bot_id,token) DO UPDATE SET panel=excluded.panel')
      .run(this.deps.id(), panel.token, JSON.stringify({...panel, changes: [...panel.changes]}));
  }
  async access(ctx: Context, panel: Pick<SettingsPanel, 'chatId' | 'instanceId'>, writable = false): Promise<AppConfig> {
    await this.deps.authorize(panel.chatId, ctx.from!.id);
    if (writable && !(this.deps.configWritable?.() ?? configWritable(this.deps.config.configPath))) {
      throw new BotSettingsRejectedError(`Save settings (chat=${panel.chatId}, instance=${panel.instanceId}): Configuration is read-only. Ask the local operator to change its source or permissions. No settings were saved.`);
    }
    const member = await this.deps.api.getChatMember(panel.chatId, ctx.from!.id);
    const persisted = readConfig(this.deps.config.configPath);
    if (this.deps.assignedId(panel.chatId) !== panel.instanceId ||
        findInstance(persisted, this.deps.id(), panel.chatId)?.instance.id !== panel.instanceId ||
        !isAdministrator(member)) {
      throw new AuthorizationDeniedError(`Access settings (chat=${panel.chatId}, instance=${panel.instanceId}, user=${ctx.from!.id}): The configured instance assignment or administrator access changed. No settings were saved.`);
    }
    return persisted;
  }
  replyPanel(ctx: Context): SettingsPanel | undefined {
    const message = ctx.message;
    const reply = message?.reply_to_message;
    if (!message || !ctx.chat || !ctx.from || ctx.from.is_bot || !reply || reply.from?.id !== this.deps.id() ||
        'forward_origin' in reply || 'forward_date' in reply ||
        'forward_origin' in message || 'forward_date' in message) return;
    const stored = this.deps.store.db.prepare(
      `SELECT panel FROM settings_panels WHERE bot_id=? AND json_extract(panel,'$.chatId')=?
       AND (json_extract(panel,'$.messageId')=? OR EXISTS (
         SELECT 1 FROM json_each(settings_panels.panel,'$.retiredMessageIds') WHERE value=?
       ))`,
    ).get(this.deps.id(), ctx.chat.id, reply.message_id, reply.message_id);
    if (!stored) return;
    const decoded = JSON.parse(String(stored.panel)) as Omit<SettingsPanel, 'changes'> & {
      changes: [SettingsKey, { label: string; before: string; after: string }][];
    };
    if (!sameTopicDestination(contextDestination(ctx), decoded.destination)) return;
    if (reply.message_id !== decoded.messageId) {
      // Retired prompts still consume settings replies, but only the current
      // prompt may mutate configuration, including while another input is active.
      decoded.capacityInput = false;
      decoded.folderInput = undefined;
      decoded.folderInputEnded = true;
    }
    if (!decoded.capacityInput && !decoded.folderInput &&
        (!decoded.folderInputEnded || message.text?.startsWith('/'))) return;
    return { ...decoded, changes: new Map(decoded.changes) };
  }
  load(token: string): SettingsPanel | undefined {
    const stored = this.deps.store.db.prepare('SELECT panel FROM settings_panels WHERE bot_id=? AND token=?').get(this.deps.id(), token);
    if (!stored) return;
    const decoded = JSON.parse(String(stored.panel)) as Omit<SettingsPanel, 'changes'> & { changes: [SettingsKey, {label: string; before: string; after: string}][] };
    return {...decoded, changes: new Map(decoded.changes)};
  }
}
