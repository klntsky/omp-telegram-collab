import type { Context } from 'grammy';
import type { CollabUiRequest } from '@oh-my-pi/pi-wire';
import type { TopicSession, CollabConnection, PromptContent, TypingMode } from '../../shared/contracts.js';
import type { PendingSkillKey } from '../store.js';
import type { TopicDestination } from '../../shared/topic-destination.js';
import type { PromptExtension } from '../telegram-commands.js';
import type { TopicWriter } from '../topic-writer.js';
import type { SessionFeed } from '../session-feed.js';
import type { SessionHistory } from '../session-history.js';

export class AuthorizationDeniedError extends Error {}

export type TopicActivity = 'unknown' | 'running' | 'finished';
export type KnownTopicActivity = Exclude<TopicActivity, 'unknown'>;
export interface TopicMetadata {
  generation: number;
  name: TopicWriter;
  icon: TopicWriter;
}
export interface TopicTitleSource {
  humanTitle?: string;
  prefix: string;
  prefixes: Set<string>;
  revision: number;
}
export interface HostActivityObservation {
  generation: number;
  value: TopicActivity;
  observedAt?: number;
  suspect: boolean;
  revision: number;
  probe?: Promise<void>;
  controller?: AbortController;
}
export interface SessionMetadataOwner {
  generation: number;
  disposed: boolean;
  controller: AbortController;
  activity: HostActivityObservation;
  title: TopicTitleSource;
  metadata?: TopicMetadata;
  recovery?: Promise<void>;
  titleWrite?: Promise<void>;
}
export interface StatusFailure { operation: string; at: number; error: unknown }
export interface TaskObservation {
  state:
    | 'waiting for acceptance'
    | 'not accepted'
    | 'acceptance unknown'
    | 'accepted; completion unknown';
  submissionId?: number;
}
export interface SessionObservation { task?: TaskObservation; failure?: StatusFailure; mirrored?: boolean }
export interface Listener {
  sessionId: string;
  generation: number;
  ompSessionId?: string;
  connection?: CollabConnection;
  promise?: Promise<CollabConnection>;
  feed: SessionFeed;
  history?: SessionHistory;
  readers: Set<{feed: SessionFeed; connection?: CollabConnection; controller: AbortController}>;
  tail: Promise<void>;
  queued: number;
  recovering: boolean;
  receiptBoundary: number;
  snapshotReplyTarget?: number;
  pendingPrompts: {
    submissionId: number;
    onStartupRejected?: () => void;
    observation: TaskObservation;
  }[];
  pendingAnswers: Map<number, number>;
  pendingStops: number[];
  queuedMessages: number;
  typingText?: boolean;
  typingNextAt?: number;
  typingTimer?: NodeJS.Timeout;
  initial?: {
    content: PromptContent;
    userId: number;
    authorityUserId: number;
    messageId?: number;
    deadline: number;
    retries: number;
    phase: 'sent' | 'retrying';
    timer?: NodeJS.Timeout;
  };
}
export interface PendingQuestion {
  session: TopicSession;
  listener: Listener;
  request: CollabUiRequest;
  messageIds: number[];
  buttonIds: number[];
  answer?: {kind:'answer' | 'discussion'; text:string};
}
export interface CapacityRequest {
  sessionId: string;
  chatId: number;
  threadId: number;
  messageId: number;
  limit: number;
  expires: number;
  command?: {source: Context; content: PromptContent; extensions: readonly PromptExtension[]; worktree: boolean; instanceId: number; epoch: number; generation?: number; skills: {names:string[];topicSkill?:string}; cwd?:string; folderFingerprint?:string};
}
export interface PromptProposal {
  source: Context;
  content: PromptContent;
  instanceId: number;
  sessionId?: string;
  folderFingerprint?: string;
  worktree?: boolean;
  generation?: number;
  allMessagesArePrompts: boolean;
  messageId: number;
  expires: number;
  skills?: {key:PendingSkillKey;names:string[];topicSkill?:string};
}
export type SettingsKey =
  | 'prompts'
  | 'proposals'
  | 'skills'
  | 'presets'
  | 'capacity'
  | 'worktrees'
  | 'folders'
  | 'typing';
export type SettingsPage = 'root' | 'skills' | 'presets' | 'capacity' | 'typing' | 'folders';
export type SettingsAction =
  | { kind: 'page'; page: SettingsPage; offset?: number }
  | {
      kind: 'set';
      field: 'all_messages_are_prompts' | 'users_can_propose_prompts' | 'create_topic_worktrees';
      value: boolean;
    }
  | { kind: 'default'; field: 'default_new_topic_skill' | 'default_model_preset'; value?: string }
  | { kind: 'typing'; field: 'typing_indicators'; value: TypingMode }
  | { kind: 'folders'; remove?: number; clear?: boolean; input?: 'append' | 'replace' }
  | { kind: 'close' };
export interface SettingsPanel {
  token: string;
  chatId: number;
  destination: TopicDestination;
  messageId: number;
  instanceId: number;
  revision: number;
  offset: number;
  choices: SettingsAction[];
  capacityInput?: boolean;
  changes: Map<SettingsKey, {label: string; before: string; after: string}>;
  folderInput?: 'append' | 'replace';
  folderInputEnded?: boolean;
}
export type PresetAction = {kind: 'select'; name: string} | {kind: 'page'; offset: number} | {kind: 'back' | 'use' | 'default' | 'cancel'};
export interface PresetPanel {
  token: string;
  chatId: number;
  destination: TopicDestination;
  messageId: number;
  instanceId: number;
  sessionId: string;
  generation: number;
  revision: number;
  expires: number;
  selected?: string;
  listOffset: number;
  detailOffset: number;
  choices: PresetAction[];
  continuation?: {
    kind: 'prompt';
    active: boolean;
    source: Context;
    cwd: string;
    check: () => void;
    resume: (name: string) => Promise<void>;
  };
}
