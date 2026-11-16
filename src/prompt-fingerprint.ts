import { createHash } from 'node:crypto';
import type { PromptContent } from '../shared/contracts.js';

// OMP's persisted blob identities hash decoded image bytes, not their base64 encoding.
// https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/blob-store.ts#L342-L360
export function promptFingerprint(content: PromptContent): string {
  return createHash('sha256')
    .update(JSON.stringify([
      content.text,
      (content.images ?? []).map(image => [
        image.mimeType,
        /^blob:sha256:[a-f0-9]{64}$/.test(image.data)
          ? image.data.slice('blob:sha256:'.length)
          : createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex'),
      ]),
    ]))
    .digest('hex');
}
