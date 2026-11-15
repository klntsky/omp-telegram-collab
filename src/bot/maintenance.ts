import type { Bot, Context } from 'grammy';
import { AbortController as TelegramAbortController } from 'abort-controller';
import type { AppConfig, TopicSession } from '../../shared/contracts.js';
import type { Store } from '../store.js';
import type { Omp } from '../omp.js';
import { withCancellation } from '../cancellation.js';
import { OmpProviderSetupError } from '../runtime/provider-setup-error.js';
import type { SessionObservation, StatusFailure } from './types.js';

interface MaintenanceDependencies {
 bot: Bot<Context>; config: AppConfig; store: Store; runtime: Omp;
 botId(): number; stopped(): boolean; restoreSessions(): void;
 sessionAssigned(session: TopicSession): boolean;
 sendInitial(session: TopicSession): Promise<void>;
 refreshTopicStatus(session: TopicSession): Promise<void>;
 recoverExistingMirror(session: TopicSession): Promise<void>;
 dropListener(id: string): void; refreshPresetCatalogs(): Promise<void>;
 sessionObservation(id: string): SessionObservation; syncCommandMenus(): Promise<void>;
}

export class BotMaintenance {
 readonly background = new AbortController();
 catalogRefresh = new AbortController();
 readonly backgroundTasks = new Set<Promise<void>>();
 readonly catalogTasks = new Map<number, Promise<void>>();
 readonly catalogObservations = new Map<number, {refreshedAt?:number;failure?:StatusFailure;failed?:boolean}>();
 private backgroundStarted = false;
 private readonly providerSetupNotices = new Map<number, Set<number>>();
 private statusTimer?: NodeJS.Timeout;
 private menuTimer?: NodeJS.Timeout;
 private checkingStatuses = false;
 constructor(private readonly deps: MaintenanceDependencies) {}
 stopTimers(): void { clearInterval(this.statusTimer); clearInterval(this.menuTimer); }

startBackground(): void {
    if (this.deps.stopped() || this.backgroundStarted) return;
    if (!this.deps.bot.isInited())
      throw new Error('Bot identity must be initialized before background maintenance');
    this.backgroundStarted = true;
    this.deps.restoreSessions();
    this.statusTimer ??= setInterval(() => {
      if (this.deps.stopped() || this.deps.config.terminated || this.checkingStatuses) return;
      this.checkingStatuses = true;
      void this.runBackground('topic-status', async (signal) => {
        try {
          const sessions = this.deps.store.listSessions(this.deps.botId());
          await Promise.all(
            Array.from({ length: Math.min(4, sessions.length) }, async () => {
              for (let next = sessions.shift(); next; next = sessions.shift()) {
                const session = next;
                signal.throwIfAborted();
                if (this.deps.sessionAssigned(session)) {
                  if (this.deps.store.hasPendingInitialTask(session.id)) {
                    void this.runBackground(`initial-recovery:${session.id}`, () =>
                      this.deps.sendInitial(session),
                    );
                  }
                  await Promise.all([
                    this.runBackground(`topic-status:${session.id}`, () =>
                      this.deps.refreshTopicStatus(session),
                    ),
                    this.runBackground(`mirror-recovery:${session.id}`, () =>
                      this.deps.recoverExistingMirror(session),
                    ),
                  ]);
                } else this.deps.dropListener(session.id);
              }
            }),
          );
        } finally {
          this.checkingStatuses = false;
        }
      });
    }, 30000);
    this.statusTimer.unref();
    void this.refreshSkillCatalogs();
    void this.deps.refreshPresetCatalogs();
    this.menuTimer ??= setInterval(() => {
      void this.refreshSkillCatalogs();
      void this.deps.refreshPresetCatalogs();
    }, 60000);
    this.menuTimer.unref();
  }

runBackground(phase: string, operation: (signal: AbortSignal) => Promise<void>, signal = this.background.signal): Promise<void> {
    if (signal.aborted || this.deps.stopped()) return Promise.resolve();
    const startedAt = performance.now();
    const task = operation(signal).catch(error => {
      if (error !== signal.reason) {
        const failure = {operation:phase,at:Date.now(),error};
        if (phase.startsWith('skills:')) {
          const path = Number(phase.slice('skills:'.length));
          const observation = this.catalogObservations.get(path) ?? {};
          observation.failure = failure;
          observation.failed = true;
          this.catalogObservations.set(path,observation);
        } else if (phase.includes(':')) this.deps.sessionObservation(phase.slice(phase.indexOf(':')+1)).failure = failure;
        console.error(`Bot ${this.deps.botId()} background ${phase} failed.`, error);
      }
    }).finally(() => {
      this.backgroundTasks.delete(task);
      console.log(JSON.stringify({event:'bot-background',botId:this.deps.botId(),phase,durationMs:Math.round(performance.now()-startedAt),cancelled:signal.aborted}));
    });
    this.backgroundTasks.add(task);
    return task;
  }

private async notifyProviderSetupFailure(instanceId: number, defaultDir: string, signal: AbortSignal): Promise<void> {
    const botId = this.deps.botId();
    const chats = this.deps.config.instances.find(instance => instance.id === instanceId && instance.defaultDir === defaultDir)?.chats ?? [];
    let notified = this.providerSetupNotices.get(instanceId);
    if (!notified) {
      notified = new Set<number>();
      this.providerSetupNotices.set(instanceId, notified);
    }
    for (const chatId of new Set(chats.filter(chat => chat.botId === botId).map(chat => chat.chatId))) {
      if (signal.aborted || this.deps.stopped() || this.deps.config.terminated) return;
      if (notified.has(chatId) || !this.deps.store.isEnrolled(botId, chatId)) continue;
      if (!this.deps.config.instances.find(instance => instance.id === instanceId && instance.defaultDir === defaultDir)?.chats.some(chat => chat.botId === botId && chat.chatId === chatId)) continue;
      const controller = new TelegramAbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      try {
        await this.deps.bot.api.sendMessage(chatId, 'OMP is present, but no providers are set up. Log in to one of the inference providers OMP supports in the terminal', {}, controller.signal);
        notified.add(chatId);
      } catch (error) {
        if (error !== signal.reason)
          console.error(`Bot ${botId} chat ${chatId} background skills:${instanceId}:provider-setup-notice failed.`, error);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    }
  }

refreshSkillCatalogs(): Promise<void> {
    if (this.deps.stopped() || this.deps.config.terminated) return Promise.resolve();
    const signal = this.catalogRefresh.signal;
    const tasks: Promise<void>[] = [];
    for (const instance of this.deps.config.instances) {
      const instanceId = instance.id;
      if (!instance.chats.some(chat => chat.botId === this.deps.botId())) continue;
      let task = this.catalogTasks.get(instanceId);
      if (!task) {
        task = this.runBackground(`skills:${instanceId}`, async () => {
          let skills;
          try {
            skills = await withCancellation(this.deps.runtime.listSkills(instanceId, undefined, signal), signal);
          } catch (error) {
            if (error !== signal.reason && error instanceof OmpProviderSetupError)
              await this.notifyProviderSetupFailure(instanceId, instance.defaultDir, signal);
            throw error;
          }
          signal.throwIfAborted();
          if (!this.deps.config.instances.find(current => current.id === instanceId && current.defaultDir === instance.defaultDir)?.chats.some(chat => chat.botId === this.deps.botId())) return;
          this.deps.store.setSkillCatalog(instanceId, skills);
          this.providerSetupNotices.delete(instanceId);
          const observation = this.catalogObservations.get(instanceId) ?? {};
          observation.refreshedAt = Date.now();
          observation.failed = false;
          this.catalogObservations.set(instanceId,observation);
          await this.deps.syncCommandMenus();
        }, signal);
        this.catalogTasks.set(instanceId, task);
        const current = task;
        const removeTask = () => { if (this.catalogTasks.get(instanceId) === current) this.catalogTasks.delete(instanceId); };
        void task.then(removeTask, removeTask);
      }
      tasks.push(task);
    }
    return Promise.all(tasks).then(() => {});
  }
}
