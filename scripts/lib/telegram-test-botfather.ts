import { randomBytes } from 'node:crypto';
import { Conversation, type TelegramClient } from '@mtcute/node';

export async function createCentralTestBot(client: TelegramClient, shutdownSignal?: AbortSignal): Promise<string> {
  const signal = shutdownSignal ? AbortSignal.any([client.stopSignal, shutdownSignal]) : client.stopSignal;
  signal.throwIfAborted();
  const conversation = new Conversation(client, 'BotFather');
  const stop = () => conversation.stop();
  signal.addEventListener('abort', stop, { once: true });
  try {
    return await conversation.with(async () => {
      const exchange = async (text: string) => {
        signal.throwIfAborted();
        const sent = await conversation.sendText(text, { abortSignal: signal });
        signal.throwIfAborted();
        return conversation.waitForResponse(undefined, { message: sent.id, timeout: 30000 });
      };
      const unexpected = (text: string): never => { throw new Error(`Unexpected BotFather response:\n${text}`); };
      await exchange('/cancel');
      const request = await exchange('/newbot');
      if (!/how are we going to call it|choose a name for your bot/i.test(request.text)) unexpected(request.text);
      const named = await exchange(`omp_e2e_${randomBytes(8).toString('hex')}`);
      if (!/choose a username for your bot/i.test(named.text)) unexpected(named.text);
      const created = await exchange(`omp_e2e_${randomBytes(8).toString('hex')}_bot`);
      const token = created.text.match(/(?<![A-Za-z0-9_:-])[1-9]\d*:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/)?.[0];
      return token ?? unexpected(created.text);
    });
  } finally { signal.removeEventListener('abort', stop); }
}
