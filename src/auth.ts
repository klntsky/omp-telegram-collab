import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { GuestFrame } from '@oh-my-pi/pi-wire';

export class AuthorizationUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), {cause});
  }
}

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
  if (!member || typeof member !== 'object') return false;
  const value = member as { status?: string; user?: { is_bot?: boolean } };
  return value.user?.is_bot === false && (value.status === 'creator' || value.status === 'administrator');
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
export interface TicketIdentity { botId: number; sessionId: string; generation: number; userId: number; username?: string; displayName: string; authDate: number }
const credentialSchema = z.object({
  botId: z.number().int().positive().safe(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  generation: z.number().int().nonnegative().safe(),
  userId: z.number().int().positive().safe(),
  username: z.string().max(256).optional(),
  displayName: z.string().max(80),
  authDate: z.number().int().nonnegative().safe(),
}).strict();
function credentialSignature(payload: string, token: string): Buffer {
  return createHmac('sha256', token).update('omp-telegram-session-v1\0').update(payload).digest();
}
export function issueCredential(identity: TicketIdentity, token: string): string {
  const payload = Buffer.from(JSON.stringify(credentialSchema.parse(identity))).toString('base64url');
  return `${payload}.${credentialSignature(payload, token).toString('base64url')}`;
}
export function validateCredential(raw: string, token: string, botId: number, sessionId: string): TicketIdentity {
  if (typeof raw !== 'string' || raw.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(raw)) throw new Error('Invalid session credential');
  const [payload, signature] = raw.split('.') as [string, string];
  const actual = Buffer.from(signature, 'base64url');
  const expected = credentialSignature(payload, token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || actual.toString('base64url') !== signature) throw new Error('Invalid session credential');
  const identity = credentialSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  if (identity.botId !== botId || identity.sessionId !== sessionId) throw new Error('Invalid session credential');
  return identity;
}
export class TicketStore<T extends TicketIdentity = TicketIdentity> {
  private readonly tickets = new Map<string, { identity: T; expires: number }>();
  issue(identity: T, now = Date.now()): string {
    for (const [key, value] of this.tickets) if (value.expires <= now) this.tickets.delete(key);
    if (this.tickets.size >= 10000) throw new Error('Too many pending connections');
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { identity, expires: now + 60000 });
    return ticket;
  }
  consume(ticket: string, now = Date.now()): T | undefined {
    const value = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return value && value.expires > now ? value.identity : undefined;
  }
}
