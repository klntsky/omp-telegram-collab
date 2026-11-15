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
  // Only in-flight work is invalidated; saved waits capture the current generation after restart.
  private generation = 0;
  private expiryTimer?: NodeJS.Timeout;
  private expiryTail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: FolderSelectionDependencies) {
    this.folderRequests = new FolderRequests(dependencies.db,dependencies.botId,
      update => new Context(update,dependencies.bot.api,dependencies.bot.botInfo));
  }
  start(): void {
    const sweep = () => {
      this.expiryTail = this.expiryTail.then(async () => {
        for (const request of this.folderRequests.expired()) {
          if (!this.folderRequests.claim(request)) continue;
          this.folderRequests.finish(request,'expired');
          try {
            await request.source.api.editMessageText(request.source.chat!.id,request.messageId,
              'This folder request expired. Send the original task again.',{reply_markup:{inline_keyboard:[]}});
          } catch (error) {
            console.error('Could not retire expired folder controls.',error);
            this.folderRequests.finish(request,'expired',error);
          }
        }
      }).catch(error => console.error('Folder expiry failed.',error));
    };
    if (!this.expiryTimer) { sweep(); this.expiryTimer = setInterval(sweep,1000); this.expiryTimer.unref(); }
  }
  invalidate(): void { this.generation++; this.folderRequests.invalidate(); }
  async close(): Promise<void> {
    clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
    await this.expiryTail;
  }
  folderSettings(chatId: number) {
    const assigned = findInstance(readConfig(this.dependencies.config.configPath), this.dependencies.botId(), chatId);
    if (!assigned || assigned.instance.id !== this.dependencies.assignedId(chatId)) throw new Error('The group instance assignment changed');
    const chat = assigned.instance.chats.find(chat => chat.botId === this.dependencies.botId() && chat.chatId === chatId)!;
    return {instanceId:assigned.instance.id, defaultDir:assigned.instance.defaultDir, options:chat.folder_options?.length ? chat.folder_options : ['.']};
  }
  async chooseFolder(source: Context, authority: Context | undefined, continuation: FolderContinuation): Promise<boolean> {
    const generation = this.generation;
    const settings = this.folderSettings(source.chat!.id);
    const request: FolderRequest = {...settings,token:randomBytes(16).toString('base64url'),revision:0,
      state:{kind:'choose',offset:0},source,authority,messageId:0,expires:Date.now()+300000,
      fingerprint:JSON.stringify(settings),continuation,albums:this.dependencies.albumContexts(source).map(ctx => ctx.update)};
    if (settings.options.length === 1) {
      const path = resolve(settings.defaultDir,settings.options[0]!);
      let cwd: string | undefined;
      try {
        cwd = this.resolveFolder(path,false);
        request.state = {kind:'create',path};
      } catch (error) {
        console.error('Runtime folder selection failed.',error);
        request.state = {kind:'failed',path,create:false,error:error instanceof Error ? error.message : String(error)};
      }
      if (cwd !== undefined) {
        // There is no waiting interaction to recover; downstream admission owns the durable task.
        this.assertActive(request,generation);
        await this.dependencies.resume(continuation,source,cwd,authority ?? source);
        return true;
      }
    }
    this.folderRequests.insert(request);
    await this.execute(request,generation,() => this.show(request,generation,true));
    return true;
  }
  async folderReply(ctx: Context): Promise<boolean> {
    const generation = this.generation;
    const reply = ctx.message?.reply_to_message;
    if (!reply || !ctx.chat || !this.folderRequests.owns(ctx,reply.message_id)) return false;
    const request = this.folderRequests.find(ctx,reply.message_id);
    if (!request || !ctx.from || ctx.from.is_bot || ctx.message?.sender_chat || request.state.kind !== 'entry' ||
        ctx.from.id !== request.authority?.from?.id || !sameTopicDestination(contextDestination(ctx),contextDestination(request.source)) ||
        'forward_origin' in reply || 'forward_date' in reply ||
        (ctx.message && ('forward_origin' in ctx.message || 'forward_date' in ctx.message))) return true;
    if (!(await this.authorize(ctx,request))) throw new Error('Administrator access changed before adding a folder.');
    const input = ctx.message && 'text' in ctx.message ? ctx.message.text?.trim() ?? '' : '';
    if (!input || /[\r\n\0]/.test(input) || isAbsolute(input)) {
      await replyTo(ctx,contextDestination(ctx),'Reply with one relative folder path.');
      return true;
    }
    await this.execute(request,generation,async () => {
      const option = normalize(input).replace(/\/+$/, '') || '.';
      const config = readConfig(this.dependencies.config.configPath);
      const chat = findInstance(config,this.dependencies.botId(),ctx.chat!.id)!.instance.chats
        .find(chat => chat.botId === this.dependencies.botId() && chat.chatId === ctx.chat!.id)!;
      chat.folder_options = [...new Set([...request.options,option])];
      writeConfig(config);
      findInstance(this.dependencies.config,this.dependencies.botId(),ctx.chat!.id)!.instance.chats
        .find(chat => chat.botId === this.dependencies.botId() && chat.chatId === ctx.chat!.id)!.folder_options = chat.folder_options;
      const settings = this.folderSettings(ctx.chat!.id);
      request.options = settings.options;
      request.fingerprint = JSON.stringify(settings);
      await this.useFolder(request,resolve(request.defaultDir,option),false,generation);
    });
    return true;
  }
  async folderCallback(ctx: Context, data: string): Promise<void> {
    const generation = this.generation;
    const match = /^folder:([A-Za-z0-9_-]{22}):(\d+):([A-Za-z0-9]+)$/.exec(data);
    const message = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
    if (!match || !ctx.from || ctx.from.is_bot || !ctx.chat || !message || !('from' in message) ||
        message.from?.id !== this.dependencies.botId() || 'forward_origin' in message || 'forward_date' in message) return;
    const request = this.folderRequests.get(match[1]!);
    if (!request) {
      await this.dependencies.authorize(ctx.chat.id,ctx.from.id);
      if (!(await this.dependencies.currentAdmin(ctx))) return;
      await ctx.answerCallbackQuery('This request is no longer active. Send the task again.');
      const rows = 'reply_markup' in message ? message.reply_markup?.inline_keyboard : undefined;
      if (rows?.length && rows.flat().every(button => 'callback_data' in button && button.callback_data.startsWith(`folder:${match[1]}:`)))
        await ctx.editMessageReplyMarkup({reply_markup:{inline_keyboard:[]}});
      return;
    }
    if (request.messageId !== message.message_id || ctx.chat.id !== request.source.chat!.id ||
        !sameTopicDestination(contextDestination(ctx),contextDestination(request.source)) ||
        (request.authority && ctx.from.id !== request.authority.from!.id)) return;
    if (!(await this.authorize(ctx,request))) {
      await ctx.answerCallbackQuery('Ask a current group administrator to choose or add a folder for this pending task.');
      return;
    }
    if (request.revision !== Number(match[2]) || !this.view(request).rows.flat().some(button => button.callback_data === data)) {
      await ctx.answerCallbackQuery('This selection is outdated. Use the current folder buttons.');
      return;
    }
    const action = match[3]!;
    if (!(await this.execute(request,generation,async () => {
      if (action === 'cancel') this.folderRequests.finish(request,'retired');
      await ctx.answerCallbackQuery();
      if (action === 'cancel') {
        await ctx.editMessageText('Folder selection cancelled.',{reply_markup:{inline_keyboard:[]}});
        return;
      }
      this.assertActive(request,generation);
      if (action === 'add') {
        request.authority = ctx;
        request.state = {kind:'entry'};
        await this.show(request,generation,true);
      } else if (action === 'other' || action.startsWith('page')) {
        request.state = {kind:'choose',offset:action === 'other' ? 0 : Number(action.slice(4))};
        await this.show(request,generation);
      } else {
        request.authority = ctx;
        const state = request.state;
        const path = state.kind === 'create' || state.kind === 'failed' ? state.path :
          resolve(request.defaultDir,request.options[Number(action)]!);
        await this.useFolder(request,path,state.kind === 'create' || (state.kind === 'failed' && state.create),generation);
      }
    }))) await ctx.answerCallbackQuery('This selection is outdated. Use the current folder buttons.');
  }
  private async authorize(ctx: Context, request: FolderRequest): Promise<boolean> {
    await this.dependencies.authorize(ctx.chat!.id,ctx.from!.id);
    if (ctx.from!.id !== request.source.from!.id)
      await this.dependencies.authorize(ctx.chat!.id,request.source.from!.id);
    return this.dependencies.currentAdmin(ctx);
  }
  private async execute(request: FolderRequest, generation: number, action: () => Promise<void>): Promise<boolean> {
    if (!this.folderRequests.claim(request)) return false;
    try {
      this.assertActive(request,generation);
      await action();
      return true;
    } catch (error) {
      try { this.folderRequests.finish(request,'interrupted',error); }
      catch (recordError) { console.error('Could not persist folder failure.',{botId:this.dependencies.botId(),token:request.token},recordError); }
      throw error;
    }
  }
  private view(request: FolderRequest, revision = request.revision) {
    const button = (text: string, action: string) => ({text,callback_data:`folder:${request.token}:${revision}:${action}`});
    const state = request.state;
    if (state.kind === 'choose') {
      const rows = request.options.slice(state.offset,state.offset+8).map((path,index) =>
        [button(path === '.' ? '<Default>' : path.slice(0,100),String(state.offset+index))]);
      if (state.offset > 0) rows.push([button('Previous folders',`page${Math.max(0,state.offset-8)}`)]);
      if (state.offset+8 < request.options.length) rows.push([button('Next folders',`page${state.offset+8}`)]);
      rows.push([button('Add folder and use it','add')],[button('Cancel','cancel')]);
      return {text:request.authority ? 'Choose the runtime folder for this session.' : 'An administrator can approve this task by choosing its runtime folder.',rows};
    }
    const actions = state.kind === 'entry' ? [] :
      [button(state.kind === 'create' ? 'Create folder' : 'Retry',state.kind === 'create' ? 'create' : 'retry')];
    if (state.kind === 'entry' || request.options.length > 1) actions.push(button('Choose another folder','other'));
    actions.push(button('Cancel','cancel'));
    const text = state.kind === 'entry' ? 'Reply with one relative folder path.' :
      state.kind === 'create' ? `Create folder ${state.path}?` : `${state.error}\nThe task is still pending.`;
    return {text,rows:[actions]};
  }
  private async show(request: FolderRequest, generation: number, newMessage = false): Promise<void> {
    this.assertActive(request,generation);
    const {text,rows} = this.view(request,request.revision+1);
    if (newMessage) {
      if (request.messageId) {
        await request.source.api.editMessageReplyMarkup(request.source.chat!.id,request.messageId,{reply_markup:{inline_keyboard:[]}});
        this.assertActive(request,generation);
      }
      // Client::get_reply_markup supports native reply entry with cancellation controls.
      // https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L11049-L11064
      const markup = {inline_keyboard:rows,...(request.state.kind === 'entry' ? {force_reply:true} : {})};
      const message = await replyTo(request.source,contextDestination(request.source),text,{reply_markup:markup});
      request.messageId = message.message_id;
      if (request.state.kind === 'entry') this.folderRequests.own(request);
    } else {
      await request.source.api.editMessageText(request.source.chat!.id,request.messageId,text,{reply_markup:{inline_keyboard:rows}});
    }
    this.assertActive(request,generation);
    this.folderRequests.save(request);
  }
  private async useFolder(request: FolderRequest, path: string, create: boolean, generation: number): Promise<void> {
    if (create) {
      if (!(await this.authorize(request.authority!,request))) throw new Error('Administrator access changed before folder creation.');
      this.assertActive(request,generation);
    }
    let cwd: string | undefined;
    try { cwd = this.resolveFolder(path,create); }
    catch (error) {
      console.error('Runtime folder selection failed.',error);
      request.state = {kind:'failed',path,create,error:error instanceof Error ? error.message : String(error)};
      await this.show(request,generation);
      return;
    }
    if (cwd === undefined) {
      request.state = {kind:'create',path};
      await this.show(request,generation);
      return;
    }
    await request.source.api.editMessageText(request.source.chat!.id,request.messageId,`Runtime folder: ${cwd}`,{reply_markup:{inline_keyboard:[]}});
    this.assertActive(request,generation);
    await this.dependencies.resume(request.continuation,request.source,cwd,request.authority!);
    this.folderRequests.finish(request,'completed');
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
