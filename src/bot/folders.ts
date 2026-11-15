import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdirSync, opendirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { Context, type Bot } from 'grammy';
import type { DatabaseSync } from 'node:sqlite';
import { FolderRequests, type FolderRequest, type FolderContinuation } from './folder-requests.js';
import type { AppConfig } from '../../shared/contracts.js';
import { findInstance, readConfig, refreshTermination, writeConfig } from '../config.js';
import { sameTopicDestination } from '../../shared/topic-destination.js';
import { contextDestination, replyTo } from '../telegram-destination.js';

export interface FolderSelectionDependencies {
  botId(): number;
  config: AppConfig;
  assignedId(chatId: number): number;
  authorize(chatId: number, userId: number): Promise<void>;
  currentAdmin(ctx: Context): Promise<boolean>;
  db: DatabaseSync;
  albumContexts(ctx: Context): readonly Context[];
  bot: Bot<Context>;
  resume(payload: FolderContinuation, source: Context, cwd: string, authority: Context): Promise<void>;
  stopped(): boolean;
}

export class FolderSelection {
  private readonly folderRequests: FolderRequests;
  // Cancel in-flight work on termination without invalidating saved waits on restart.
  private generation = 0;
  private expiryTimer?: NodeJS.Timeout;
  private expiryTail: Promise<void> = Promise.resolve();
  private readonly expiryErrors: unknown[] = [];
  start(): void {
    if (this.expiryTimer) return;
    const sweep = () => {
      this.expiryTail = this.expiryTail.then(async () => {
        for (const [token,request] of this.folderRequests.waiting()) {
          if (request.expires > Date.now() || !this.folderRequests.claim(token)) continue;
          this.folderRequests.finish(token,'expired');
          if (!request.messageId) continue;
          try {
            await request.source.api.editMessageText(request.source.chat!.id,request.messageId,
              'This folder request expired. Send the original task again.',{reply_markup:{inline_keyboard:[]}});
          } catch (error) {
            this.folderRequests.finish(token,'expired',error);
            this.expiryErrors.push(error);
            console.error('Could not retire expired folder controls.',error);
          }
        }
      }).catch(error => { this.expiryErrors.push(error); console.error('Folder expiry failed.',error); });
    };
    sweep();
    this.expiryTimer = setInterval(sweep,1000);
    this.expiryTimer.unref();
  }
  invalidate(): void { this.generation++; this.folderRequests.invalidate(); }
  async close(): Promise<void> {
    clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
    await this.expiryTail;
    if (this.expiryErrors.length) throw new AggregateError(this.expiryErrors,this.expiryErrors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  }
  constructor(private readonly dependencies: FolderSelectionDependencies) {
    this.folderRequests = new FolderRequests(dependencies.db,dependencies.botId,update => new Context(update,dependencies.bot.api,dependencies.bot.botInfo));
  }
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
    rows.push([{text:'Add folder and use it',callback_data:`folder:${token}:add`}]);
    rows.push([{text:'Cancel',callback_data:`folder:${token}:cancel`}]);
    return rows;
  }
  async chooseFolder(source: Context, authority: Context | undefined, continuation: FolderContinuation): Promise<boolean> {
    const generation = this.generation;
    const settings = this.folderSettings(source.chat!.id);
    const token = randomBytes(16).toString('base64url');
    try {
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
        console.error('Runtime folder selection failed.',error);
        initial = {kind:'failed',path,create:false};
        failure = `${error instanceof Error ? error.message : String(error)}\nThe task is still pending.`;
      }
      if (cwd !== undefined) {
        if (generation !== this.generation || this.dependencies.stopped() || refreshTermination(this.dependencies.config) ||
            JSON.stringify(this.folderSettings(source.chat!.id)) !== JSON.stringify(settings))
          throw new Error('Folder settings or service state changed. Send the command again.');
        const request: FolderRequest = {...settings,state:{kind:'choose',offset:0},source,authority,messageId:0,
          expires:Date.now()+300000,fingerprint:JSON.stringify(settings),continuation,albums:this.dependencies.albumContexts(source).map(ctx => ctx.update)};
        this.folderRequests.set(token,request);
        this.folderRequests.claim(token);
        try {
          await this.dependencies.resume(continuation,source,cwd,authority ?? source);
          this.folderRequests.finish(token,'completed');
        } catch (error) {
          this.folderRequests.finish(token,'interrupted',error);
          throw error;
        }
        return true;
      }
    }
    const rows = initial.kind === 'choose' ? this.folderKeyboard(token,settings.options,0) :
      [[{text:initial.kind === 'create' ? 'Create folder' : 'Retry',callback_data:`folder:${token}:${initial.kind === 'create' ? 'create' : 'retry'}`},
        {text:'Cancel',callback_data:`folder:${token}:cancel`}]];
    const request: FolderRequest = {...settings,state:initial,source,authority,messageId:0,
      expires:Date.now()+300000,fingerprint:JSON.stringify(settings),continuation,albums:this.dependencies.albumContexts(source).map(ctx => ctx.update),diagnostic:failure || undefined};
    this.folderRequests.set(token,request);
    this.folderRequests.claim(token);
    const message = await replyTo(source, contextDestination(source), failure ||
      (authority ? 'Choose the runtime folder for this session.' : 'An administrator can approve this task by choosing its runtime folder.'), {reply_markup:{inline_keyboard:rows}});
    if (generation !== this.generation || this.dependencies.stopped() || refreshTermination(this.dependencies.config) ||
        JSON.stringify(this.folderSettings(source.chat!.id)) !== JSON.stringify(settings))
      throw new Error('Folder settings or service state changed. Send the command again.');
    request.messageId = message.message_id;
    this.folderRequests.set(token,request);
    return true;
    } catch (error) {
      this.folderRequests.finish(token,'interrupted',error);
      throw error;
    }
  }
  async folderReply(ctx: Context): Promise<boolean> {
    const generation = this.generation;
    const reply = ctx.message?.reply_to_message;
    if (!reply || !ctx.chat || !this.folderRequests.owns(ctx,reply.message_id)) return false;
    if ('forward_origin' in reply || 'forward_date' in reply || (ctx.message && ('forward_origin' in ctx.message || 'forward_date' in ctx.message))) return true;
    const found = this.folderRequests.find(ctx,reply.message_id);
    if (!found) return true;
    let [token,request] = found;
    try {
    if (!request || !ctx.chat || !ctx.from || ctx.from.is_bot || ctx.message?.sender_chat ||
        request.state.kind !== 'entry' || reply.message_id !== request.messageId ||
        ctx.chat.id !== request.source.chat!.id || ctx.from.id !== request.authority?.from?.id ||
        !sameTopicDestination(contextDestination(ctx),contextDestination(request.source))) return true;
    await this.dependencies.authorize(ctx.chat.id,ctx.from.id);
    await this.dependencies.authorize(ctx.chat.id,request.source.from!.id);
    if (!(await this.dependencies.currentAdmin(ctx))) throw new Error('Administrator access changed before adding a folder.');
    if (!this.folderRequests.claim(token)) return true;
    if (generation !== this.generation || request.expires <= Date.now() ||
        this.dependencies.stopped() || refreshTermination(this.dependencies.config) ||
        JSON.stringify(this.folderSettings(ctx.chat.id)) !== request.fingerprint) {
      this.folderRequests.finish(token,'retired');
      await replyTo(ctx,contextDestination(ctx),'This folder request is no longer active. Send the original task again.');
      return true;
    }
    const input = ctx.message && 'text' in ctx.message ? ctx.message.text?.trim() ?? '' : '';
    if (!input || /[\r\n\0]/.test(input) || isAbsolute(input)) {
      this.folderRequests.set(token,request);
      await replyTo(ctx,contextDestination(ctx),'Reply with one relative folder path.');
      return true;
    }
    const option = normalize(input).replace(/\/+$/, '') || '.';
    const config = readConfig(this.dependencies.config.configPath);
    const assigned = findInstance(config,this.dependencies.botId(),ctx.chat.id)!;
    const chat = assigned.instance.chats.find(chat => chat.botId === this.dependencies.botId() && chat.chatId === ctx.chat!.id)!;
    chat.folder_options = [...new Set([...request.options,option])];
    // No await between the fresh authorization/settings checks and this synchronous
    // append. Advance only this continuation's fingerprint, not other pending requests.
    writeConfig(config);
    const liveChat = findInstance(this.dependencies.config,this.dependencies.botId(),ctx.chat.id)!.instance.chats
      .find(chat => chat.botId === this.dependencies.botId() && chat.chatId === ctx.chat!.id)!;
    liveChat.folder_options = chat.folder_options;
    const settings = this.folderSettings(ctx.chat.id);
    request.options = settings.options;
    request.fingerprint = JSON.stringify(settings);
    this.folderRequests.finish(token,'retired');
    const nextToken = randomBytes(16).toString('base64url');
    this.folderRequests.set(nextToken,request);
    this.folderRequests.claim(nextToken);
    const restore = async (text: string, rows: {text:string;callback_data:string}[][]) => {
      this.assertActive(request,generation);
      this.folderRequests.set(nextToken,request);
      await ctx.api.editMessageText(ctx.chat!.id,request.messageId,text,{reply_markup:{inline_keyboard:rows}});
    };
    token = nextToken;
    await this.useFolder(ctx,request,nextToken,resolve(request.defaultDir,option),false,restore,generation);
    return true;
    } catch (error) {
      this.folderRequests.finish(token,'interrupted',error);
      throw error;
    }
  }
  async folderCallback(ctx: Context, data: string): Promise<void> {
    const generation = this.generation;
    const match = /^folder:([A-Za-z0-9_-]{22}):([A-Za-z0-9]+)$/.exec(data);
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!match || !ctx.from || ctx.from.is_bot) return;
    if (!message || !ctx.chat || !('from' in message) || message.from?.id !== this.dependencies.botId() ||
        'forward_origin' in message || 'forward_date' in message) {
      await ctx.answerCallbackQuery('This folder request cannot be recovered. Send the original task again.');
      return;
    }
    let token = match[1]!;
    try {
    const action = match[2]!;
    const request = this.folderRequests.get(token);
    if (!request) {
      await this.dependencies.authorize(ctx.chat.id,ctx.from.id);
      if (!(await this.dependencies.currentAdmin(ctx))) {
        await ctx.answerCallbackQuery('This request is no longer active. Ask an administrator to send the task again.');
        return;
      }
      if (this.folderRequests.find(ctx,message.message_id)) {
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
    if (!this.folderRequests.claim(token)) {
      await ctx.answerCallbackQuery('This selection is outdated. Use the current folder buttons.');
      return;
    }
    if (generation !== this.generation || request.expires <= Date.now() || this.dependencies.stopped() ||
        refreshTermination(this.dependencies.config) || JSON.stringify(this.folderSettings(ctx.chat.id)) !== request.fingerprint) {
      this.folderRequests.finish(token,'retired');
      await ctx.answerCallbackQuery('This request expired or its settings changed. Send the task again.');
      await ctx.editMessageText('This folder request is no longer active. Send the original task again.',{reply_markup:{inline_keyboard:[]}});
      return;
    }
    const state = request.state;
    if (action !== 'cancel' && !(
      (state.kind === 'choose' && (action === 'add' || action.startsWith('page') ||
        (/^\d+$/.test(action) && Number(action) >= state.offset && Number(action) < state.offset+8 && request.options[Number(action)] !== undefined))) ||
      (state.kind === 'entry' && action === 'other') ||
      (state.kind === 'create' && (action === 'create' || (action === 'other' && request.options.length > 1))) ||
      (state.kind === 'failed' && (action === 'retry' || (action === 'other' && request.options.length > 1))))) {
      this.folderRequests.set(token,request);
      await ctx.answerCallbackQuery('This selection is outdated. Use the current folder buttons.');
      return;
    }
    this.folderRequests.finish(token,'retired');
    await ctx.answerCallbackQuery();
    if (action === 'cancel') {
      await ctx.editMessageText('Folder selection cancelled.',{reply_markup:{inline_keyboard:[]}});
      return;
    }
    this.assertActive(request,generation);
    token = randomBytes(16).toString('base64url');
    this.folderRequests.set(token,request);
    this.folderRequests.claim(token);
    const restore = async (text: string, rows: {text:string;callback_data:string}[][]) => {
      this.assertActive(request,generation);
      this.folderRequests.set(token,request);
      await ctx.editMessageText(text,{reply_markup:{inline_keyboard:rows}});
      if (request.expires <= Date.now()) {
        await ctx.editMessageText('This folder request expired. Send the original task again.',{reply_markup:{inline_keyboard:[]}});
        return;
      }
      this.assertActive(request,generation);
      this.folderRequests.set(token,request);
    };
    if (action === 'add') {
      request.authority = ctx;
      request.state = {kind:'entry'};
      this.folderRequests.set(token,request);
      this.folderRequests.claim(token);
      await ctx.editMessageText('Continue with the folder entry below.',{reply_markup:{inline_keyboard:[]}});
      this.assertActive(request,generation);
      // A new prompt opens native reply entry while retaining cancellation controls.
      // Client::get_reply_markup accepts force_reply with inline_keyboard:
      // https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L11049-L11064
      const markup = {force_reply:true,inline_keyboard:[[
        {text:'Choose another folder',callback_data:`folder:${token}:other`},
        {text:'Cancel',callback_data:`folder:${token}:cancel`}]]};
      const prompt = await replyTo(ctx,contextDestination(request.source),
        'Reply with one relative folder path.',{reply_markup:markup});
      request.messageId = prompt.message_id;
      this.folderRequests.own(request);
      if (generation !== this.generation || request.expires <= Date.now() ||
          this.dependencies.stopped() ||
          refreshTermination(this.dependencies.config) || JSON.stringify(this.folderSettings(ctx.chat.id)) !== request.fingerprint) {
        await ctx.api.editMessageText(ctx.chat.id,request.messageId,
          'This folder request is no longer active. Send the original task again.',{reply_markup:{inline_keyboard:[]}});
        return;
      }
      this.folderRequests.own(request);
      this.folderRequests.set(token,request);
      return;
    }
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
    await this.useFolder(ctx,request,token,path,create,restore,generation);
    } catch (error) {
      this.folderRequests.finish(token,'interrupted',error);
      throw error;
    }
  }
  private async useFolder(ctx: Context, request: FolderRequest, token: string,
    path: string, create: boolean, restore: (text: string, rows: {text:string;callback_data:string}[][]) => Promise<void>, generation: number): Promise<void> {
    if (create) {
      await this.dependencies.authorize(ctx.chat!.id,ctx.from!.id);
      await this.dependencies.authorize(ctx.chat!.id,request.source.from!.id);
      if (!(await this.dependencies.currentAdmin(ctx))) throw new Error('Administrator access changed before folder creation.');
      this.assertActive(request,generation);
    }
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
      console.error('Runtime folder selection failed.',error);
      request.state = {kind:'failed',path,create};
      request.diagnostic = error instanceof Error ? error.stack ?? error.message : String(error);
      await restore(`${error instanceof Error ? error.message : String(error)}\nThe task is still pending.`,[[
        {text:'Retry',callback_data:`folder:${token}:retry`},
        ...(request.options.length > 1 ? [{text:'Choose another folder',callback_data:`folder:${token}:other`}] : []),
        {text:'Cancel',callback_data:`folder:${token}:cancel`}]]);
      return;
    }
    await ctx.api.editMessageText(ctx.chat!.id,request.messageId,`Runtime folder: ${cwd}`,{reply_markup:{inline_keyboard:[]}});
    this.assertActive(request,generation);
    this.folderRequests.set(token,request);
    if (!this.folderRequests.claim(token)) return;
    try {
      await this.dependencies.resume(request.continuation,request.source,cwd,request.authority ?? ctx);
      this.folderRequests.finish(token,'completed');
    } catch (error) {
      this.folderRequests.finish(token,'interrupted',error);
      throw error;
    }
  }
  private assertActive(request: FolderRequest, generation: number): void {
    if (generation !== this.generation || request.expires <= Date.now() || this.dependencies.stopped() ||
        refreshTermination(this.dependencies.config) || JSON.stringify(this.folderSettings(request.source.chat!.id)) !== request.fingerprint)
      throw new Error('This folder request is stale. Send the command again.');
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
