import type { GuestFrame, HostFrame, ImageContent } from '@oh-my-pi/pi-wire';

export interface PromptContent {
  text: string;
  images?: ImageContent[];
}

export interface BotConfig {
  id: number;
  token: string;
  miniAppShortName?: string;
}

export interface InstanceConfig {
  chats: { botId: number; chatId: number; all_messages_are_prompts?: boolean; users_can_propose_prompts?: boolean; create_topic_worktrees?: boolean; default_model_preset?: string; default_new_topic_skill?: string }[];
}

export interface AppConfig {
  terminated?: boolean;
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
  runtime: { kind: 'managed'; worktreePath?: string } | { kind: 'attached'; instanceId: string; sessionId: string };
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
