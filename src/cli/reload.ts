import { request } from 'node:http';
import { join } from 'node:path';
import type { AppConfig } from '../../shared/contracts.js';

export async function notifyReload(config: AppConfig, socketDataDir = config.dataDir): Promise<void> {
  const {promise, resolve: acknowledge, reject} = Promise.withResolvers<void>();
  const failure = () => new Error('Configuration saved, but the running service did not apply it. Check service logs and run reload.');
  const req = request({ socketPath: join(socketDataDir, 'control.sock'), path: '/reload', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => { if (body.length < 8192) body += chunk; });
    response.on('error', error => { console.error('Configuration reload response failed.', error); reject(error); });
    response.on('aborted', () => reject(failure()));
    response.on('end', () => {
      try {
        const result: unknown = JSON.parse(body);
        if (result && typeof result === 'object') {
          if (response.statusCode === 200 && 'ok' in result && result.ok === true) { acknowledge(); return; }
          if ('error' in result && typeof result.error === 'string') {
            const error = new Error(`${failure().message}\n${result.error}`);
            if ('code' in result) Object.assign(error, { code: result.code });
            if ('signal' in result) Object.assign(error, { signal: result.signal });
            reject(error);
            return;
          }
        }
      } catch (error) { console.error('Configuration reload acknowledgement was invalid.', error); reject(error); return; }
      reject(failure());
    });
  });
  req.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') acknowledge();
    else { console.error('Configuration reload request failed.', error); reject(error); }
  });
  req.end(JSON.stringify({ configPath: config.configPath }));
  // Reload includes Telegram retry delays and generation replacement, so elapsed time cannot establish failure.
  try { await promise; } finally { req.destroy(); }
}
