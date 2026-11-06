import { type ChildProcess } from 'node:child_process';
import type { HostBinding } from '../../shared/contracts.js';
export class SessionCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`OMP session limit (${limit}) reached. Ask in the topic to approve more capacity, then rejoin.`);
    this.name = 'SessionCapacityError';
  }
}

export class SessionTitleUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTitleUnsupportedError';
  }
}

export interface ForkTarget {
  ompSessionId: string;
  entryId: string;
  parentEntryId: string | null;
  kind: 'assistant' | 'collab-prompt';
}

export interface RegistryHost {
  instanceId: string;
  sessionId: string;
  generation: number;
  pid: number;
  cwd: string;
  access: 'view' | 'control';
  relayConnected: boolean;
  busy?: boolean;
}

export interface DurableBinding {
  version: 1;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  removedWorktree?: {
    path: string;
    gitDir: string;
    commonDir: string;
    directory: { dev: number; ino: number };
  };
}

export interface ManagedHost {
  process?: ChildProcess;
  binding?: HostBinding;
  sessionId: string;
  cwd?: string;
  identity?: { pid: number; start: string };
  exited: boolean;
  retiring: boolean;
  failure?: string;
  retirement?: { pid: number; start: string; socketPath: string; error?: unknown };
}

export interface HostActivity { busy: boolean; awaitingTurn: boolean; leases: number; lastUsed: number }

export interface HostLifecycle { pid: number; supervisorPid: number; sessionId: string; socketPath: string; retiring?: boolean; modelPresets?: 2; skills?: boolean; worktree?: boolean; sessionTitles?: boolean; retirement?: 1 }
