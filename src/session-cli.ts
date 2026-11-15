import { record } from './runtime/values.js';
import { OmpCommandError, parseJson } from './runtime/errors.js';
import type { ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { readConfig } from './config.js';
import { terminalOmp } from './runtime.js';

export class SessionJoinError extends Error {
  constructor(diagnostic: string, context: string, options?: ErrorOptions) { super(`${context}: ${diagnostic}`, options); this.name = 'SessionJoinError'; }
}


export async function joinSession(coordinates: { chat: number; topic: number }, configPath: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new SessionJoinError('Joining a session requires an interactive terminal.', `chat ${coordinates.chat}, topic ${coordinates.topic}`);
  const config = readConfig(configPath);
  const result = Promise.withResolvers<{ url: string; executable: string }>();
  let child: ChildProcess | undefined;
  let connectionError: unknown;
  let finished = false;
  const fail = (error: unknown) => {
    if (finished) return;
    connectionError ??= error;
    result.reject(error);
    child?.kill('SIGTERM');
  };
  const req = request({
    socketPath: join(config.dataDir, 'control.sock'), path: '/session/join', method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, response => {
    const chunks: Buffer[] = [];
    let size = 0;
    let received = false;
    const parse = () => {
      if (received) return;
      received = true;
      try {
        const body = parseJson(Buffer.concat(chunks).toString('utf8'), 'Join local session', `chat ${coordinates.chat}, topic ${coordinates.topic}`) as Record<string, unknown>;
        if (!record(body)) throw new SessionJoinError('Local service returned a non-object response.', `chat ${coordinates.chat}, topic ${coordinates.topic}`);
        if (response.statusCode !== 200) {
          if (typeof body.error !== 'string') throw new SessionJoinError(`Local service returned HTTP ${response.statusCode}.`, `Join chat ${coordinates.chat}, topic ${coordinates.topic}`);
          throw Object.assign(new SessionJoinError(body.error, `HTTP ${response.statusCode}; chat ${coordinates.chat}, topic ${coordinates.topic}`, { cause: { message: body.error, statusCode: response.statusCode } }), typeof body.code === 'string' || typeof body.code === 'number' ? { code: body.code } : {}, typeof body.signal === 'string' ? { signal: body.signal } : {});
        }
        if (typeof body.url !== 'string' || !body.url || typeof body.executable !== 'string' || !body.executable) throw new SessionJoinError('Local service returned an invalid session connection.', `Join chat ${coordinates.chat}, topic ${coordinates.topic}`);
        result.resolve({ url: body.url, executable: body.executable });
      } catch (error) { fail(error); }
    };
    response.on('data', (chunk: Buffer) => {
      if (received) return;
      size += chunk.length;
      if (size > 1024 * 1024) { req.destroy(new SessionJoinError('Local service response exceeds 1 MiB.', `Join chat ${coordinates.chat}, topic ${coordinates.topic}`)); return; }
      chunks.push(chunk);
      if (response.statusCode === 200 && chunk.includes(10)) parse();
    });
    response.on('error', error => fail(new OmpCommandError('Read local session response', `chat ${coordinates.chat}, topic ${coordinates.topic}`, error)));
    response.on('aborted', () => fail(new SessionJoinError('Local service closed the terminal session connection.', `Join chat ${coordinates.chat}, topic ${coordinates.topic}`)));
    response.on('end', () => {
      if (response.statusCode === 200) fail(new SessionJoinError('Local service closed the terminal session connection.', `Join chat ${coordinates.chat}, topic ${coordinates.topic}`));
      else parse();
    });
  });
  const timer = setTimeout(() => req.destroy(new SessionJoinError('Timed out resolving the session through the local service.', `Join chat ${coordinates.chat}, topic ${coordinates.topic}`)), config.omp.startupTimeoutMs + 30_000);
  req.on('error', error => fail(new OmpCommandError('Connect local session service', `chat ${coordinates.chat}, topic ${coordinates.topic}`, error)));
  req.end(JSON.stringify({ configPath: config.configPath, chatId: coordinates.chat, topicId: coordinates.topic }));
  const interrupt = () => {};
  const terminate = () => { child?.kill('SIGTERM'); };
  try {
    const connection = await result.promise;
    clearTimeout(timer);
    if (connectionError) throw connectionError;
    child = terminalOmp.joinTerminal(connection.executable, connection.url);
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    child.once('error', error => exited.reject(new OmpCommandError('Start terminal join client', `chat ${coordinates.chat}, topic ${coordinates.topic}`, error)));
    child.once('exit', (code, signal) => exited.resolve({ code, signal }));
    const exit = await exited.promise;
    if (connectionError) throw connectionError;
    finished = true;
    req.destroy();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    if (exit.signal) process.kill(process.pid, exit.signal);
    else if (exit.code) process.exitCode = exit.code;
  } finally {
    finished = true;
    clearTimeout(timer);
    req.destroy();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
