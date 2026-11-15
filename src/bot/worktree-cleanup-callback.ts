export type WorktreeCleanupCallback =
  | { action: 'offer'; sessionId: string }
  | { action: 'confirm' | 'cancel'; sessionId: string; token: string };

// Telegram callback_data, not slash commands:
// wtcleanup:o:<sessionId> or wtcleanup:<c|x>:<sessionId>:<opaque token>.
export function decodeWorktreeCleanupCallback(data: string): WorktreeCleanupCallback | undefined {
  const offer = /^wtcleanup:o:([A-Za-z0-9_-]{22})$/.exec(data);
  if (offer) return { action: 'offer', sessionId: offer[1]! };
  const approval = /^wtcleanup:(c|x):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{16})$/.exec(data);
  if (!approval) return undefined;
  const [, action, sessionId, token] = approval;
  return {
    action: action === 'c' ? 'confirm' : 'cancel',
    sessionId: sessionId!, token: token!,
  };
}

export function encodeWorktreeCleanupCallback(data: WorktreeCleanupCallback): string {
  return data.action === 'offer' ? `wtcleanup:o:${data.sessionId}`
    : `wtcleanup:${data.action === 'confirm' ? 'c' : 'x'}:${data.sessionId}:${data.token}`;
}
