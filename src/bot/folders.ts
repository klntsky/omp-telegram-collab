import { logEvent } from '../logging.js';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdirSync, opendirSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Context } from 'grammy';
import type { AppConfig } from '../../shared/contracts.js';
import { findInstance, readConfig, refreshTermination } from '../config.js';
import { sameTopicDestination } from '../../shared/topic-destination.js';
import { contextDestination, replyTo } from '../telegram-destination.js';

export interface FolderSelectionDependencies {
  botId(): number;
  config: AppConfig;
  assignedId(chatId: number): number;
  authorize(chatId: number, userId: number): Promise<void>;
  currentAdmin(ctx: Context): Promise<boolean>;
  admissionEpoch(): number;
  stopped(): boolean;
}

export class FolderSelection {
  constructor(private readonly dependencies: FolderSelectionDependencies) {}

  private readonly folderRequests = new Map<string, {
    state: {kind:'choose';offset:number} | {kind:'create';path:string} | {kind:'failed';path:string;create:boolean};
    source: Context; authority?: Context; messageId: number; expires: number;
    epoch: number; instanceId: number; defaultDir: string; fingerprint: string; options: string[];
    resume: (cwd: string, authority: Context) => Promise<void>;
    active?: () => boolean;
  }>();
  folderSettings(chatId: number) {
    const assigned = findInstance(readConfig(this.dependencies.config.configPath), this.dependencies.botId(), chatId);
    if (!assigned || assigned.instance.id !== this.dependencies.assignedId(chatId)) throw new Error('The group instance assignment changed');
    const chat = assigned.instance.chats.find(chat => chat.botId === this.dependencies.botId() && chat.chatId === chatId)!;
    return {instanceId:assigned.instance.id, defaultDir:assigned.instance.defaultDir, options:chat.folder_options?.length ? chat.folder_options : ['.']};
  }
  private folderKeyboard(token: string, options: string[], offset: number) {
    const rows = options.slice(offset,offset+8).map((path,index) => [{text:path === '.' ? '<Default>' : path.slice(0,100),callback_data:`folder:${token}:${offset+index}`}]);
    if (offset > 0) rows.push([{text:'Previous folders',callback_data:`folder:${token}:page${Math.max(0,offset-8)}`}]);
    if (offset+8 < options.length) rows.push([{text:'Next folders',callback_data:`folder:${token}:page${offset+8}`}]);
    rows.push([{text:'Cancel',callback_data:`folder:${token}:cancel`}]);
    return rows;
  }
  async chooseFolder(source: Context, authority: Context | undefined, resume: (cwd: string, authority: Context) => Promise<void>, active?: () => boolean): Promise<boolean> {
    const epoch = this.dependencies.admissionEpoch();
    const settings = this.folderSettings(source.chat!.id);
    const token = randomBytes(16).toString('base64url');
    let initial: {kind:'choose';offset:number} | {kind:'create';path:string} | {kind:'failed';path:string;create:boolean} = {kind:'choose',offset:0};
    let failure = '';
    if (settings.options.length === 1) {
      const path = resolve(settings.defaultDir,settings.options[0]!);
      let cwd: string | undefined;
      try {
        cwd = this.resolveFolder(path,false);
        initial = {kind:'create',path};
        failure = `Create folder ${path}?`;
      } catch (error) {
        logEvent('error', 'runtime-folder-selection-failed', {botId: this.dependencies.botId(), chatId: source.chat?.id, message: 'Runtime folder selection failed.', error});
        initial = {kind:'failed',path,create:false};
        failure = `${error instanceof Error ? error.message : String(error)}\nThe task is still pending.`;
      }
      if (cwd !== undefined) {
        if (active?.() === false || epoch !== this.dependencies.admissionEpoch() || this.dependencies.stopped() || refreshTermination(this.dependencies.config) ||
            JSON.stringify(this.folderSettings(source.chat!.id)) !== JSON.stringify(settings))
          throw new Error('Folder settings or service state changed. Send the command again.');
        await resume(cwd,authority ?? source);
        return true;
      }
    }
    const rows = initial.kind === 'choose' ? this.folderKeyboard(token,settings.options,0) :
      [[{text:initial.kind === 'create' ? 'Create folder' : 'Retry',callback_data:`folder:${token}:${initial.kind === 'create' ? 'create' : 'retry'}`},
        {text:'Cancel',callback_data:`folder:${token}:cancel`}]];
    const message = await replyTo(source, contextDestination(source), failure ||
      (authority ? 'Choose the runtime folder for this session.' : 'An administrator can approve this task by choosing its runtime folder.'), {reply_markup:{inline_keyboard:rows}});
    if (this.dependencies.stopped() || refreshTermination(this.dependencies.config) || epoch !== this.dependencies.admissionEpoch() ||
        JSON.stringify(this.folderSettings(source.chat!.id)) !== JSON.stringify(settings))
      throw new Error('Folder settings or service state changed. Send the command again.');
    const request = {...settings,state:initial,source,authority,messageId:message.message_id,
      expires:Date.now()+300000,epoch,fingerprint:JSON.stringify(settings),resume,active};
    this.folderRequests.set(token,request);
    setTimeout(() => {
      let pending = false;
      for (const [activeToken,active] of this.folderRequests) {
        if (active === request) { this.folderRequests.delete(activeToken); pending = true; }
      }
      if (!pending) return;
      void source.api.editMessageText(source.chat!.id,message.message_id,'This folder request expired. Send the original task again.',{reply_markup:{inline_keyboard:[]}})
        .catch(error => logEvent('error', 'could-not-retire-expired-folder-controls', {botId: this.dependencies.botId(), chatId: source.chat?.id, message: 'Could not retire expired folder controls.', error}));
    },300000).unref();
    return true;
  }
  async folderCallback(ctx: Context, data: string): Promise<void> {
    const match = /^folder:([A-Za-z0-9_-]{22}):([A-Za-z0-9]+)$/.exec(data);
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!match || !ctx.from || ctx.from.is_bot) return;
    if (!message || !ctx.chat || !('from' in message) || message.from?.id !== this.dependencies.botId() ||
        'forward_origin' in message || 'forward_date' in message) {
      await ctx.answerCallbackQuery('This folder request cannot be recovered. Send the original task again.');
      return;
    }
    let token = match[1]!;
    const action = match[2]!;
    const request = this.folderRequests.get(token);
    if (!request) {
      await this.dependencies.authorize(ctx.chat.id,ctx.from.id);
      if (!(await this.dependencies.currentAdmin(ctx))) {
        await ctx.answerCallbackQuery('This request is no longer active. Ask an administrator to send the task again.');
        return;
      }
      if ([...this.folderRequests.values()].some(active => active.source.chat!.id === ctx.chat!.id && active.messageId === message.message_id)) {
        await ctx.answerCallbackQuery('This selection is outdated. Use the current folder buttons.');
        return;
      }
      await ctx.answerCallbackQuery('This request expired or was discarded when the bot restarted. Send the task again.');
      const rows = 'reply_markup' in message ? message.reply_markup?.inline_keyboard : undefined;
      if (rows?.length && rows.flat().every(button => 'callback_data' in button && button.callback_data.startsWith(`folder:${token}:`)))
        await ctx.editMessageReplyMarkup({reply_markup:{inline_keyboard:[]}});
      return;
    }
    if (ctx.chat.id !== request.source.chat!.id || message.message_id !== request.messageId ||
        !sameTopicDestination(contextDestination(ctx),contextDestination(request.source)) ||
        (request.authority && ctx.from.id !== request.authority.from!.id)) return;
    await this.dependencies.authorize(ctx.chat.id,ctx.from.id);
    await this.dependencies.authorize(ctx.chat.id,request.source.from!.id);
    if (!(await this.dependencies.currentAdmin(ctx))) {
      await ctx.answerCallbackQuery('Ask a current group administrator to choose or add a folder for this pending task.');
      return;
    }
    if (request.active?.() === false || request.expires <= Date.now() || request.epoch !== this.dependencies.admissionEpoch() || this.dependencies.stopped() ||
        refreshTermination(this.dependencies.config) || JSON.stringify(this.folderSettings(ctx.chat.id)) !== request.fingerprint) {
      this.folderRequests.delete(token);
      await ctx.answerCallbackQuery('This request expired or its settings changed. Send the task again.');
      await ctx.editMessageText('This folder request is no longer active. Send the original task again.',{reply_markup:{inline_keyboard:[]}});
      return;
    }
    const state = request.state;
    if (action !== 'cancel' && !(
      (state.kind === 'choose' && (action.startsWith('page') ||
        (/^\d+$/.test(action) && Number(action) >= state.offset && Number(action) < state.offset+8 && request.options[Number(action)] !== undefined))) ||
      (state.kind === 'create' && (action === 'create' || (action === 'other' && request.options.length > 1))) ||
      (state.kind === 'failed' && (action === 'retry' || (action === 'other' && request.options.length > 1))))) {
      await ctx.answerCallbackQuery('This selection is outdated. Use the current folder buttons.');
      return;
    }
    this.folderRequests.delete(token);
    await ctx.answerCallbackQuery();
    if (action === 'cancel') {
      await ctx.editMessageText('Folder selection cancelled.',{reply_markup:{inline_keyboard:[]}});
      return;
    }
    token = randomBytes(16).toString('base64url');
    const restore = async (text: string, rows: {text:string;callback_data:string}[][]) => {
      await ctx.editMessageText(text,{reply_markup:{inline_keyboard:rows}});
      if (request.expires <= Date.now()) {
        await ctx.editMessageText('This folder request expired. Send the original task again.',{reply_markup:{inline_keyboard:[]}});
        return;
      }
      this.folderRequests.set(token,request);
    };
    if (action === 'other' || action.startsWith('page')) {
      const offset = action === 'other' ? 0 : Number(action.slice(4));
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= request.options.length || offset % 8 !== 0) return;
      request.state = {kind:'choose',offset};
      await restore('Choose the runtime folder for this session.',this.folderKeyboard(token,request.options,offset));
      return;
    }
    request.authority = ctx;
    const path = state.kind === 'create' || state.kind === 'failed' ? state.path :
      resolve(request.defaultDir,request.options[Number(action)]!);
    const create = state.kind === 'create' || (state.kind === 'failed' && state.create);
    let cwd: string;
    try {
      const resolved = this.resolveFolder(path,create);
      if (resolved === undefined) {
        request.state = {kind:'create',path};
        await restore(`Create folder ${path}?`,[[
          {text:'Create folder',callback_data:`folder:${token}:create`},
          ...(request.options.length > 1 ? [{text:'Choose another folder',callback_data:`folder:${token}:other`}] : []),
          {text:'Cancel',callback_data:`folder:${token}:cancel`}]]);
        return;
      }
      cwd = resolved;
    } catch (error) {
      logEvent('error', 'runtime-folder-selection-failed', {botId: this.dependencies.botId(), chatId: ctx.chat.id, message: 'Runtime folder selection failed.', error});
      request.state = {kind:'failed',path,create};
      await restore(`${error instanceof Error ? error.message : String(error)}\nThe task is still pending.`,[[
        {text:'Retry',callback_data:`folder:${token}:retry`},
        ...(request.options.length > 1 ? [{text:'Choose another folder',callback_data:`folder:${token}:other`}] : []),
        {text:'Cancel',callback_data:`folder:${token}:cancel`}]]);
      return;
    }
    await ctx.editMessageText(`Runtime folder: ${cwd}`,{reply_markup:{inline_keyboard:[]}});
    if (request.epoch !== this.dependencies.admissionEpoch() || this.dependencies.stopped() || refreshTermination(this.dependencies.config) ||
        JSON.stringify(this.folderSettings(ctx.chat.id)) !== request.fingerprint)
      throw new Error('This folder request is stale. Send the command again.');
    await request.resume(cwd,ctx);
  }
  private resolveFolder(path: string, create: boolean): string | undefined {
    if (create) mkdirSync(path,{recursive:true});
    else {
      try { statSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        let ancestor = dirname(path);
        while (true) {
          try { statSync(ancestor); break; } catch (ancestorError) {
            if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw ancestorError;
            ancestor = dirname(ancestor);
          }
        }
        accessSync(ancestor,constants.W_OK | constants.X_OK);
        return undefined;
      }
    }
    opendirSync(path).closeSync();
    accessSync(path,constants.R_OK | constants.X_OK);
    return realpathSync(path);
  }
}
