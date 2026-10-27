import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { AppConfig, CollabConnection, TopicSession } from '../shared/contracts.js';
import { Store } from './store.js';
import { TicketStore, validateInitData, validateGuestFrame, type TicketIdentity } from './auth.js';
import { connectCollab } from './collab.js';
import type { BotService, RuntimeLike } from './bot.js';

export type GatewayBot = Pick<BotService, 'id' | 'token' | 'authorize'>;
export interface ServerOptions { config: AppConfig; bots: GatewayBot[]; store: Store; runtime: RuntimeLike; connect?: typeof connectCollab; staticDir?: string }
export interface GatewayServer extends Server { closeConnections(): Promise<void> }
const requestSchema = z.object({botId:z.number().int().positive().safe(),sessionId:z.string().regex(/^[A-Za-z0-9_-]{22}$/),initData:z.string().min(1).max(32768)}).strict();
const mime: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.ico':'image/x-icon','.json':'application/json'};
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
  async function authorize(identity: TicketIdentity): Promise<{bot:GatewayBot;session:TopicSession}> {
    const bot = botMap.get(identity.botId), session = options.store.getSession(identity.sessionId);
    if (!bot || !session || session.botId !== identity.botId || Date.now()/1000 - identity.authDate > 3600) throw new Error('Access denied');
    await bot.authorize(session.chatId,identity.userId);
    const current = options.store.getSession(identity.sessionId);
    if (!current || current.botId !== identity.botId || !options.store.isEnrolled(identity.botId,current.chatId)) throw new Error('Access denied');
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
          const parsed = requestSchema.parse(await body(request));
          const bot = botMap.get(parsed.botId);
          if (!bot) throw new Error('Access denied');
          const authentication = validateInitData(parsed.initData,bot.token);
          if (authentication.startParam !== `s_${parsed.sessionId}`) throw new Error('Access denied');
          const identity: TicketIdentity = {
            botId:parsed.botId,
            sessionId:parsed.sessionId,
            userId:authentication.user.id,
            displayName:[authentication.user.first_name,authentication.user.last_name].filter(Boolean).join(' ').slice(0,80),
            authDate:authentication.authDate,
          };
          const {session} = await authorize(identity);
          json(response,200,{session:{id:session.id,name:session.name,status:session.status},ticket:tickets.issue(identity),displayName:identity.displayName});
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
    })().catch(() => { if (!response.headersSent) json(response,request.url?.startsWith('/api/') ? 403 : 404,{error:request.url?.startsWith('/api/') ? 'Authentication or access denied' : 'Not found'}); else response.end(); });
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
      if (closing || url.pathname !== '/api/socket' || (request.headers.origin && request.headers.origin !== publicOrigin) || sockets.clients.size >= 256 || url.searchParams.getAll('ticket').length !== 1) throw new Error('Access denied');
      const identity = tickets.consume(url.searchParams.get('ticket') ?? '');
      if (!identity) throw new Error('Access denied');
      await authorize(identity);
      if (socket.destroyed || closing) return;
      upgraded = true;
      sockets.handleUpgrade(request,socket,head,ws => connectSocket(ws,identity));
    })().catch(abort).finally(() => {
      pendingUpgrades--;
      clearTimeout(timeout);
    });
  });
  function connectSocket(ws: WebSocket, identity: TicketIdentity): void {
    let upstream: CollabConnection | undefined;
    let closed = false, queued = 0, queuedBytes = 0;
    let tail: Promise<void> = Promise.resolve();
    const expiry = setTimeout(() => fail(4001,'Authentication expired'),Math.max(1,Math.min(900000,(identity.authDate+3600)*1000-Date.now()))); expiry.unref();
    function fail(code: number, message: string): void {
      if (closed) return;
      closed = true; clearTimeout(expiry); upstream?.close(); ws.close(code,message);
      const terminate = setTimeout(() => ws.terminate(),1000); terminate.unref();
    }
    function enqueue(bytes: number, action: () => Promise<void>): void {
      if (closed) return;
      queued++; queuedBytes += bytes;
      if (queued > 128 || queuedBytes > 8*1024*1024) { fail(4008,'Connection overloaded'); return; }
      tail = tail.then(async () => { if (!closed) await action(); }).catch(() => fail(4003,'Access or session unavailable')).finally(() => { queued--; queuedBytes-=bytes; });
    }
    ws.on('error',() => fail(1011,'Connection failed'));
    ws.on('close',() => { closed=true; clearTimeout(expiry); upstream?.close(); });
    ws.on('message',(data,binary) => {
      if (binary) { fail(4002,'JSON text frames required'); return; }
      let frame;
      try { frame = validateGuestFrame(JSON.parse(data.toString())); }
      catch { fail(4002,'Invalid action'); return; }
      enqueue(Buffer.byteLength(data.toString()),async () => {
        const {session} = await authorize(identity);
        if (session.status === 'closed' && frame.t !== 'fetch-transcript') throw new Error('Archived session');
        if (!upstream) throw new Error('Session not connected');
        upstream.send(frame);
      });
    });
    enqueue(0,async () => {
      const {session} = await authorize(identity);
      const binding = await options.runtime.ensure(session);
      const connection = await (options.connect ?? connectCollab)(binding,identity.displayName,{
        onFrame: frame => {
          let payload: string;
          try { payload = JSON.stringify(frame); } catch { fail(1011,'Invalid host frame'); return; }
          enqueue(Buffer.byteLength(payload),async () => {
            const current = await authorize(identity);
            if (closed || ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > 4*1024*1024) { fail(4008,'Slow connection'); return; }
            const outgoing = frame.t === 'welcome' && current.session.status === 'closed' ? JSON.stringify({...frame,readOnly:true}) : payload;
            await new Promise<void>((resolve,reject) => ws.send(outgoing,error => error ? reject(error) : resolve()));
          });
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
