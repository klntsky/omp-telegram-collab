import type { GuestFrame, HostFrame } from '@oh-my-pi/pi-wire';

export interface BotConfig {
  tokenEnv: string;
  ownerUsernames: string[];
  miniAppShortName: string;
}

export interface AppConfig {
  bots: BotConfig[];
  publicUrl: string;
  host: string;
  port: number;
  dataDir: string;
  omp: {
    executable: string;
    cwd: string;
    args: string[];
    maxSessions: number;
    startupTimeoutMs: number;
    relayUrl?: string;
  };
}

export interface TopicKey {
  botId: number;
  chatId: number;
  threadId: number;
}

export interface TopicSession extends TopicKey {
  id: string;
  name: string;
  status: 'open' | 'closed';
  runtime: { kind: 'managed' } | { kind: 'attached'; instanceId: string; sessionId: string };
  createdAt: number;
}

export interface HostBinding {
  instanceId: string;
  sessionId: string;
  generation: number;
  url: string;
}

export interface CollabConnection {
  send(frame: GuestFrame): void;
  close(): void;
}

export interface CollabHandlers {
  onFrame(frame: HostFrame): void;
  onClose(reason: string): void;
}
