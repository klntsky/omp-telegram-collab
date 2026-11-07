import { InputRouter } from './input-router.js';
import { BotInput } from './input.js';
import type { Bot, Context } from 'grammy';
import type { SkillPicker } from '../skill-picker.js';
import type { BotOptions } from '../bot.js';
import type { LifecycleDependencies } from './composition.js';
import type { BotQuestions } from './questions.js';
import type { PromptAdmission } from './prompt-admission.js';
import type { BotAuthorization } from './authorization.js';
import type { CapacityAdmission } from './capacity-admission.js';
import type { FolderSelection } from './folders.js';
import type { SettingsPanels } from './settings-panels.js';
import type { BotPresets } from './presets.js';
import type { SettingsPanelStore } from './settings-panel-store.js';
import type { ForumSetup } from './forum-setup.js';
import type { BotStatus } from './status.js';
import type { SessionEntries } from './session-entries.js';
import type { TopicTitles } from './topic-titles.js';
import type { TopicMetadataOwners } from './topic-metadata-owners.js';
import type { PromptPreparation } from './prompt-preparation.js';
import type { SessionConnections } from './connection.js';
import type { TopicActivityMonitor } from './topic-activity-monitor.js';
import type { BotMaintenance } from './maintenance.js';
import type { MirrorRecovery } from './recovery.js';
import type { SessionDetach } from './session-detach.js';
import type { BotCommandMenus } from './command-menus.js';
import type { SessionFork } from './session-fork.js';
import type { TopicCreation } from './topic-creation.js';
import type { PromptReceipts } from './prompts.js';
import type { WorktreeCleanup } from './worktree-cleanup.js';

interface RouterComponents {
 options: BotOptions; bot: Bot<Context>; lifecycle: LifecycleDependencies; skills: SkillPicker;
 questions: BotQuestions;
 admission: PromptAdmission;
 authorization: BotAuthorization;
 capacity: CapacityAdmission;
 folders: FolderSelection;
 settings: SettingsPanels;
 presets: BotPresets;
 panelStore: SettingsPanelStore;
 setup: ForumSetup;
 status: BotStatus;
 entries: SessionEntries;
 titles: TopicTitles;
 owners: TopicMetadataOwners;
 preparation: PromptPreparation;
 connections: SessionConnections;
 activity: TopicActivityMonitor;
 maintenance: BotMaintenance;
 recovery: MirrorRecovery;
 detach: SessionDetach;
 menus: BotCommandMenus;
 fork: SessionFork;
 creation: TopicCreation;
 receipts: PromptReceipts;
 cleanup: WorktreeCleanup;
}

/** Composes the ordered input pipeline without giving operations a service-wide context. */
export function composeInputRouter({ options, bot, lifecycle, skills, questions, admission, authorization, capacity, folders, settings, presets, panelStore, setup, status, entries, titles, owners, preparation, connections, activity, maintenance, recovery, detach, menus, fork, creation, receipts, cleanup }: RouterComponents) {
  const router: InputRouter = new InputRouter(
  {
    answerQuestion: questions.answerQuestion.bind(questions),
    applyTermination: lifecycle.applyTermination.bind(lifecycle),
    approvePrompt: admission.approvePrompt.bind(admission),
    assignedId: authorization.assignedId.bind(authorization),
    bot: bot,
    commandHelp: authorization.commandHelp.bind(authorization),
    confirmCapacity: capacity.confirmCapacity.bind(capacity),
    currentAdmin: authorization.currentAdmin.bind(authorization),
    folderCallback: folders.folderCallback.bind(folders),
    worktreeCleanupCallback: cleanup.callback.bind(cleanup),
    get id() { return lifecycle.id(); },
    openSettings: settings.open.bind(settings),
    config: options.config,
    store: options.store,
    presetCallback: presets.presetCallback.bind(presets),
    promptHelp: authorization.promptHelp.bind(authorization),
    saveSettingsReply: settings.saveReply.bind(settings),
    settingsCallback: settings.callback.bind(settings),
    settingsReplyPanel: panelStore.replyPanel.bind(panelStore),
    setup: setup.setup.bind(setup),
    showStatus: status.showStatus.bind(status),
    skills: skills,
    get stopped() { return lifecycle.stopped(); },
    clearTermination: lifecycle.clearTermination.bind(lifecycle),
  },
  {
    get admissionEpoch() { return admission.epoch; },
    announce: entries.announce.bind(entries),
    applySessionTitle: titles.applySessionTitle.bind(titles),
    assignedId: authorization.assignedId.bind(authorization),
    authorize: authorization.authorize.bind(authorization),
    bot: bot,
    chooseFolder: folders.chooseFolder.bind(folders),
    closedSessions: owners.closedSessions,
    createTopicWorktree: preparation.createTopicWorktree.bind(preparation),
    createsTopicWorktrees: authorization.createsTopicWorktrees.bind(authorization),
    currentAdmin: authorization.currentAdmin.bind(authorization),
    defaultNewTopicSkill: preparation.defaultNewTopicSkill.bind(preparation),
    delivery: connections.delivery,
    dropListener: connections.dropListener.bind(connections),
    folderSettings: folders.folderSettings.bind(folders),
    getIconIds: owners.getIconIds.bind(owners),
    get id() { return lifecycle.id(); },
    metadataOwners: owners.metadataOwners,
    offerWorktreeCleanup: cleanup.offer.bind(cleanup),
    config: options.config,
    store: options.store,
    projectTopicTitle: titles.projectTopicTitle.bind(titles),
    refreshTopicStatus: activity.refreshTopicStatus.bind(activity),
    runBackground: maintenance.runBackground.bind(maintenance),
    sessionAssigned: authorization.sessionAssigned.bind(authorization),
    invalidateSession: lifecycle.invalidateSession.bind(lifecycle),
    sessionObservation: recovery.sessionObservation.bind(recovery),
    get stopped() { return lifecycle.stopped(); },
    stripTopicStatus: titles.stripTopicStatus.bind(titles),
    titleSource: owners.titleSource.bind(owners),
    topicIconValue: owners.topicIconValue.bind(owners),
    topicMetadata: owners.topicMetadata.bind(owners),
    windDownClosedSession: activity.windDownClosedSession.bind(activity),
  },
  {
    assignedId: authorization.assignedId.bind(authorization),
    authorize: authorization.authorize.bind(authorization),
    currentAdmin: authorization.currentAdmin.bind(authorization),
    folderSettings: folders.folderSettings.bind(folders),
    store: options.store,
    promptImages: preparation.promptImages.bind(preparation),
    requestKind: questions.requestKind.bind(questions),
    routePrompt: admission.routePrompt.bind(admission),
    skills: skills,
    submitAnswer: questions.submitAnswer.bind(questions),
    usersCanProposePrompts: authorization.usersCanProposePrompts.bind(authorization),
  },
  {
    currentAdmin: authorization.currentAdmin.bind(authorization),
    detachSession: detach.detachSession.bind(detach),
    get id() { return lifecycle.id(); },
    listAdmins: authorization.listAdmins.bind(authorization),
    runtime: options.runtime,
    store: options.store,
    skillAliases: menus.skillAliases,
    skills: skills,
  },
  {
    assignedCwd: authorization.assignedCwd.bind(authorization),
    assignedId: authorization.assignedId.bind(authorization),
    authorize: authorization.authorize.bind(authorization),
    commandHelp: authorization.commandHelp.bind(authorization),
    currentAdmin: authorization.currentAdmin.bind(authorization),
    dropListener: connections.dropListener.bind(connections),
    forkSession: fork.forkSession.bind(fork),
    listen: connections.listen.bind(connections),
    newSession: creation.newSession.bind(creation),
    config: options.config,
    runtime: options.runtime,
    store: options.store,
    promptHelp: authorization.promptHelp.bind(authorization),
    requireSessionAssignment: authorization.requireSessionAssignment.bind(authorization),
    routePrompt: admission.routePrompt.bind(admission),
    sessionMarkup: entries.sessionMarkup.bind(entries),
  },
  {
    authorize: authorization.authorize.bind(authorization),
    currentAdmin: authorization.currentAdmin.bind(authorization),
    runtime: options.runtime,
    store: options.store,
    renderPresetPanel: presets.renderPresetPanel.bind(presets),
    replyPresetText: presets.replyPresetText.bind(presets),
    replyPresetUsage: presets.replyPresetUsage.bind(presets),
    requireSessionAssignment: authorization.requireSessionAssignment.bind(authorization),
  },
  {
    acknowledgeMessage: receipts.acknowledgeMessage.bind(receipts),
    authorize: authorization.authorize.bind(authorization),
    invalidateCapacity: capacity.invalidateSession.bind(capacity),
    dropListener: connections.dropListener.bind(connections),
    invalidateActivity: owners.invalidateActivity.bind(owners),
    listen: connections.listen.bind(connections),
    listeners: connections.listeners,
    runtime: options.runtime,
    store: options.store,
    requireSessionAssignment: authorization.requireSessionAssignment.bind(authorization),
    invalidateSession: lifecycle.invalidateSession.bind(lifecycle),
    setTopicStatus: activity.setTopicStatus.bind(activity),
  },
    session => authorization.requireSessionAssignment(session),
  );
  const input: BotInput = new BotInput({
    bot: bot,
    config: options.config,
    store: options.store,
    delivery: connections.delivery,
    questions: questions,
    skillAliases: menus.skillAliases,
    botId: lifecycle.id.bind(lifecycle),
    stopped: lifecycle.stopped.bind(lifecycle),
    sessionAssigned: authorization.sessionAssigned.bind(authorization),
    sessionObservation: recovery.sessionObservation.bind(recovery),
    settingsReplyPanel: panelStore.replyPanel.bind(panelStore),
    allMessagesArePrompts: authorization.allMessagesArePrompts.bind(authorization),
    usersCanProposePrompts: authorization.usersCanProposePrompts.bind(authorization),
    currentAdmin: authorization.currentAdmin.bind(authorization),
    handle: router.handle.bind(router),
  });
  return { router, input };
}
