import type { AgentEvent } from '@oh-my-pi/pi-wire';

export function miniAppInterruptionAuthor(event: AgentEvent): string | undefined {
  if (event.type !== 'notice' || event.level !== 'info' || event.source !== 'collab') return undefined;
  return /^(@[A-Za-z0-9_]+|user ID [0-9]+) interrupted$/.exec(event.message)?.[1];
}
