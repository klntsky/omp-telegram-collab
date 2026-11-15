export type WorktreeCleanupCallback =
  | { action: 'offer'; sessionId: string }
  | { action: 'confirm' | 'cancel'; sessionId: string; adminIdBase36: string; mac: string };

// Telegram callback_data, not slash commands:
// wtcleanup:o:<sessionId> or wtcleanup:<c|x>:<sessionId>:<adminIdBase36>:<mac>.
// Compact tags keep a 52-bit administrator ID and 96-bit MAC below 64 bytes.
export function decodeWorktreeCleanupCallback(data: string): WorktreeCleanupCallback | undefined {
  const offer = /^wtcleanup:o:([A-Za-z0-9_-]{22})$/.exec(data);
  if (offer) return { action: 'offer', sessionId: offer[1]! };
  const approval = /^wtcleanup:(c|x):([A-Za-z0-9_-]{22}):([0-9a-z]{1,11}):([A-Za-z0-9_-]{16})$/.exec(data);
  if (!approval) return undefined;
  const [, action, sessionId, adminIdBase36, mac] = approval;
  return {
    action: action === 'c' ? 'confirm' : 'cancel',
    sessionId: sessionId!, adminIdBase36: adminIdBase36!, mac: mac!,
  };
}

export function encodeWorktreeCleanupCallback(data: WorktreeCleanupCallback): string {
  return data.action === 'offer' ? `wtcleanup:o:${data.sessionId}`
    : `wtcleanup:${data.action === 'confirm' ? 'c' : 'x'}:${data.sessionId}:${data.adminIdBase36}:${data.mac}`;
}
