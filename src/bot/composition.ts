import { BotMaintenance } from './maintenance.js';
import { BotAuthorization } from './authorization.js';
import { SessionConnections } from './connection.js';
import { TopicMetadataOwners } from './topic-metadata-owners.js';
import { TopicTitles } from './topic-titles.js';
import { TopicActivityMonitor } from './topic-activity-monitor.js';
import { MirrorRecovery } from './recovery.js';
import { PromptReceipts } from './prompts.js';
import { TypingIndicators } from './typing.js';
import { FrameProjection } from './frames.js';
import { BotCommandMenus } from './command-menus.js';
import { BotQuestions } from './questions.js';
import { FolderSelection } from './folders.js';
import { SettingsPanelStore } from './settings-panel-store.js';
import { SettingsPanels } from './settings-panels.js';
import { BotPresets } from './presets.js';
import { PromptPreparation } from './prompt-preparation.js';
import { CapacityAdmission } from './capacity-admission.js';
import { SessionEntries } from './session-entries.js';
import { TopicCreation } from './topic-creation.js';
import { SessionFork } from './session-fork.js';
import { SessionDetach } from './session-detach.js';
import { ForumSetup } from './forum-setup.js';
import { PromptAdmission } from './prompt-admission.js';
import { BotStatus } from './status.js';
import type { Bot, Context } from 'grammy';
import type { AbortController as TelegramAbortController } from 'abort-controller';
import type { BotOptions } from '../bot.js';
import { SkillPicker } from '../skill-picker.js';
import { composeInputRouter } from './router-composition.js';
import type { BotInput } from './input.js';

export interface LifecycleDependencies {
 id(): number; stopped(): boolean; apiAbort: TelegramAbortController;
 applyTermination(): Promise<void>; clearTermination(): void;
 invalidateSession(sessionId: string, reason?: string): void;
}

export interface BotComponents {
  maintenance: BotMaintenance;
  authorization: BotAuthorization;
  connections: SessionConnections;
  owners: TopicMetadataOwners;
  recovery: MirrorRecovery;
  menus: BotCommandMenus;
  questions: BotQuestions;
  presets: BotPresets;
  capacity: CapacityAdmission;
  entries: SessionEntries;
  admission: PromptAdmission;
  input: BotInput;
}

/** Each owner receives only its operational dependencies; closures preserve live lifecycle state. */
export function createBotComponents(options: BotOptions, bot: Bot<Context>, lifecycle: LifecycleDependencies): BotComponents {
  const maintenance: BotMaintenance = new BotMaintenance({
    bot: bot,
    config: options.config,
    store: options.store,
    runtime: options.runtime,
    botId: lifecycle.id.bind(lifecycle),
    stopped: lifecycle.stopped.bind(lifecycle),
    restoreSessions: () => recovery.restoreSessions(),
    sessionAssigned: (session) => authorization.sessionAssigned(session),
    sendInitial: (session) => receipts.sendInitial(session),
    refreshTopicStatus: (session) => activity.refreshTopicStatus(session),
    recoverExistingMirror: (session) => recovery.recoverExistingMirror(session),
    dropListener: (id) => connections.dropListener(id),
    refreshPresetCatalogs: () => presets.refreshPresetCatalogs(),
    sessionObservation: (id) => recovery.sessionObservation(id),
    syncCommandMenus: () => menus.syncCommandMenus(),
  });
  const authorization: BotAuthorization = new BotAuthorization({
    bot: bot,
    config: options.config,
    store: options.store,
    runtime: options.runtime,
    botId: lifecycle.id.bind(lifecycle),
    stopped: lifecycle.stopped.bind(lifecycle),
    signal: maintenance.background.signal,
  });
  const connections: SessionConnections = new SessionConnections({
    applySessionTitle: (session) => titles.applySessionTitle(session),
    background: maintenance.background.signal,
    bot: bot,
    get id() { return lifecycle.id(); },
    cancelReconnect: (id) => recovery.cancelReconnect(id),
    endListenerQuestions: (listener) => questions.endForListener(listener),
    invalidateActivity: (id) => owners.invalidateActivity(id),
    onFrame: (session, listener, frame, replay) => frames.onFrame(session, listener, frame, replay),
    refreshTyping: (session, listener) => typing.refreshTyping(session, listener),
    requestCapacity: (session, limit) => capacity.requestCapacity(session, limit),
    requireSessionAssignment: authorization.requireSessionAssignment.bind(authorization),
    scheduleReconnect: (session, attempt) => recovery.scheduleReconnect(session, attempt),
    sessionAssigned: authorization.sessionAssigned.bind(authorization),
    sessionObservation: (id) => recovery.sessionObservation(id),
    setTopicStatus: (session, status, completed) => activity.setTopicStatus(session, status, completed),
    stopped: lifecycle.stopped.bind(lifecycle),
    options: options,
  });
  const owners: TopicMetadataOwners = new TopicMetadataOwners({
    options: options,
    bot: bot,
    delivery: connections.delivery,
    background: maintenance.background,
    isStopped: lifecycle.stopped.bind(lifecycle),
    sessionAssigned: authorization.sessionAssigned.bind(authorization),
    sessionObservation: (id) => recovery.sessionObservation(id),
  });
  const titles: TopicTitles = new TopicTitles(owners.deps, owners, id => connections.listeners.get(id));
  const activity: TopicActivityMonitor = new TopicActivityMonitor(owners.deps, owners, titles, {
    getListener: connections.listeners.get.bind(connections.listeners),
    dropListener: connections.dropListener.bind(connections),
    clearSessionRequests: (id) => { capacity.invalidateSession(id); admission.invalidateProposals(id); },
    runBackground: maintenance.runBackground.bind(maintenance),
  });
  const recovery: MirrorRecovery = new MirrorRecovery({
    background: maintenance.background.signal,
    bot: bot,
    dropListener: connections.dropListener.bind(connections),
    get id() { return lifecycle.id(); },
    getListener: connections.listeners.get.bind(connections.listeners),
    currentMetadataOwner: owners.metadataOwners.get.bind(owners.metadataOwners),
    listen: connections.listen.bind(connections),
    metadataOwner: owners.metadataOwner.bind(owners),
    refreshTopicStatus: activity.refreshTopicStatus.bind(activity),
    runBackground: maintenance.runBackground.bind(maintenance),
    sendInitial: (session) => receipts.sendInitial(session),
    sessionAssigned: authorization.sessionAssigned.bind(authorization),
    stopped: lifecycle.stopped.bind(lifecycle),
    options: options,
  });
  const receipts: PromptReceipts = new PromptReceipts({
    authorize: authorization.authorize.bind(authorization),
    background: maintenance.background.signal,
    bot: bot,
    delivery: connections.delivery,
    getListener: connections.listeners.get.bind(connections.listeners),
    listen: connections.listen.bind(connections),
    requireSessionAssignment: authorization.requireSessionAssignment.bind(authorization),
    sessionAssigned: authorization.sessionAssigned.bind(authorization),
    sessionObservation: recovery.sessionObservation.bind(recovery),
    stopped: lifecycle.stopped.bind(lifecycle),
    options: options,
  });
  const typing: TypingIndicators = new TypingIndicators({
    activityAtUse: owners.activityAtUse.bind(owners),
    bot: bot,
    delivery: connections.delivery,
    get id() { return lifecycle.id(); },
    getListener: connections.listeners.get.bind(connections.listeners),
    sessionAssigned: authorization.sessionAssigned.bind(authorization),
    stopped: lifecycle.stopped.bind(lifecycle),
    options: options,
  });
  const frames: FrameProjection = new FrameProjection({
    acknowledgeMessage: receipts.acknowledgeMessage.bind(receipts),
    activityObservation: owners.activityObservation.bind(owners),
    authorizeInitial: receipts.authorizeInitial.bind(receipts),
    background: maintenance.background.signal,
    bot: bot,
    delivery: connections.delivery,
    dropListener: connections.dropListener.bind(connections),
    getListener: connections.listeners.get.bind(connections.listeners),
    currentMetadataOwner: owners.metadataOwners.get.bind(owners.metadataOwners),
    endRequestQuestions: (listener, reqId) => questions.endForRequest(listener, reqId),
    promptHelp: authorization.promptHelp.bind(authorization),
    ready: authorization.ready.bind(authorization),
    reconcilePromptReceipt: receipts.reconcilePromptReceipt.bind(receipts),
    refreshTyping: typing.refreshTyping.bind(typing),
    relayQuestion: (session, listener, request) => questions.relayQuestion(session, listener, request),
    sendPrompt: receipts.sendPrompt.bind(receipts),
    sessionAssigned: authorization.sessionAssigned.bind(authorization),
    sessionObservation: recovery.sessionObservation.bind(recovery),
    setTopicStatus: activity.setTopicStatus.bind(activity),
    stopped: lifecycle.stopped.bind(lifecycle),
    syncTopicTitle: titles.syncTopicTitle.bind(titles),
    options: options,
  });
  const menus: BotCommandMenus = new BotCommandMenus({
    bot: bot,
    config: options.config,
    store: options.store,
    signal: lifecycle.apiAbort.signal,
    botId: lifecycle.id.bind(lifecycle),
    stopped: lifecycle.stopped.bind(lifecycle),
    presetDescription: (instanceId) => presets.presetDescription(instanceId),
  });
  const skills: SkillPicker = new SkillPicker({
    store: options.store, botId: lifecycle.id.bind(lifecycle), username: () => bot.botInfo!.username,
    authorize: authorization.authorize.bind(authorization),
    instanceId: chatId => authorization.assignedId(chatId), cwd: authorization.assignedCwd.bind(authorization),
    listSkills: options.runtime.listSkills.bind(options.runtime),
  });
  const questions: BotQuestions = new BotQuestions({
    api: bot.api,
    delivery: connections.delivery,
    store: options.store,
    botId: lifecycle.id.bind(lifecycle),
    stopped: lifecycle.stopped.bind(lifecycle),
    listener: connections.listeners.get.bind(connections.listeners),
    sessionAssigned: authorization.sessionAssigned.bind(authorization),
    requireSessionAssignment: authorization.requireSessionAssignment.bind(authorization),
    authorize: authorization.authorize.bind(authorization),
    dropListener: connections.dropListener.bind(connections),
    ready: authorization.ready.bind(authorization),
  });
  const folders: FolderSelection = new FolderSelection({
    botId: lifecycle.id.bind(lifecycle),
    config: options.config,
    assignedId: authorization.assignedId.bind(authorization),
    authorize: authorization.authorize.bind(authorization),
    currentAdmin: authorization.currentAdmin.bind(authorization),
    admissionEpoch: () => admission.epoch,
    stopped: lifecycle.stopped.bind(lifecycle),
  });
  const panelStore: SettingsPanelStore = new SettingsPanelStore({
    id: lifecycle.id.bind(lifecycle),
    api: bot.api,
    config: options.config,
    store: options.store,
    configWritable: options.configWritable,
    authorize: authorization.authorize.bind(authorization),
    assignedId: authorization.assignedId.bind(authorization),
  });
  const settings: SettingsPanels = new SettingsPanels({
    id: lifecycle.id.bind(lifecycle),
    api: bot.api,
    config: options.config,
    runtime: options.runtime,
    panels: panelStore,
    assignedId: authorization.assignedId.bind(authorization),
    currentAdmin: authorization.currentAdmin.bind(authorization),
    syncCommandMenus: menus.syncCommandMenus.bind(menus),
  });
  const presets: BotPresets = new BotPresets({
    get botId() { return lifecycle.id(); },
    api: bot.api,
    config: options.config,
    store: options.store,
    runtime: options.runtime,
    isStopped: lifecycle.stopped.bind(lifecycle),
    catalogSignal: () => maintenance.catalogRefresh.signal,
    runBackground: maintenance.runBackground.bind(maintenance),
    syncCommandMenus: menus.syncCommandMenus.bind(menus),
    requireSessionAssignment: authorization.requireSessionAssignment.bind(authorization),
    assignedId: authorization.assignedId.bind(authorization),
    settingsAccess: panelStore.access.bind(panelStore),
    authorize: authorization.authorize.bind(authorization),
    currentAdmin: authorization.currentAdmin.bind(authorization),
  });
  const preparation: PromptPreparation = new PromptPreparation({
    options: options,
    bot: bot,
    token: options.token,
    id: lifecycle.id.bind(lifecycle),
    stopped: lifecycle.stopped.bind(lifecycle),
    authorize: authorization.authorize.bind(authorization),
    currentAdmin: authorization.currentAdmin.bind(authorization),
    requireSessionAssignment: authorization.requireSessionAssignment.bind(authorization),
    dropListener: connections.dropListener.bind(connections),
  });
  const capacity: CapacityAdmission = new CapacityAdmission({
    options: options,
    bot: bot,
    id: lifecycle.id.bind(lifecycle),
    stopped: lifecycle.stopped.bind(lifecycle),
    epoch: () => admission.epoch,
    currentAdmin: authorization.currentAdmin.bind(authorization),
    authorize: authorization.authorize.bind(authorization),
    sessionAssigned: authorization.sessionAssigned.bind(authorization),
    assignedId: authorization.assignedId.bind(authorization),
    localCliCommand: () => setup.localCliCommand(),
    folderSettings: folders.folderSettings.bind(folders),
    listen: async (session) => { await connections.listen(session); },
    sendInitial: receipts.sendInitial.bind(receipts),
    routePrompt: (ctx, content, session, extensions, worktree, skills, cwd) => admission.routePrompt(ctx, content, session, extensions, worktree, skills, cwd),
  });
  const entries: SessionEntries = new SessionEntries({
    options: options,
    bot: bot,
    get id() { return lifecycle.id(); },
    sessionAssigned: authorization.sessionAssigned.bind(authorization),
    requireSessionAssignment: authorization.requireSessionAssignment.bind(authorization),
    allMessagesArePrompts: authorization.allMessagesArePrompts.bind(authorization),
  });
  const creation: TopicCreation = new TopicCreation({
    options: options,
    bot: bot,
    get id() { return lifecycle.id(); },
    get admissionEpoch() { return admission.epoch; },
    get stopped() { return lifecycle.stopped(); },
    authorize: authorization.authorize.bind(authorization),
    currentAdmin: authorization.currentAdmin.bind(authorization),
    folderSettings: folders.folderSettings.bind(folders),
    assignedId: authorization.assignedId.bind(authorization),
    assignedCwd: authorization.assignedCwd.bind(authorization),
    chooseFolder: folders.chooseFolder.bind(folders),
    getIconIds: owners.getIconIds.bind(owners),
    createsTopicWorktrees: authorization.createsTopicWorktrees.bind(authorization),
    createTopicWorktree: preparation.createTopicWorktree.bind(preparation),
    requireSessionAssignment: authorization.requireSessionAssignment.bind(authorization),
    preparePrompt: preparation.preparePrompt.bind(preparation),
    skillKey: skills.key.bind(skills),
    defaultNewTopicSkill: preparation.defaultNewTopicSkill.bind(preparation),
    // Input routing needs this owner first; resolve album membership only during dispatch.
    albumContexts: ctx => input.albumContexts(ctx),
    announce: entries.announce.bind(entries),
    setTopicStatus: activity.setTopicStatus.bind(activity),
    listen: connections.listen.bind(connections),
    sendInitial: receipts.sendInitial.bind(receipts),
  });
  const fork: SessionFork = new SessionFork({
    options: options,
    bot: bot,
    get id() { return lifecycle.id(); },
    get admissionEpoch() { return admission.epoch; },
    get stopped() { return lifecycle.stopped(); },
    authorize: authorization.authorize.bind(authorization),
    currentAdmin: authorization.currentAdmin.bind(authorization),
    requireSessionAssignment: authorization.requireSessionAssignment.bind(authorization),
    defaultNewTopicSkill: preparation.defaultNewTopicSkill.bind(preparation),
    createsTopicWorktrees: authorization.createsTopicWorktrees.bind(authorization),
    createTopicWorktree: preparation.createTopicWorktree.bind(preparation),
    announce: entries.announce.bind(entries),
    listen: connections.listen.bind(connections),
    dropListener: connections.dropListener.bind(connections),
  });
  const detach: SessionDetach = new SessionDetach({
    options: options,
    bot: bot,
    get id() { return lifecycle.id(); },
    get stopped() { return lifecycle.stopped(); },
    delivery: connections.delivery,
    apiAbort: lifecycle.apiAbort,
    clearClosedSession: owners.closedSessions.delete.bind(owners.closedSessions),
    clearCapacityRequests: capacity.invalidateSession.bind(capacity),
    clearPromptProposals: (sessionId) => admission.invalidateProposals(sessionId),
    invalidateSession: lifecycle.invalidateSession.bind(lifecycle),
    dropListener: connections.dropListener.bind(connections),
    iconCompletion: (sessionId) => owners.metadataOwners.get(sessionId)?.metadata?.icon.completion,
    disposeMetadataOwner: owners.disposeMetadataOwner.bind(owners),
  });
  const setup: ForumSetup = new ForumSetup({
    options: options,
    bot: bot,
    get id() { return lifecycle.id(); },
    ready: authorization.ready.bind(authorization),
    currentAdmin: authorization.currentAdmin.bind(authorization),
    assignedId: authorization.assignedId.bind(authorization),
    openSettings: settings.open.bind(settings),
  });
  const admission: PromptAdmission = new PromptAdmission({
    options: options,
    id: lifecycle.id.bind(lifecycle),
    stopped: lifecycle.stopped.bind(lifecycle),
    capacity: capacity,
    currentAdmin: authorization.currentAdmin.bind(authorization),
    authorize: authorization.authorize.bind(authorization),
    sessionAssigned: authorization.sessionAssigned.bind(authorization),
    requireSessionAssignment: authorization.requireSessionAssignment.bind(authorization),
    assignedId: authorization.assignedId.bind(authorization),
    assignedCwd: authorization.assignedCwd.bind(authorization),
    usersCanProposePrompts: authorization.usersCanProposePrompts.bind(authorization),
    allMessagesArePrompts: authorization.allMessagesArePrompts.bind(authorization),
    folderSettings: folders.folderSettings.bind(folders),
    chooseFolder: folders.chooseFolder.bind(folders),
    skillKey: skills.key.bind(skills),
    defaultNewTopicSkill: preparation.defaultNewTopicSkill.bind(preparation),
    renderPresetPanel: presets.renderPresetPanel.bind(presets),
    replyPresetText: presets.replyPresetText.bind(presets),
    preparePrompt: preparation.preparePrompt.bind(preparation),
    newSession: creation.newSession.bind(creation),
    listen: async (session) => { await connections.listen(session); },
    listener: connections.listeners.get.bind(connections.listeners),
    // Admission is constructed before input routing; do not bind an uninitialized owner.
    albumContexts: ctx => input.albumContexts(ctx),
    sendPrompt: receipts.sendPrompt.bind(receipts),
  });
  const status: BotStatus = new BotStatus({
    config: options.config,
    store: options.store,
    runtime: options.runtime,
    recoveryConnections: connections,
    recovery: recovery,
    maintenance: maintenance,
    botId: lifecycle.id.bind(lifecycle),
    ready: authorization.ready.bind(authorization),
    authorize: authorization.authorize.bind(authorization),
    assignedId: authorization.assignedId.bind(authorization),
    sessionObservation: recovery.sessionObservation.bind(recovery),
  });
  const { input }: { input: BotInput } = composeInputRouter({ options, bot, lifecycle, skills, questions, admission, authorization, capacity, folders, settings, presets, panelStore, setup, status, entries, titles, owners, preparation, connections, activity, maintenance, recovery, detach, menus, fork, creation, receipts });
  return { maintenance, authorization, connections, owners, recovery, menus, questions, presets, capacity, entries, admission, input };
}
