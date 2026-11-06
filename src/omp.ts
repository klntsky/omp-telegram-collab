import type { ChildProcess } from 'node:child_process';
import type { HostFrame, SessionState } from '@oh-my-pi/pi-wire';
import type { CollabConnection, CollabHandlers, HostBinding, TopicSession } from '../shared/contracts.js';
import type { HistorySource, HistoryWatch, HistoryWatchOptions } from './history-watch.js';

export interface WorktreeTarget {
  path: string;
  gitDir: string;
  commonDir: string;
  sessionId: string;
  identities: {
    directory: { dev: number; ino: number };
    gitDir: { dev: number; ino: number };
    commonDir: { dev: number; ino: number };
  };
}

export interface WorktreeCleanupGuard {
  assertCurrent(): void;
  beforeMutation(): Promise<void>;
}

export interface Omp {
  connectCollab(binding: HostBinding, name: string, handlers: CollabHandlers, signal?: AbortSignal): Promise<CollabConnection>;
  readCollabState(binding: HostBinding, name: string, signal?: AbortSignal): Promise<SessionState>;
  watchHistory(source: HistorySource, options?: HistoryWatchOptions): Promise<HistoryWatch>;
  joinTerminal(executable: string, url: string): ChildProcess;
  fork(source: TopicSession, destination: TopicSession, target?: {ompSessionId:string;entryId:string;parentEntryId:string|null;kind:'assistant'|'collab-prompt'}, beforeMutation?: () => Promise<void>): Promise<void>;
  existingBinding(session: TopicSession): Promise<{sessionId:string} | undefined>;
  worktree(session: TopicSession, branch?: string, beforeMutation?: () => Promise<void>): Promise<string>;
  topicTitleStatus(session: TopicSession): Promise<{worktree: boolean; branch?: string}>;
  inspectWorktree(session: TopicSession): Promise<WorktreeTarget | undefined>;
  deleteWorktree(session: TopicSession, target: WorktreeTarget, guard: WorktreeCleanupGuard): Promise<void>;
  ensure(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<HostBinding>;
  reserveSession(sessionId?: string, beforeMutation?: () => Promise<void>): Promise<{bind(id: string): void; release(): void}>;
  /** Resolves an existing host without preparing one; undefined means confirmed absence. */
  resolveExisting(session: TopicSession): Promise<HostBinding | undefined>;
  historySource(session: TopicSession): Promise<{sessionId: string; path: string} | undefined>;
  isRunning(session: TopicSession): Promise<boolean>;
  setSessionTitle(session: TopicSession, title: string): Promise<void>;
  attach(hostId: string, cwd: string): Promise<HostBinding>;
  stop(session: TopicSession): Promise<boolean>;
  kill(session: TopicSession): Promise<void>;
  modelPresets(session: TopicSession, name?: string): Promise<string>;
  availableModelPresets(instanceId: number, discoveryCwd?: string): Promise<string[]>;
  modelPresetDetails(instanceId: number, name: string, discoveryCwd?: string): Promise<{modelRoles: Record<string, string>; defaultThinkingLevel?: string}>;
  providerUsage(instanceId: number): Promise<{ heading: string; table: string }[]>;
  listSkills(instanceId: number, session?: TopicSession, signal?: AbortSignal, discoveryCwd?: string): Promise<{name: string; description: string}[]>;
  getSessionLimit(): number;
  setSessionLimit(limit: number): void;
  increaseSessionLimit(expectedLimit: number): boolean;
  observeFrame(sessionId: string, frame: HostFrame): void;
  markPrompt(sessionId: string): void;
  retain(sessionId: string): () => void;
  close(): Promise<void>;
}
