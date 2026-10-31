import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { readConfig } from './config.js';

export async function joinSession(coordinates: { chat: number; topic: number }, configPath: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Joining a session requires an interactive terminal.');
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
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (response.statusCode !== 200) {
          if (typeof body.error !== 'string') throw new Error(`Local service returned HTTP ${response.statusCode}.`);
          throw Object.assign(new Error(body.error), typeof body.code === 'string' || typeof body.code === 'number' ? { code: body.code } : {}, typeof body.signal === 'string' ? { signal: body.signal } : {});
        }
        if (typeof body.url !== 'string' || !body.url || typeof body.executable !== 'string' || !body.executable) throw new Error('Local service returned an invalid session connection.');
        result.resolve({ url: body.url, executable: body.executable });
      } catch (error) { fail(error); }
    };
    response.on('data', (chunk: Buffer) => {
      if (received) return;
      size += chunk.length;
      if (size > 1024 * 1024) { req.destroy(new Error('Local service response exceeds 1 MiB.')); return; }
      chunks.push(chunk);
      if (response.statusCode === 200 && chunk.includes(10)) parse();
    });
    response.on('error', fail);
    response.on('aborted', () => fail(new Error('Local service closed the terminal session connection.')));
    response.on('end', () => {
      if (response.statusCode === 200) fail(new Error('Local service closed the terminal session connection.'));
      else parse();
    });
  });
  const timer = setTimeout(() => req.destroy(new Error('Timed out resolving the session through the local service.')), config.omp.startupTimeoutMs + 30_000);
  req.on('error', fail);
  req.end(JSON.stringify({ configPath: config.configPath, chatId: coordinates.chat, topicId: coordinates.topic }));
  const interrupt = () => {};
  const terminate = () => { child?.kill('SIGTERM'); };
  try {
    const connection = await result.promise;
    clearTimeout(timer);
    if (connectionError) throw connectionError;
    child = spawn(connection.executable, ['join', connection.url], { stdio: 'inherit', shell: false });
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    child.once('error', exited.reject);
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
