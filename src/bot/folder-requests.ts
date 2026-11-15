import { restoreFolderAlbum } from './folder-context.js';
import type { PendingSkillKey } from '../store.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Context } from 'grammy';
import type { PendingPromptContent } from '../../shared/contracts.js';
import { contextDestination } from '../telegram-destination.js';
import type { PromptExtension } from '../telegram-commands.js';

export type FolderContinuation =
  | {kind:'prompt';content:PendingPromptContent;extensions:readonly PromptExtension[];worktree:boolean;skills:{names:string[];topicSkills:string[]}}
  | {kind:'proposal';content:PendingPromptContent;worktree:boolean;skills:{names:string[];topicSkills:string[]};proposalMode:boolean}
  | {kind:'topic';accepted?:{key:PendingSkillKey;names:readonly string[]};task?:PendingPromptContent;name?:string;worktree:boolean;extensions:readonly PromptExtension[];skills:{names:string[];topicSkills:string[]}}
  | {kind:'manual';title:string;skills:string[]};
export interface FolderRequest {
  state: {kind:'choose';offset:number} | {kind:'entry'} | {kind:'create';path:string} | {kind:'failed';path:string;create:boolean};
  source: Context; authority?: Context; messageId: number; expires: number;
  instanceId: number; defaultDir: string; fingerprint: string; options: string[];
  continuation: FolderContinuation;
  albums?: Context['update'][];
  diagnostic?: string;
}

// Claims are durable before side effects: an interrupted claim is never automatically
// replayed, since Telegram topic creation and runtime admission may already have run.
export class FolderRequests {
  constructor(private readonly db: DatabaseSync, private readonly botId: () => number,
    private readonly context: (update: Context['update']) => Context) {}
  get(token:string): FolderRequest | undefined {
    const row = this.db.prepare('SELECT payload FROM folder_requests WHERE bot_id=? AND token=? AND status=\'waiting\'').get(this.botId(),token);
    if (!row) return undefined;
    const data = JSON.parse(String(row.payload));
    const source = this.context(data.source);
    if (data.albums) restoreFolderAlbum(source,data.albums);
    return {...data,source,authority:data.authority ? this.context(data.authority) : undefined};
  }
  set(token:string, request:FolderRequest): void {
    const payload = JSON.stringify({...request,source:request.source.update,authority:request.authority?.update});
    const saved = this.db.prepare('INSERT INTO folder_requests(bot_id,token,status,payload) VALUES(?,?,\'waiting\',?) ON CONFLICT(bot_id,token) DO UPDATE SET status=\'waiting\',payload=excluded.payload WHERE folder_requests.status IN (\'waiting\',\'claimed\')').run(this.botId(),token,payload);
    if (saved.changes !== 1) throw new Error('This folder request is no longer active.');
  }
  claim(token:string): boolean {
    return this.db.prepare('UPDATE folder_requests SET status=\'claimed\' WHERE bot_id=? AND token=? AND status=\'waiting\'').run(this.botId(),token).changes === 1;
  }
  finish(token:string,status:string,error?:unknown): void {
    this.db.prepare('UPDATE folder_requests SET status=?,diagnostic=?,payload=CASE WHEN ? IN (\'retired\',\'expired\',\'completed\') THEN \'{}\' ELSE payload END WHERE bot_id=? AND token=?').run(status,error === undefined ? null : error instanceof Error ? error.stack ?? error.message : String(error),status,this.botId(),token);
  }
  own(request:FolderRequest): void {
    const destination = contextDestination(request.source);
    this.db.prepare('INSERT OR IGNORE INTO folder_entries(bot_id,chat_id,thread_id,message_id) VALUES(?,?,?,?)').run(this.botId(),request.source.chat!.id,destination.kind === 'topic' ? destination.threadId : 1,request.messageId);
  }
  owns(ctx:Context,messageId:number): boolean {
    const destination = contextDestination(ctx);
    return !!this.db.prepare('SELECT 1 FROM folder_entries WHERE bot_id=? AND chat_id=? AND thread_id=? AND message_id=?').get(this.botId(),ctx.chat!.id,destination.kind === 'topic' ? destination.threadId : 1,messageId);
  }
  waiting(): [string,FolderRequest][] {
    return this.db.prepare('SELECT token FROM folder_requests WHERE bot_id=? AND status=\'waiting\'').all(this.botId()).map(row => [String(row.token),this.get(String(row.token))!]);
  }
  invalidate(): void {
    this.db.prepare('UPDATE folder_requests SET status=\'retired\',payload=\'{}\' WHERE bot_id=? AND status IN (\'waiting\',\'claimed\')').run(this.botId());
  }
  find(ctx:Context,messageId:number): [string,FolderRequest] | undefined {
    for (const row of this.db.prepare('SELECT token FROM folder_requests WHERE bot_id=? AND status=\'waiting\'').all(this.botId())) {
      const token = String(row.token), request = this.get(token)!;
      if (request.source.chat!.id === ctx.chat!.id && request.messageId === messageId) return [token,request];
    }
    return undefined;
  }
}
