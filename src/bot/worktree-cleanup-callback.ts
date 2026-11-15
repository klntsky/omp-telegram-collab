import { z } from 'zod';

const sessionId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const administratorId = z.string().regex(/^[0-9a-z]{1,11}$/);
const mac = z.string().regex(/^[A-Za-z0-9_-]{16}$/);

// These are Telegram callback_data fields, not slash commands. Compact action tags
// keep the session ID, base-36 administrator ID, and 96-bit MAC below 64 bytes.
const offer = z.tuple([z.literal('wtcleanup'), z.literal('o'), sessionId])
  .transform(([, , sessionId]) => ({ action: 'offer' as const, sessionId }));
const approval = z.tuple([z.literal('wtcleanup'), z.enum(['c', 'x']), sessionId, administratorId, mac])
  .transform(([, action, sessionId, adminIdBase36, mac]) => ({
    action: action === 'c' ? 'confirm' as const : 'cancel' as const,
    sessionId, adminIdBase36, mac,
  }));
const callback = z.union([offer, approval]);

export type WorktreeCleanupCallback = z.infer<typeof callback>;

export function decodeWorktreeCleanupCallback(data: string): WorktreeCleanupCallback | undefined {
  const parsed = callback.safeParse(data.split(':'));
  return parsed.success ? parsed.data : undefined;
}

export function encodeWorktreeCleanupCallback(data: WorktreeCleanupCallback): string {
  return data.action === 'offer' ? `wtcleanup:o:${data.sessionId}`
    : `wtcleanup:${data.action === 'confirm' ? 'c' : 'x'}:${data.sessionId}:${data.adminIdBase36}:${data.mac}`;
}
