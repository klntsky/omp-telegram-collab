import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { HostFrame } from '@oh-my-pi/pi-wire';
import type { AppConfig, CollabConnection, TopicSession } from '../shared/contracts.js';
import { Store } from './store.js';
import { TicketStore, validateInitData, validateGuestFrame, type TicketIdentity } from './auth.js';
import { connectCollab } from './collab.js';
import type { BotService, RuntimeLike } from './bot.js';
import { SessionCapacityError } from './runtime.js';
import { findInstance, refreshTermination } from './config.js';

export type GatewayBot = Pick<BotService, 'id' | 'token' | 'authorize' | 'relayPrompt' | 'requestCapacity' | 'ensureMirroring' | 'onSessionKill'>;
export interface ServerOptions { config: AppConfig; bots: GatewayBot[]; store: Store; runtime: RuntimeLike; connect?: typeof connectCollab; staticDir?: string }
export interface GatewayServer extends Server { closeConnections(): Promise<void> }
const requestSchema = z.object({botId:z.number().int().positive().safe(),sessionId:z.string().regex(/^[A-Za-z0-9_-]{22}$/),initData:z.string().min(1).max(32768),generation:z.number().int().nonnegative().safe().optional()}).strict();
const mime: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.ico':'image/x-icon','.json':'application/json'};
class SessionGenerationError extends Error {}
const terminationMessage = 'The service got terminated, only admin can resume it (remove terminated: true from the config)';
class ServiceTerminatedError extends Error {
  constructor() { super(terminationMessage); }
}
function participantName(identity: TicketIdentity): string {
  return identity.username ? `@${identity.username}` : `user ID ${identity.userId}`;
}
function json(response: ServerResponse, code: number, value: unknown): void {
  response.writeHead(code, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}); response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<unknown> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65536) throw new Error('Request too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createServer(options: ServerOptions): GatewayServer {
  const tickets = new TicketStore();
  const sockets = new WebSocketServer({noServer:true,maxPayload:6*1024*1024,perMessageDeflate:false});
  const botMap = new Map(options.bots.map(bot => [bot.id,bot]));
  if (botMap.has(0) || botMap.size !== options.bots.length) throw new Error('Initialize each distinct bot before creating the server');
  const root = resolve(options.staticDir ?? 'web/dist');
  const publicOrigin = new URL(options.config.publicUrl).origin;
  let closing = false;
  let pendingRequests = 0;
  let pendingUpgrades = 0;
  function checkTermination(): void {
    if (refreshTermination(options.config)) throw new ServiceTerminatedError();
  }
  function checkGeneration(identity: TicketIdentity): void {
    if (identity.generation !== options.store.getSessionGeneration(identity.sessionId)) throw new SessionGenerationError('Session was killed; rejoin explicitly');
  }
  async function authorize(identity: TicketIdentity): Promise<{bot:GatewayBot;session:TopicSession}> {
    checkTermination();
    const bot = botMap.get(identity.botId), session = options.store.getSession(identity.sessionId);
    if (!bot || !session || session.botId !== identity.botId || Date.now()/1000 - identity.authDate > 3600) throw new Error('Access denied');
    if (findInstance(options.config, session.botId, session.chatId)?.path !== session.instancePath ||
        await realpath(session.instancePath) !== session.instancePath) throw new Error('Instance is unavailable');
    checkGeneration(identity);
    await bot.authorize(session.chatId,identity.userId);
    const current = options.store.getSession(identity.sessionId);
    if (!current || current.botId !== identity.botId || !options.store.isEnrolled(identity.botId,current.chatId)) throw new Error('Access denied');
    if (current.status === 'detached') throw new SessionGenerationError('This topic is conversation-only; its session is detached');
    if (findInstance(options.config, current.botId, current.chatId)?.path !== current.instancePath) throw new Error('Instance assignment changed');
    checkGeneration(identity);
    checkTermination();
    return {bot,session:current};
  }
  const server = createHttpServer((request,response) => {
    void (async () => {
      response.setHeader('referrer-policy','no-referrer');
      const url = new URL(request.url ?? '/',publicOrigin);
      if (url.pathname === '/healthz' && request.method === 'GET') { json(response,200,{ok:!closing}); return; }
      if (url.pathname === '/api/session' && request.method === 'POST') {
        if (closing || (request.headers.origin && request.headers.origin !== publicOrigin)) { json(response,403,{error:'Access denied'}); return; }
        if (pendingRequests >= 64) {
          json(response,429,{error:'Too many authentication requests'});
          return;
        }
        pendingRequests++;
        try {
          checkTermination();
          const parsed = requestSchema.parse(await body(request));
          const bot = botMap.get(parsed.botId);
          if (!bot) throw new Error('Access denied');
          const authentication = validateInitData(parsed.initData,bot.token);
          if (authentication.startParam !== `s_${parsed.sessionId}`) throw new Error('Access denied');
          const identity: TicketIdentity = {
            botId:parsed.botId,
            sessionId:parsed.sessionId,
            generation:parsed.generation ?? options.store.getSessionGeneration(parsed.sessionId),
            userId:authentication.user.id,
            username:authentication.user.username,
            displayName:[authentication.user.first_name,authentication.user.last_name].filter(Boolean).join(' ').slice(0,80),
            authDate:authentication.authDate,
          };
          const {session} = await authorize(identity);
          checkGeneration(identity);
          json(response,200,{session:{id:session.id,name:session.name,status:session.status},generation:identity.generation,ticket:tickets.issue(identity),displayName:participantName(identity)});
          return;
        } finally {
          pendingRequests--;
        }
      }
      if (url.pathname.startsWith('/api/')) { json(response,404,{error:'Not found'}); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { json(response,405,{error:'Method not allowed'}); return; }
      const decoded = decodeURIComponent(url.pathname);
      const filename = resolve(root,`.${decoded === '/' ? '/index.html' : decoded}`);
      if (filename !== root && !filename.startsWith(root+sep)) { json(response,404,{error:'Not found'}); return; }
      let target = filename;
      try { if (!(await stat(target)).isFile()) throw new Error('Not a file'); }
      catch { if (extname(decoded)) { json(response,404,{error:'Not found'}); return; } target = resolve(root,'index.html'); }
      const data = await readFile(target);
      response.writeHead(200,{'content-type':mime[extname(target)] ?? 'application/octet-stream','cache-control':extname(target) === '.html' ? 'no-store' : 'public, max-age=3600','x-content-type-options':'nosniff'});
      response.end(request.method === 'HEAD' ? undefined : data);
    })().catch(error => {
      if (!response.headersSent) {
        if (error instanceof ServiceTerminatedError) json(response,403,{error:error.message});
        else if (error instanceof SessionGenerationError) json(response,409,{error:error.message});
        else json(response,request.url?.startsWith('/api/') ? 403 : 404,{error:request.url?.startsWith('/api/') ? 'Authentication or access denied' : 'Not found'});
      } else response.end();
    });
  }) as GatewayServer;
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('upgrade',(request,socket,head) => {
    if (pendingUpgrades + sockets.clients.size >= 256) {
      socket.destroy();
      return;
    }
    pendingUpgrades++;
    let upgraded = false;
    const abort = () => { if (!upgraded) socket.destroy(); };
    const timeout = setTimeout(abort,10000); timeout.unref();
    void (async () => {
      const url = new URL(request.url ?? '/',publicOrigin);
      checkTermination();
      if (closing || url.pathname !== '/api/socket' || (request.headers.origin && request.headers.origin !== publicOrigin) || sockets.clients.size >= 256 || url.searchParams.getAll('ticket').length !== 1) throw new Error('Access denied');
      const identity = tickets.consume(url.searchParams.get('ticket') ?? '');
      if (!identity) throw new Error('Access denied');
      await authorize(identity);
      checkGeneration(identity);
      checkTermination();
      if (socket.destroyed || closing) return;
      upgraded = true;
      sockets.handleUpgrade(request,socket,head,ws => connectSocket(ws,identity));
    })().catch(error => {
      if (error instanceof ServiceTerminatedError && !socket.destroyed && !upgraded) {
        const payload = JSON.stringify({error:error.message});
        socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
      } else abort();
    }).finally(() => {
      pendingUpgrades--;
      clearTimeout(timeout);
    });
  });
  function connectSocket(ws: WebSocket, identity: TicketIdentity): void {
    let upstream: CollabConnection | undefined;
    let release: (() => void) | undefined;
    let closed = false, queued = 0, queuedBytes = 0;
    let tail: Promise<void> = Promise.resolve();
    let outgoing: { frame: HostFrame; payload: string }[] = [];
    let outgoingScheduled = false, outgoingCount = 0, outgoingBytes = 0, pendingBytes = 0;
    const unsubscribeKill = botMap.get(identity.botId)!.onSessionKill(sessionId => {
      if (sessionId !== identity.sessionId) return;
      try { checkTermination(); }
      catch (error) {
        fail(4003,error instanceof ServiceTerminatedError ? error.message : 'Access or session unavailable');
        return;
      }
      fail(4003, options.store.getSession(sessionId)?.status === 'detached'
        ? 'This topic is conversation-only; its session is detached'
        : 'Session process killed. Reopen Open Session to restart.');
    });
    const expiry = setTimeout(() => fail(4001,'Authentication expired'),Math.max(1,Math.min(900000,(identity.authDate+3600)*1000-Date.now()))); expiry.unref();
    function fail(code: number, message: string): void {
      if (closed) return;
      closed = true; clearTimeout(expiry); unsubscribeKill(); release?.(); upstream?.close(); ws.close(code,message);
      const terminate = setTimeout(() => ws.terminate(),1000); terminate.unref();
    }
    function enqueue(bytes: number, action: () => Promise<void>): void {
      if (closed) return;
      queued++; queuedBytes += bytes;
      if (queued > 128 || queuedBytes > 8*1024*1024) { fail(4008,'Connection overloaded'); return; }
      tail = tail.then(async () => { if (!closed) await action(); }).catch(async error => {
        if (error instanceof ServiceTerminatedError) fail(4003,error.message);
        else if (error instanceof SessionCapacityError) {
          fail(4009,error.message);
          const session = options.store.getSession(identity.sessionId);
          if (session) await botMap.get(identity.botId)?.requestCapacity(session,error.limit).catch(() => undefined);
        } else fail(4003,'Access or session unavailable');
      }).finally(() => { queued--; queuedBytes-=bytes; });
    }
    function flushOutgoing(): void {
      if (closed || outgoingScheduled || !outgoing.length) return;
      outgoingScheduled = true;
      enqueue(0,async () => {
        // Frames arriving during this check belong to the next freshly authorized batch.
        const batch = outgoing;
        const batchBytes = pendingBytes;
        outgoing = [];
        pendingBytes = 0;
        try {
          const current = await authorize(identity);
          for (const {frame,payload} of batch) {
            if (closed || ws.readyState !== WebSocket.OPEN) return;
            checkTermination();
            if (ws.bufferedAmount > 4*1024*1024) { fail(4008,'Slow connection'); return; }
            const value = frame.t === 'welcome' && current.session.status === 'closed' ? JSON.stringify({...frame,readOnly:true}) : payload;
            const sent = Promise.withResolvers<void>();
            ws.send(value,error => error ? sent.reject(error) : sent.resolve());
            await sent.promise;
          }
        } finally {
          outgoingCount -= batch.length;
          outgoingBytes -= batchBytes;
          outgoingScheduled = false;
          flushOutgoing();
        }
      });
    }
    ws.on('error',() => fail(1011,'Connection failed'));
    ws.on('close',() => { closed=true; clearTimeout(expiry); unsubscribeKill(); release?.(); upstream?.close(); });
    ws.on('message',(data,binary) => {
      try { checkTermination(); }
      catch (error) { fail(4003,error instanceof ServiceTerminatedError ? error.message : 'Access or session unavailable'); return; }
      if (binary) { fail(4002,'JSON text frames required'); return; }
      let frame;
      try { frame = validateGuestFrame(JSON.parse(data.toString())); }
      catch { fail(4002,'Invalid action'); return; }
      enqueue(Buffer.byteLength(data.toString()),async () => {
        const {bot,session} = await authorize(identity);
        if (session.status === 'closed' && frame.t !== 'fetch-transcript') throw new Error('Archived session');
        if (!upstream) throw new Error('Session not connected');
        checkTermination();
        if (frame.t === 'prompt') options.runtime.markPrompt(session.id);
        upstream.send(frame);
        if (frame.t === 'prompt') await bot.relayPrompt(session,identity,frame.text);
      });
    });
    enqueue(0,async () => {
      const {bot,session} = await authorize(identity);
      if (closed) return;
      checkGeneration(identity);
      release = options.runtime.retain(session.id);
      checkTermination();
      const binding = await options.runtime.ensure(session);
      if (closed) return;
      checkTermination();
      await bot.ensureMirroring(session,binding);
      if (closed) return;
      checkTermination();
      const connection = await (options.connect ?? connectCollab)(binding,participantName(identity),{
        onFrame: frame => {
          try { checkTermination(); }
          catch (error) { fail(4003,error instanceof ServiceTerminatedError ? error.message : 'Access or session unavailable'); return; }
          options.runtime.observeFrame(session.id,frame);
          let payload: string;
          try { payload = JSON.stringify(frame); } catch { fail(1011,'Invalid host frame'); return; }
          const bytes = Buffer.byteLength(payload);
          outgoingCount++; outgoingBytes += bytes;
          if (outgoingCount > 128 || outgoingBytes > 8*1024*1024) { fail(4008,'Connection overloaded'); return; }
          outgoing.push({frame,payload});
          pendingBytes += bytes;
          flushOutgoing();
        },
        onClose: () => fail(1011,'Host disconnected'),
      });
      if (closed) connection.close(); else upstream = connection;
    });
  }
  server.closeConnections = async () => {
    closing = true;
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    server.closeIdleConnections();
  };
  return server;
}
