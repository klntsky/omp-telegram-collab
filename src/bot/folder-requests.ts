import type { PendingSkillKey } from '../store.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Context } from 'grammy';
import type { PendingPromptContent } from '../../shared/contracts.js';
import { contextDestination } from '../telegram-destination.js';
import type { PromptExtension } from '../telegram-commands.js';

const albums = new WeakMap<Context, readonly Context[]>();
export function folderAlbumContexts(source: Context, fallback: readonly Context[]): readonly Context[] {
  return albums.get(source) ?? fallback;
}

export type FolderContinuation =
  | {kind:'prompt';content:PendingPromptContent;extensions:readonly PromptExtension[];worktree:boolean;skills:{names:string[];topicSkills:string[]}}
  | {kind:'proposal';content:PendingPromptContent;worktree:boolean;skills:{names:string[];topicSkills:string[]};proposalMode:boolean}
  | {kind:'topic';accepted?:{key:PendingSkillKey;names:readonly string[]};task?:PendingPromptContent;name?:string;worktree:boolean;extensions:readonly PromptExtension[];skills:{names:string[];topicSkills:string[]}}
  | {kind:'manual';title:string;skills:string[]};
export interface FolderRequest {
  token: string;
  revision: number;
  state: {kind:'choose';offset:number} | {kind:'entry'} | {kind:'create';path:string} | {kind:'failed';path:string;create:boolean;error:string};
  source: Context; authority?: Context; messageId: number; expires: number;
  instanceId: number; defaultDir: string; fingerprint: string; options: string[];
  continuation: FolderContinuation;
  albums?: Context['update'][];
}

// Claim a specific revision before side effects. Interrupted admissions cannot be
// replayed safely because Telegram topic creation may already have succeeded.
export class FolderRequests {
  constructor(private readonly db: DatabaseSync, private readonly botId: () => number,
    private readonly context: (update: Context['update']) => Context) {}
  private encode(request: FolderRequest): string {
    return JSON.stringify({...request,source:request.source.update,authority:request.authority?.update});
  }
  private decode(payload: string): FolderRequest {
    const data = JSON.parse(payload);
    const source = this.context(data.source);
    if (data.albums) albums.set(source,data.albums.map((update: Context['update']) => this.context(update)));
    return {...data,source,authority:data.authority ? this.context(data.authority) : undefined};
  }
  get(token: string): FolderRequest | undefined {
    const row = this.db.prepare("SELECT payload FROM folder_requests WHERE bot_id=? AND token=? AND status='waiting'").get(this.botId(),token);
    return row ? this.decode(String(row.payload)) : undefined;
  }
  insert(request: FolderRequest): void {
    this.db.prepare("INSERT INTO folder_requests(bot_id,token,status,payload) VALUES(?,?,'waiting',?)")
      .run(this.botId(),request.token,this.encode(request));
  }
  claim(request: FolderRequest): boolean {
    return this.db.prepare("UPDATE folder_requests SET status='claimed' WHERE bot_id=? AND token=? AND status='waiting' AND json_extract(payload,'$.revision')=?")
      .run(this.botId(),request.token,request.revision).changes === 1;
  }
  save(request: FolderRequest): void {
    const saved = this.db.prepare("UPDATE folder_requests SET status='waiting',payload=? WHERE bot_id=? AND token=? AND status='claimed' AND json_extract(payload,'$.revision')=?")
      .run(this.encode({...request,revision:request.revision+1}),this.botId(),request.token,request.revision);
    if (saved.changes !== 1) throw new Error('This folder request is no longer active.');
    request.revision++;
  }
  finish(request: FolderRequest, status: 'retired' | 'expired' | 'completed' | 'interrupted', error?: unknown): void {
    this.db.prepare("UPDATE folder_requests SET status=?,diagnostic=?,payload=CASE WHEN ?='interrupted' THEN payload ELSE '{}' END WHERE bot_id=? AND token=? AND (status='claimed' OR status=?)")
      .run(status,error === undefined ? null : error instanceof Error ? error.stack ?? error.message : String(error),status,this.botId(),request.token,status);
  }
  own(request:FolderRequest): void {
    const destination = contextDestination(request.source);
    this.db.prepare('INSERT OR IGNORE INTO folder_entries(bot_id,chat_id,thread_id,message_id) VALUES(?,?,?,?)').run(this.botId(),request.source.chat!.id,destination.kind === 'topic' ? destination.threadId : 1,request.messageId);
  }
  owns(ctx:Context,messageId:number): boolean {
    const destination = contextDestination(ctx);
    return !!this.db.prepare('SELECT 1 FROM folder_entries WHERE bot_id=? AND chat_id=? AND thread_id=? AND message_id=?').get(this.botId(),ctx.chat!.id,destination.kind === 'topic' ? destination.threadId : 1,messageId);
  }
  expired(): FolderRequest[] {
    return this.db.prepare("SELECT payload FROM folder_requests WHERE bot_id=? AND status='waiting' AND json_extract(payload,'$.expires')<=?")
      .all(this.botId(),Date.now()).map(row => this.decode(String(row.payload)));
  }
  invalidate(): void {
    this.db.prepare('UPDATE folder_requests SET status=\'retired\',payload=\'{}\' WHERE bot_id=? AND status IN (\'waiting\',\'claimed\')').run(this.botId());
  }
  find(ctx: Context, messageId: number): FolderRequest | undefined {
    const row = this.db.prepare("SELECT payload FROM folder_requests WHERE bot_id=? AND status='waiting' AND json_extract(payload,'$.source.message.chat.id')=? AND json_extract(payload,'$.messageId')=?")
      .get(this.botId(),ctx.chat!.id,messageId);
    return row ? this.decode(String(row.payload)) : undefined;
  }
}
