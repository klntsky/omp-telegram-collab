import type { GuestFrame, HostFrame } from '@oh-my-pi/pi-wire';

export interface BotConfig {
  id: number;
  token: string;
  miniAppShortName: string;
}

export interface InstanceConfig {
  admins: string[];
  chats: { botId: number; chatId: number; all_messages_are_prompts?: boolean; users_can_propose_prompts?: boolean; default_model_preset?: string }[];
}

export interface AppConfig {
  bots: BotConfig[];
  instances: Record<string, InstanceConfig>;
  publicUrl: string;
  host: string;
  port: number;
  dataDir: string;
  configPath: string;
  omp: {
    executable: string;
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
  instancePath: string;
  name: string;
  status: 'open' | 'closed' | 'detached';
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
