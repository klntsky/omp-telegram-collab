import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { GuestFrame } from '@oh-my-pi/pi-wire';

const userSchema = z.object({ id: z.number().int().positive().safe(), first_name: z.string().min(1).max(256), last_name: z.string().max(256).optional(), username: z.string().max(256).optional(), is_bot: z.boolean().optional() }).passthrough();
export interface InitData { user: z.infer<typeof userSchema>; authDate: number; startParam: string }
export function validateInitData(raw: string, token: string, options: { now?: number; maxAgeSeconds?: number } = {}): InitData {
  if (typeof raw !== 'string' || raw.length > 32768) throw new Error('Invalid Telegram authentication');
  const params = new URLSearchParams(raw);
  const seen = new Set<string>();
  for (const [key] of params) { if (seen.has(key)) throw new Error('Duplicate authentication field'); seen.add(key); }
  const hash = params.get('hash');
  if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) throw new Error('Invalid Telegram authentication');
  const check = [...params].filter(([key]) => key !== 'hash').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw new Error('Invalid Telegram authentication');
  const date = params.get('auth_date');
  if (!date || !/^\d+$/.test(date)) throw new Error('Invalid authentication date');
  const authDate = Number(date);
  const now = (options.now ?? Date.now()) / 1000;
  if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > (options.maxAgeSeconds ?? 3600)) throw new Error('Expired Telegram authentication');
  const user = userSchema.parse(JSON.parse(params.get('user') ?? 'null'));
  if (user.is_bot) throw new Error('Bot accounts cannot authenticate');
  const startParam = params.get('start_param');
  if (!startParam || !/^s_[A-Za-z0-9_-]{22}$/.test(startParam)) throw new Error('Invalid session start parameter');
  return { user, authDate, startParam };
}

export function isActiveMember(member: unknown): boolean {
  if (!member || typeof member !== 'object') return false;
  const value = member as { status?: string; is_member?: boolean; user?: { is_bot?: boolean } };
  return value.user?.is_bot !== true && (value.status === 'creator' || value.status === 'administrator' || value.status === 'member' || (value.status === 'restricted' && value.is_member === true));
}
export function isAdministrator(member: unknown): boolean {
  return Boolean(member && typeof member === 'object' && 'status' in member && ['creator', 'administrator'].includes(String(member.status)));
}
const text = z.string().min(1).max(65536);
const image = z.object({ type: z.literal('image'), data: z.string().min(1).max(1400000).regex(/^[A-Za-z0-9+/]*={0,2}$/), mimeType: z.enum(['image/png','image/jpeg','image/gif','image/webp']) }).strict();
const guestSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('prompt'), text, images: z.array(image).max(4).optional() }).strict(),
  z.object({ t: z.literal('abort') }).strict(),
  z.object({ t: z.literal('agent-cmd'), cmd: z.enum(['chat','kill','revive']), agentId: z.string().min(1).max(256), text: text.optional() }).strict(),
  z.object({ t: z.literal('fetch-transcript'), reqId: z.number().int().nonnegative().safe(), agentId: z.string().min(1).max(256), fromByte: z.number().int().nonnegative().safe() }).strict(),
  z.object({ t: z.literal('ui-response'), reqId: z.number().int().nonnegative().safe(), value: z.string().max(65536).optional() }).strict(),
]).refine(value => value.t !== 'agent-cmd' || value.cmd !== 'chat' || value.text !== undefined);
export function validateGuestFrame(value: unknown): Exclude<GuestFrame, {t:'hello'}> {
  return guestSchema.parse(value) as Exclude<GuestFrame, {t:'hello'}>;
}
export interface TicketIdentity { botId: number; sessionId: string; userId: number; displayName: string; authDate: number }
export class TicketStore {
  private readonly tickets = new Map<string, { identity: TicketIdentity; expires: number }>();
  issue(identity: TicketIdentity, now = Date.now()): string {
    for (const [key, value] of this.tickets) if (value.expires <= now) this.tickets.delete(key);
    if (this.tickets.size >= 10000) throw new Error('Too many pending connections');
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { identity, expires: now + 60000 });
    return ticket;
  }
  consume(ticket: string, now = Date.now()): TicketIdentity | undefined {
    const value = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return value && value.expires > now ? value.identity : undefined;
  }
}
