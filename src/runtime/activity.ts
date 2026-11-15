import type { HostFrame } from '@oh-my-pi/pi-wire';
import { miniAppInterruptionAuthor } from '../../shared/interruption.js';
import { type ManagedHost, type HostActivity } from './types.js';
interface ActivityDependencies {
  assertActive(): void;
  readonly managed: Map<string, ManagedHost | null>;
  readonly stopping: Map<string, Promise<void>>;
}

// Leases and turn observations share one activity record per native host.
export interface RuntimeActivity {
  hostActivity(id: string): HostActivity;
  retain(id: string): () => void;
  markPrompt(id: string): void;
  observeFrame(id: string, frame: HostFrame): void;
  forget(id: string): void;
}

export function createActivity(deps: ActivityDependencies): RuntimeActivity {
  const activities = new Map<string, HostActivity>();
  function hostActivity(id: string): HostActivity {
    let activity = activities.get(id);
    if (!activity) {
      activity = { busy: false, awaitingTurn: false, leases: 0, lastUsed: Date.now() };
      activities.set(id,activity);
    }
    return activity;
  }

  function retain(id: string): () => void {
    deps.assertActive();
    if (deps.managed.get(id)?.retiring || deps.stopping.has(id)) throw new Error('Session is retiring; rejoin after it settles');
    const activity = hostActivity(id);
    activity.leases++;
    activity.lastUsed = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activity.leases--;
      activity.lastUsed = Date.now();
    };
  }

  function markPrompt(id: string): void {
    deps.assertActive();
    if (deps.managed.get(id)?.retiring || deps.stopping.has(id)) throw new Error('Session is retiring; resend after it settles');
    const activity = hostActivity(id);
    activity.busy = true;
    activity.awaitingTurn = true;
    activity.lastUsed = Date.now();
  }

  function observeFrame(id: string, frame: HostFrame): void {
    const activity = hostActivity(id);
    if (frame.t === 'event' && frame.event.type === 'agent_start') {
      activity.busy = true;
      activity.awaitingTurn = false;
    } else if ((frame.t === 'event' && (frame.event.type === 'agent_end' || miniAppInterruptionAuthor(frame.event))) || frame.t === 'error') {
      activity.busy = false;
      activity.awaitingTurn = false;
      activity.lastUsed = Date.now();
    } else if (frame.t === 'state' || frame.t === 'welcome') {
      activity.busy = activity.awaitingTurn || frame.state.isStreaming || frame.state.queuedMessageCount > 0;
      if (activity.busy) activity.lastUsed = Date.now();
    }
  }
  return { hostActivity, retain, markPrompt, observeFrame, forget: (id: string) => { activities.delete(id); } };
}

