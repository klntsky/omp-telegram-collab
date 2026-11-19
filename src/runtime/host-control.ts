import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, HostBinding, TopicSession } from '../../shared/contracts.js';
import { SessionTitleUnsupportedError, SessionRetiringError, type DurableBinding, type ManagedHost, type HostLifecycle } from './types.js';
import { launchProcess } from './launch-record.js';
import { requestLifecycle } from './lifecycle-client.js';

interface HostControlDependencies {
  readonly config: AppConfig;
  assertActive(): void;
  readonly closed: boolean;
  readonly stopping: Map<string, Promise<void>>;
  isRunning(session: TopicSession): Promise<boolean>;
  retain(id: string): () => void;
  ensure(session: TopicSession, beforeMutation?: () => Promise<void>): Promise<HostBinding>;
  lifecycle(id: string): Promise<HostLifecycle | undefined>;
  readonly managed: Map<string, ManagedHost | null>;
  refreshConversation(session: TopicSession): Promise<void>;
}

export interface RuntimeHostControl {
  setSessionTitle(session: TopicSession, title: string): Promise<void>;
  modelPresets(session: TopicSession, name?: string): Promise<string>;
  hostControl(session: TopicSession, name: string | undefined, type: 'model_presets' | 'list_skills' | 'set_session_title'): Promise<string>;
}

export function createHostControl(deps: HostControlDependencies): RuntimeHostControl {
  async function setSessionTitle(session: TopicSession, title: string): Promise<void> {
    deps.assertActive();
    if (!title.trim()) throw new Error('OMP session title cannot be empty');
    if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
    if (session.runtime.kind === 'attached') throw new SessionTitleUnsupportedError('Session title control is unavailable for this attached OMP host. Rename it with /rename in its terminal; the native collab registry does not support renaming.');
    if (await deps.isRunning(session)) await hostControl(session, title, 'set_session_title');
  }

  async function hostControl(session: TopicSession, name: string | undefined, type: 'model_presets' | 'list_skills' | 'set_session_title'): Promise<string> {
    deps.assertActive();
    if (session.runtime.kind !== 'managed') throw new Error('Model preset control is unavailable for attached OMP hosts. Use a managed topic session or run /modelpreset in the attached host.');
    const release = deps.retain(session.id);
    try {
      const root = path.join(deps.config.dataDir, 'sessions', session.id);
      let sessionId: string;
      if (type === 'set_session_title') {
        await deps.refreshConversation(session);
        sessionId = (JSON.parse(await readFile(path.join(root, 'binding.json'), 'utf8')) as DurableBinding).sessionId;
      } else {
        sessionId = (await deps.ensure(session)).sessionId;
      }
      const host = await deps.lifecycle(session.id);
      if (type === 'set_session_title' && !host?.sessionTitles) throw new Error('OMP host does not support session title control. Retire this managed host and rejoin to load the updated lifecycle extension.');
      if (!host || host.modelPresets !== 2) throw new Error('OMP host does not support model preset control. Retire this managed host and rejoin to load the updated lifecycle extension.');
      const validate = async () => {
        deps.assertActive();
        if (deps.closed || deps.stopping.has(session.id)) throw new Error('OMP runtime is stopping');
        const current = await deps.lifecycle(session.id);
        if (!await launchProcess(root, host.pid) || current?.pid !== host.pid || current.sessionId !== sessionId || current.socketPath !== host.socketPath) throw new Error('OMP host identity changed during model preset control');
        if (current.retiring || deps.managed.get(session.id)?.retiring) throw new SessionRetiringError('Session is retiring; rejoin after it settles');
      };
      await validate();
      const response = await requestLifecycle(host, { type, requestId: randomUUID(), sessionId, name, deadline: Date.now() + 15000 });
      if (typeof response.error === 'string') throw new Error(response.error);
      if (typeof response.text !== 'string') throw new Error('Invalid OMP model preset response');
      await validate();
      return response.text;
    } finally { release(); }
  }

  return { setSessionTitle, modelPresets: (session, name) => hostControl(session, name, 'model_presets'), hostControl };
}
