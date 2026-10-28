import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TopicKey, TopicSession } from '../shared/contracts.js';
import { topicDestination, type TopicDestination } from '../shared/topic-destination.js';
import type { ImageContent } from '@oh-my-pi/pi-wire';

type Row = Record<string, string | number | null>;
export type PendingSkillKey = { botId: number; destination: TopicDestination; userId: number };
function storedThreadId(destination: TopicDestination): number {
  return destination.kind === 'general' ? 1 : destination.threadId;
}
export interface SetupRequest {
  code: string;
  botId: number;
  chatId: number;
  userId: number;
  username?: string;
  title: string;
  expiresAt: number;
}
function setupRequest(row: Row): SetupRequest {
  return { code: String(row.code), botId: Number(row.bot_id), chatId: Number(row.chat_id), userId: Number(row.user_id), ...(row.username === null ? {} : { username: String(row.username) }), title: String(row.title), expiresAt: Number(row.expires_at) };
}
function session(row: Row | undefined): TopicSession | undefined {
  if (!row) return undefined;
  return { id: String(row.id), botId: Number(row.bot_id), chatId: Number(row.chat_id), threadId: Number(row.thread_id), instancePath: String(row.instance_path), name: String(row.name), status: row.status as TopicSession['status'], runtime: JSON.parse(String(row.runtime)) as TopicSession['runtime'], createdAt: Number(row.created_at) };
}
export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS groups (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,PRIMARY KEY(bot_id,chat_id));
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,instance_path TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,runtime TEXT NOT NULL,created_at INTEGER NOT NULL,initial_task TEXT,initial_state TEXT,UNIQUE(bot_id,chat_id,thread_id));
      CREATE TABLE IF NOT EXISTS replies (session_id TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(session_id,fingerprint));
      CREATE TABLE IF NOT EXISTS snapshot_baselines (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS initial_users (session_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS initial_images (session_id TEXT PRIMARY KEY REFERENCES sessions(id),images TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reply_targets (session_id TEXT PRIMARY KEY REFERENCES sessions(id),message_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_generations (session_id TEXT PRIMARY KEY REFERENCES sessions(id),generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_topic_icons (session_id TEXT PRIMARY KEY REFERENCES sessions(id),icon_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS new_topic_skills (session_id TEXT PRIMARY KEY REFERENCES sessions(id),name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_requests (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,message_id INTEGER NOT NULL,user_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(bot_id,chat_id,message_id));
      CREATE TABLE IF NOT EXISTS pending_skills (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,user_id INTEGER NOT NULL,name TEXT NOT NULL,PRIMARY KEY(bot_id,chat_id,thread_id,user_id,name));
      CREATE TABLE IF NOT EXISTS setup_requests (code TEXT PRIMARY KEY,bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,user_id INTEGER NOT NULL,username TEXT,title TEXT NOT NULL,expires_at INTEGER NOT NULL,UNIQUE(bot_id,chat_id,user_id));
      CREATE TABLE IF NOT EXISTS topic_admins (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL CHECK(thread_id>1),identity TEXT NOT NULL,PRIMARY KEY(bot_id,chat_id,thread_id,identity));
      COMMIT;`);
  }
  enrollGroup(botId: number, chatId: number): void { this.db.prepare('INSERT OR IGNORE INTO groups VALUES (?,?)').run(botId, chatId); }
  isEnrolled(botId: number, chatId: number): boolean { return Boolean(this.db.prepare('SELECT 1 FROM groups WHERE bot_id=? AND chat_id=?').get(botId, chatId)); }
  listGroups(botId: number): number[] { return this.db.prepare('SELECT chat_id FROM groups WHERE bot_id=? ORDER BY chat_id').all(botId).map(row => Number(row.chat_id)); }
  addTopicAdmin(botId: number, destination: TopicDestination, identity: string | number): void {
    if (destination.kind !== 'topic') throw new Error('Topic administrator grants require a non-General topic');
    this.db.prepare('INSERT OR IGNORE INTO topic_admins VALUES (?,?,?,?)')
      .run(botId, destination.chatId, destination.threadId, String(identity));
  }
  isTopicAdmin(botId: number, destination: TopicDestination, userId: number, username?: string): boolean {
    if (destination.kind !== 'topic') return false;
    return Boolean(this.db.prepare('SELECT 1 FROM topic_admins WHERE bot_id=? AND chat_id=? AND thread_id=? AND (identity=? OR identity=?)')
      .get(botId, destination.chatId, destination.threadId, String(userId), username?.toLowerCase() ?? ''));
  }
  listTopicAdmins(botId: number, chatId: number): { threadId: number; identity: string | number }[] {
    return this.db.prepare('SELECT thread_id,identity FROM topic_admins WHERE bot_id=? AND chat_id=? ORDER BY thread_id,identity')
      .all(botId, chatId).map(row => ({
        threadId: Number(row.thread_id),
        identity: /^\d+$/.test(String(row.identity)) ? Number(row.identity) : String(row.identity),
      }));
  }
  getPendingSkills(key: PendingSkillKey): string[] {
    return this.db.prepare('SELECT name FROM pending_skills WHERE bot_id=? AND chat_id=? AND thread_id=? AND user_id=? ORDER BY rowid').all(key.botId, key.destination.chatId, storedThreadId(key.destination), key.userId).map(row => String(row.name));
  }
  addPendingSkill(key: PendingSkillKey, name: string): string[] {
    this.db.prepare('INSERT OR IGNORE INTO pending_skills VALUES (?,?,?,?,?)').run(key.botId, key.destination.chatId, storedThreadId(key.destination), key.userId, name);
    return this.getPendingSkills(key);
  }
  clearPendingSkills(key: PendingSkillKey): void {
    this.db.prepare('DELETE FROM pending_skills WHERE bot_id=? AND chat_id=? AND thread_id=? AND user_id=?').run(key.botId, key.destination.chatId, storedThreadId(key.destination), key.userId);
  }
  getSession(id: string): TopicSession | undefined { return session(this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Row | undefined); }
  getTopic(key: { botId: number; destination: TopicDestination }): TopicSession | undefined {
    if (key.destination.kind === 'general') return undefined;
    return session(this.db.prepare('SELECT * FROM sessions WHERE bot_id=? AND chat_id=? AND thread_id=?').get(key.botId, key.destination.chatId, storedThreadId(key.destination)) as Row | undefined);
  }
  createSession(key: TopicKey & { instancePath: string }, name: string, runtime: TopicSession['runtime'] = { kind: 'managed' }, initialTask?: string, initialUserId?: number, images?: ImageContent[]): TopicSession {
    if (!key.instancePath) throw new Error('A session requires its configured instance path');
    if (topicDestination(key.chatId, key.threadId).kind === 'general') throw new Error('A session requires a non-General topic');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT OR IGNORE INTO sessions (id,bot_id,chat_id,thread_id,name,status,runtime,created_at,initial_task,initial_state,instance_path) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(randomBytes(16).toString('base64url'), key.botId, key.chatId, key.threadId, name, 'open', JSON.stringify(runtime), Date.now(), initialTask ?? null, initialTask ? 'pending' : null, key.instancePath);
      const created = this.getTopic({ botId: key.botId, destination: topicDestination(key.chatId, key.threadId) })!;
      if (created.instancePath !== key.instancePath) throw new Error('This topic history belongs to a different instance path');
      if (Number(result.changes) && initialTask && initialUserId) {
        this.db.prepare('INSERT INTO initial_users VALUES (?,?)').run(created.id,initialUserId);
        if (images?.length) this.db.prepare('INSERT INTO initial_images VALUES (?,?)').run(created.id,JSON.stringify(images));
      }
      this.db.exec('COMMIT');
      return created;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  listSessions(botId?: number): TopicSession[] {
    const rows = botId === undefined ? this.db.prepare('SELECT * FROM sessions').all() : this.db.prepare('SELECT * FROM sessions WHERE bot_id=?').all(botId);
    return rows.map(row => session(row as Row)!);
  }
  updateSession(id: string, value: { name?: string; status?: TopicSession['status'] }): TopicSession | undefined {
    if (value.name !== undefined) this.db.prepare('UPDATE sessions SET name=? WHERE id=?').run(value.name, id);
    if (value.status !== undefined) this.db.prepare('UPDATE sessions SET status=? WHERE id=?').run(value.status, id);
    return this.getSession(id);
  }
  getSessionGeneration(id: string): number {
    const row = this.db.prepare('SELECT generation FROM session_generations WHERE session_id=?').get(id);
    return Number(row?.generation ?? 0);
  }
  advanceSessionGeneration(id: string): void {
    this.db.prepare('INSERT INTO session_generations VALUES (?,1) ON CONFLICT(session_id) DO UPDATE SET generation=generation+1').run(id);
  }
  setNewTopicSkill(sessionId: string, name: string): void {
    this.db.prepare('INSERT INTO new_topic_skills VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET name=excluded.name').run(sessionId, name);
  }
  getNewTopicSkill(sessionId: string): string | undefined {
    const row = this.db.prepare('SELECT name FROM new_topic_skills WHERE session_id=?').get(sessionId);
    return row ? String(row.name) : undefined;
  }
  clearNewTopicSkill(sessionId: string): void {
    this.db.prepare('DELETE FROM new_topic_skills WHERE session_id=?').run(sessionId);
  }
  hasPendingInitialTask(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sessions WHERE id=? AND initial_state='pending'").get(id));
  }
  claimInitialTask(id: string): string | undefined {
    const row = this.db.prepare("UPDATE sessions SET initial_state='submitted' WHERE id=? AND initial_state='pending' RETURNING initial_task").get(id) as Row | undefined;
    return row?.initial_task === undefined ? undefined : String(row.initial_task);
  }
  cancelInitialTask(id: string): void {
    this.db.prepare("UPDATE sessions SET initial_state='cancelled' WHERE id=? AND initial_state='pending'").run(id);
  }
  getInitialImages(id: string): ImageContent[] | undefined {
    const row = this.db.prepare('SELECT images FROM initial_images WHERE session_id=?').get(id);
    return row ? JSON.parse(String(row.images)) as ImageContent[] : undefined;
  }
  getInitialUser(id: string): number | undefined {
    const row = this.db.prepare('SELECT user_id FROM initial_users WHERE session_id=?').get(id);
    return row ? Number(row.user_id) : undefined;
  }
  setReplyTarget(id: string, messageId: number | undefined): void {
    if (messageId === undefined) this.db.prepare('DELETE FROM reply_targets WHERE session_id=?').run(id);
    else this.db.prepare('INSERT INTO reply_targets VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET message_id=excluded.message_id').run(id,messageId);
  }
  getReplyTarget(id: string): number | undefined {
    const row = this.db.prepare('SELECT message_id FROM reply_targets WHERE session_id=?').get(id);
    return row ? Number(row.message_id) : undefined;
  }
  getTopicIcon(id: string): string | undefined {
    const row = this.db.prepare('SELECT icon_id FROM session_topic_icons WHERE session_id=?').get(id);
    return row ? String(row.icon_id) : undefined;
  }
  setTopicIcon(id: string, iconId: string | undefined): void {
    if (iconId === undefined) this.db.prepare('DELETE FROM session_topic_icons WHERE session_id=?').run(id);
    else this.db.prepare('INSERT INTO session_topic_icons VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET icon_id=excluded.icon_id').run(id,iconId);
  }
  rememberReply(id: string, fingerprint: string): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO replies VALUES (?,?,?)').run(id, fingerprint, Date.now());
    return Number(result.changes) === 1;
  }
  hasSnapshot(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM snapshot_baselines WHERE session_id=?').get(id));
  }
  markSnapshot(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO snapshot_baselines VALUES (?)').run(id);
  }
  addTaskRequest(botId: number, destination: TopicDestination, messageId: number, userId: number): void {
    this.db.prepare('DELETE FROM task_requests WHERE created_at<?').run(Date.now() - 3600000);
    this.db.prepare('INSERT OR REPLACE INTO task_requests VALUES (?,?,?,?,?,?)').run(botId, destination.chatId, messageId, userId, storedThreadId(destination), Date.now());
  }
  takeTaskRequest(botId: number, destination: TopicDestination, messageId: number, userId: number): boolean {
    return Number(this.db.prepare('DELETE FROM task_requests WHERE bot_id=? AND chat_id=? AND thread_id=? AND message_id=? AND user_id=? AND created_at>? RETURNING message_id').get(botId, destination.chatId, storedThreadId(destination), messageId, userId, Date.now() - 3600000)?.message_id) === messageId;
  }
  createSetupRequest(input: Omit<SetupRequest, 'code' | 'expiresAt'>): SetupRequest {
    const request: SetupRequest = { ...input, code: randomBytes(9).toString('base64url'), expiresAt: Date.now() + 600000 };
    this.db.prepare('DELETE FROM setup_requests WHERE expires_at<=?').run(Date.now());
    this.db.prepare('INSERT INTO setup_requests (code,bot_id,chat_id,user_id,username,title,expires_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(bot_id,chat_id,user_id) DO UPDATE SET code=excluded.code,username=excluded.username,title=excluded.title,expires_at=excluded.expires_at').run(request.code, request.botId, request.chatId, request.userId, request.username ?? null, request.title, request.expiresAt);
    return request;
  }
  getSetupRequest(code: string): SetupRequest | undefined {
    const row = this.db.prepare('SELECT * FROM setup_requests WHERE code=? AND expires_at>?').get(code, Date.now()) as Row | undefined;
    return row ? setupRequest(row) : undefined;
  }
  listSetupRequests(): SetupRequest[] {
    return (this.db.prepare('SELECT * FROM setup_requests WHERE expires_at>? ORDER BY expires_at,code').all(Date.now()) as Row[]).map(setupRequest);
  }
  consumeSetupRequest(code: string): void {
    this.db.prepare('DELETE FROM setup_requests WHERE code=?').run(code);
  }
  close(): void { this.db.close(); }
}
