import { request } from 'node:http';
import { join } from 'node:path';
import type { AppConfig } from '../../shared/contracts.js';

class ReloadError extends Error {
  constructor(path: string, detail: string, cause?: unknown) {
    super(`Configuration reload failed for ${path}: ${detail}`, { cause });
    this.name = 'ReloadError';
  }
}

class ServiceUnavailableError extends ReloadError {}

export async function notifyReload(config: AppConfig, socketDataDir = config.dataDir): Promise<void> {
  const {promise, resolve: acknowledge, reject} = Promise.withResolvers<void>();
  const failure = (detail = 'Configuration saved, but the running service did not apply it. Check service logs and run reload.', cause?: unknown) => new ReloadError(config.configPath, detail, cause);
  const req = request({ socketPath: join(socketDataDir, 'control.sock'), path: '/reload', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => { if (body.length < 8192) body += chunk; });
    response.on('error', error => reject(failure(error.message, error)));
    response.on('aborted', () => reject(failure()));
    response.on('end', () => {
      try {
        const result: unknown = JSON.parse(body);
        if (result && typeof result === 'object') {
          if (response.statusCode === 200 && 'ok' in result && result.ok === true) { acknowledge(); return; }
          if ('error' in result && typeof result.error === 'string') {
            const error = failure(`${failure().message}\n${result.error}`, result);
            if ('code' in result) Object.assign(error, { code: result.code });
            if ('signal' in result) Object.assign(error, { signal: result.signal });
            reject(error);
            return;
          }
        }
      } catch (error) { reject(failure(error instanceof Error ? error.message : String(error), error)); return; }
      reject(failure());
    });
  });
  const timer = setTimeout(() => req.destroy(failure()), 5000);
  req.on('error', (error: NodeJS.ErrnoException) => {
    const translated = error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
      ? new ServiceUnavailableError(config.configPath, error.message, error)
      : failure(error.message, error);
    if (translated instanceof ServiceUnavailableError) acknowledge();
    else reject(translated);
  });
  req.end(JSON.stringify({ configPath: config.configPath }));
  try { await promise; } finally { clearTimeout(timer); req.destroy(); }
}
