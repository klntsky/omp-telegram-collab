import { createHmac } from 'node:crypto';

export const botToken = '123456789:fixture-token-not-valid-on-telegram';
export const botId = 123456789;
export const ownerId = 42;
export const ownerUsername = 'fixture_owner';
export const chatId = -1001234567890;

export function signedInitData(
  sessionId: string,
  options: { userId?: number; authDate?: number; token?: string; extra?: Record<string, string> } = {},
): string {
  const values = new URLSearchParams({
    auth_date: String(options.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: 'fixture-query',
    start_param: `s_${sessionId}`,
    user: JSON.stringify({ id: options.userId ?? ownerId, first_name: 'Ada', username: ownerUsername, is_bot: false }),
    ...options.extra,
  });
  const secret = createHmac('sha256', 'WebAppData').update(options.token ?? botToken).digest();
  const check = [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  values.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return values.toString();
}
