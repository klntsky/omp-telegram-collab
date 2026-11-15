import { HttpError, type Context } from 'grammy';
import type { BotOptions } from '../bot.js';
import { findInstance, refreshTermination } from '../config.js';
import { withCancellation } from '../cancellation.js';
import { contextDestination, replyTo } from '../telegram-destination.js';
import type { StatusFailure, SessionObservation } from './types.js';
import type { SessionConnections } from './connection.js';
import type { MirrorRecovery } from './recovery.js';
import type { BotMaintenance } from './maintenance.js';

interface StatusDependencies {
 config: BotOptions['config']; store: BotOptions['store']; runtime: BotOptions['runtime'];
 recoveryConnections: SessionConnections; recovery: MirrorRecovery; maintenance: BotMaintenance;
 botId(): number; ready(chatId: number): Promise<boolean>; authorize(chatId: number,userId: number,statusOnly?: boolean): Promise<void>;
 assignedId(chatId: number): number; sessionObservation(id: string): SessionObservation;
}

export class BotStatus {
 constructor(private readonly deps: StatusDependencies) {}
async showStatus(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const destination = contextDestination(ctx);
    const assigned = findInstance(this.deps.config,this.deps.botId(),chatId);
    if (!assigned || !this.deps.store.isEnrolled(this.deps.botId(),chatId)) {
      await replyTo(ctx,destination,`${await this.deps.ready(chatId) ? 'Forum permissions ready.' : 'Enable Topics in a supergroup and grant Manage Topics and Pin Messages.'} Run /setup as a current group owner or administrator to enroll an assigned group or request local assignment approval.`);
      return;
    }
    await this.deps.authorize(chatId,ctx.from!.id,true);
    const path = assigned.instance.id;
    const failures: StatusFailure[] = [];
    const suspended = refreshTermination(this.deps.config);
    const lines = [`Bot: ${suspended ? 'online; service terminated' : 'ready'}`];
    try { lines.push(`Forum: ${await this.deps.ready(chatId) ? 'ready' : 'permissions need attention'}`); }
    catch (error) {
      lines.push('Forum: unknown (permission lookup failed)');
      failures.push({operation:'Forum permissions',at:Date.now(),error});
    }
    const stored = this.deps.store.getTopic({botId:this.deps.botId(),destination});
    const detached = destination.kind === 'topic' && this.deps.store.getTopicKind({botId:this.deps.botId(),chatId:destination.chatId,threadId:destination.threadId}) === 'detached';
    const session = stored?.instanceId === path ? stored : undefined;
    if (stored && !session) lines.push('Session: unavailable (assigned to another project)');
    else if (session) {
      const observation = this.deps.sessionObservation(session.id);
      const listener = this.deps.recoveryConnections.listeners.get(session.id);
      lines.push(`Session: ${session.name} (${session.status})`);
      let host = 'unknown';
      if (suspended || detached) {
        host = `unknown (${suspended ? 'service terminated' : 'conversation-only'}; not queried)`;
      } else {
        try {
          host = await withCancellation(this.deps.runtime.isRunning(session),AbortSignal.timeout(5000)) ? 'running' : 'stopped';
        } catch (error) {
          observation.failure = {operation:'Host status lookup',at:Date.now(),error};
        }
      }
      lines.push(`Host: ${host}`);
      lines.push(`Mirroring: ${listener?.connection ? 'connected' : listener?.promise ? 'connecting' : observation.mirrored || host === 'running' ? 'disconnected' : 'not attached'}`);
      const task = observation.task?.state ?? (this.deps.store.hasPendingInitialTask(session.id) ? 'waiting for host; not submitted' : 'unknown (no task observed in this process)');
      lines.push(`Latest task: ${task}`);
      const recovery = listener?.initial?.phase === 'retrying' ? 'initial task retry scheduled' : this.deps.recovery.restoring.has(session.id) ? 'restoring' : this.deps.recovery.reconnecting.has(session.id) ? 'reconnecting' : this.deps.recovery.reconnects.has(session.id) ? 'reconnect scheduled' : 'not scheduled';
      lines.push(`Recovery: ${recovery}`);
      if (observation.failure) failures.push(observation.failure);
    } else lines.push(detached ? 'Session: detached; this topic is conversation-only' : destination.kind === 'general' ? 'Session: General has no session' : 'Session: none; use /new task or create a topic');
    const catalog = this.deps.store.getSkillCatalog(path);
    const catalogObservation = this.deps.maintenance.catalogObservations.get(path);
    const freshness = this.deps.maintenance.catalogTasks.has(path) ? 'refreshing' : catalogObservation?.failed ? 'refresh failed' : catalogObservation?.refreshedAt ? 'current' : 'not checked this process';
    lines.push(`Skill shortcuts: ${catalog ? `saved catalog (${catalog.length} skills); ${freshness}` : `unavailable; ${freshness}`}`);
    lines.push(`Last successful skill check: ${catalogObservation?.refreshedAt ? new Date(catalogObservation.refreshedAt).toISOString() : 'unknown'} (runtime discovery cache may apply)`);
    if (catalogObservation?.failure) failures.push(catalogObservation.failure);
    for (const failure of failures) {
      const error = failure.error instanceof HttpError && failure.error.error instanceof Error ? failure.error.error : failure.error;
      const fields = error instanceof Error ? ['code','signal','killed'].flatMap(key => {
        const value = Reflect.get(error,key);
        return value === undefined || value === null ? [] : [`${key}: ${String(value)}`];
      }) : [];
      const details = failure.error instanceof Error ? failure.error.message : String(failure.error);
      lines.push(`Last failure — ${failure.operation} (${new Date(failure.at).toISOString()}):\n${details}${fields.length ? '\n'+fields.join('\n') : ''}`);
    }
    const text = lines.join('\n');
    for (let offset = 0; offset < text.length;) {
      await this.deps.authorize(chatId,ctx.from!.id,true);
      if (this.deps.assignedId(chatId) !== path) throw new Error('The group instance assignment changed');
      let end = Math.min(offset+3900,text.length);
      if (end < text.length && text.charCodeAt(end-1) >= 0xD800 && text.charCodeAt(end-1) <= 0xDBFF) end--;
      await replyTo(ctx,destination,text.slice(offset,end));
      offset = end;
    }
  }
}
