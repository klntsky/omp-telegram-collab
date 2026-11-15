import type { Context, Bot } from 'grammy';
import { FolderSelection } from './folders.js';
import type { BotOptions } from '../bot.js';
import type { LifecycleDependencies } from './composition.js';
import type { BotAuthorization } from './authorization.js';
import type { PromptAdmission } from './prompt-admission.js';
import type { TopicCreation } from './topic-creation.js';
import type { PromptPreparation } from './prompt-preparation.js';
import type { SessionEntries } from './session-entries.js';
import type { TopicActivityMonitor } from './topic-activity-monitor.js';
import type { SkillPicker } from '../skill-picker.js';
import type { FolderContinuation } from './folder-requests.js';
import { contextDestination } from '../telegram-destination.js';
import { accessSync, constants, opendirSync, realpathSync } from 'node:fs';
import { refreshTermination } from '../config.js';

interface ResumeDependencies {
  options: BotOptions; lifecycle: LifecycleDependencies; authorization: BotAuthorization;
  admission: PromptAdmission; creation: TopicCreation; preparation: PromptPreparation;
  entries: SessionEntries; activity: TopicActivityMonitor; skills: SkillPicker;
  folderSettings(chatId: number): unknown;
}

export async function resumeFolder(deps: ResumeDependencies, payload: FolderContinuation, source: Context, cwd: string, authority: Context): Promise<void> {
  const {options,lifecycle,authorization,admission,creation,preparation,entries,activity,skills} = deps;
      switch (payload.kind) {
        case 'prompt':
          await admission.routePrompt(source,payload.content,undefined,payload.extensions,payload.worktree,payload.skills,cwd);
          return;
        case 'proposal': {
          if (!authorization.usersCanProposePrompts(source.chat!.id) || authorization.allMessagesArePrompts(source.chat!.id) !== payload.proposalMode)
            throw new Error('This prompt proposal is no longer active.');
          const names = payload.worktree ? [] : [...new Set([...payload.skills.topicSkills,...payload.skills.names])];
          const content = names.length ? {...payload.content,text:`${names.map(name => `/skill:${name}`).join(' ')}\n\n${payload.content.text}`} : payload.content;
          await creation.newSession(source,content,undefined,undefined,{key:skills.key(source),names:payload.skills.names},payload.worktree,authority,[],undefined,cwd,payload.skills);
          return;
        }
        case 'topic':
          await creation.newSession(source,payload.task,undefined,payload.name,payload.accepted,payload.worktree,authority,payload.extensions,undefined,cwd,payload.skills);
          return;
        case 'manual': {
          const destination = contextDestination(source);
          if (destination.kind !== 'topic') throw new Error('Manual session requires a topic');
          const epoch = admission.epoch;
          const instanceId = authorization.assignedId(source.chat!.id);
          const fingerprint = JSON.stringify(deps.folderSettings(source.chat!.id));
          await authorization.authorize(source.chat!.id,source.from!.id);
          if (authority.callbackQuery) {
            await authorization.authorize(source.chat!.id,authority.from!.id);
            if (!(await authorization.currentAdmin(authority))) throw new Error('Administrator access changed before manual session registration.');
          }
          if (epoch !== admission.epoch || lifecycle.stopped() || refreshTermination(options.config) ||
              authorization.assignedId(source.chat!.id) !== instanceId ||
              fingerprint !== JSON.stringify(deps.folderSettings(source.chat!.id)))
            throw new Error('Folder settings or service state changed before manual session registration.');
          opendirSync(cwd).closeSync();
          accessSync(cwd,constants.R_OK | constants.X_OK);
          if (realpathSync(cwd) !== cwd) throw new Error('Managed working directory identity changed');
          if (options.store.getTopic({botId:lifecycle.id(),destination})) return;
          const created = options.store.createSession({botId:lifecycle.id(),chatId:destination.chatId,threadId:destination.threadId,instanceId:authorization.assignedId(source.chat!.id),cwd},payload.title,{kind:'managed'});
          if (payload.skills.length) options.store.setNewTopicSkills(created.id,payload.skills);
          if (authorization.createsTopicWorktrees(source.chat!.id)) {
            await authorization.authorize(source.chat!.id,authority.from!.id);
            if (!(await authorization.currentAdmin(authority))) throw new Error('Administrator access changed before worktree creation.');
            await preparation.createTopicWorktree(created);
          }
          await entries.announce(created);
          await activity.refreshTopicStatus(created);
          return;
        }
      }
}

export function createFolderSelection(options: BotOptions, bot: Bot<Context>, lifecycle: LifecycleDependencies,
  authorization: BotAuthorization, albumContexts: (ctx:Context) => readonly Context[], dependencies: () => Omit<ResumeDependencies,'folderSettings'>): FolderSelection {
  const folders: FolderSelection = new FolderSelection({db:options.store.db,bot,config:options.config,albumContexts,
    botId:lifecycle.id.bind(lifecycle),stopped:lifecycle.stopped.bind(lifecycle),
    assignedId:authorization.assignedId.bind(authorization),authorize:authorization.authorize.bind(authorization),
    currentAdmin:authorization.currentAdmin.bind(authorization),
    resume:(payload,source,cwd,authority) => resumeFolder({...dependencies(),folderSettings:folders.folderSettings.bind(folders)},payload,source,cwd,authority)});
  return folders;
}
