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
      CREATE TABLE IF NOT EXISTS bot_status_topics (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL CHECK(thread_id>1),PRIMARY KEY(bot_id,chat_id));
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,instance_path TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,runtime TEXT NOT NULL,created_at INTEGER NOT NULL,initial_task TEXT,initial_state TEXT,UNIQUE(bot_id,chat_id,thread_id));
      CREATE TABLE IF NOT EXISTS replies (session_id TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(session_id,fingerprint));
      CREATE TABLE IF NOT EXISTS snapshot_baselines (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS initial_users (session_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS initial_authorities (session_id TEXT PRIMARY KEY REFERENCES sessions(id),user_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS initial_images (session_id TEXT PRIMARY KEY REFERENCES sessions(id),images TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reply_targets (session_id TEXT PRIMARY KEY REFERENCES sessions(id),message_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_generations (session_id TEXT PRIMARY KEY REFERENCES sessions(id),generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_topic_finish_icons (session_id TEXT PRIMARY KEY REFERENCES sessions(id),icon_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_pending_titles (session_id TEXT PRIMARY KEY REFERENCES sessions(id),title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_topic_title_prefixes (session_id TEXT PRIMARY KEY REFERENCES sessions(id),prefix TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_entries (session_id TEXT PRIMARY KEY REFERENCES sessions(id),message_id INTEGER NOT NULL,markup TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS new_topic_skills (session_id TEXT PRIMARY KEY REFERENCES sessions(id),name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_requests (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,message_id INTEGER NOT NULL,user_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(bot_id,chat_id,message_id));
      CREATE TABLE IF NOT EXISTS pending_skills (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,user_id INTEGER NOT NULL,name TEXT NOT NULL,PRIMARY KEY(bot_id,chat_id,thread_id,user_id,name));
      CREATE TABLE IF NOT EXISTS skill_catalogs (instance_path TEXT PRIMARY KEY,skills TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS setup_requests (code TEXT PRIMARY KEY,bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,user_id INTEGER NOT NULL,username TEXT,title TEXT NOT NULL,expires_at INTEGER NOT NULL,UNIQUE(bot_id,chat_id,user_id));
      COMMIT;`);
  }
  enrollGroup(botId: number, chatId: number): void { this.db.prepare('INSERT OR IGNORE INTO groups VALUES (?,?)').run(botId, chatId); }
  isEnrolled(botId: number, chatId: number): boolean { return Boolean(this.db.prepare('SELECT 1 FROM groups WHERE bot_id=? AND chat_id=?').get(botId, chatId)); }
  listGroups(botId: number): number[] { return this.db.prepare('SELECT chat_id FROM groups WHERE bot_id=? ORDER BY chat_id').all(botId).map(row => Number(row.chat_id)); }
  getBotStatusTopic(botId: number, chatId: number): number | undefined {
    const row = this.db.prepare('SELECT thread_id FROM bot_status_topics WHERE bot_id=? AND chat_id=?').get(botId, chatId);
    return row ? Number(row.thread_id) : undefined;
  }
  setBotStatusTopic(botId: number, chatId: number, threadId: number): void {
    this.db.prepare('INSERT INTO bot_status_topics VALUES (?,?,?) ON CONFLICT(bot_id,chat_id) DO UPDATE SET thread_id=excluded.thread_id').run(botId, chatId, threadId);
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
  getSkillCatalog(instancePath: string): Array<{ name: string; description: string }> | undefined {
    const row = this.db.prepare('SELECT skills FROM skill_catalogs WHERE instance_path=?').get(instancePath);
    return row ? JSON.parse(String(row.skills)) as Array<{ name: string; description: string }> : undefined;
  }
  setSkillCatalog(instancePath: string, skills: Array<{ name: string; description: string }>): void {
    this.db.prepare('INSERT INTO skill_catalogs VALUES (?,?) ON CONFLICT(instance_path) DO UPDATE SET skills=excluded.skills').run(instancePath, JSON.stringify(skills));
  }
  getSession(id: string): TopicSession | undefined { return session(this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Row | undefined); }
  setSessionRuntime(id: string, runtime: TopicSession['runtime']): void {
    this.db.prepare('UPDATE sessions SET runtime=? WHERE id=?').run(JSON.stringify(runtime), id);
  }
  getTopic(key: { botId: number; destination: TopicDestination }): TopicSession | undefined {
    if (key.destination.kind === 'general') return undefined;
    return session(this.db.prepare('SELECT * FROM sessions WHERE bot_id=? AND chat_id=? AND thread_id=?').get(key.botId, key.destination.chatId, storedThreadId(key.destination)) as Row | undefined);
  }
  createSession(key: TopicKey & { instancePath: string }, name: string, runtime: TopicSession['runtime'] = { kind: 'managed' }, initialTask?: string, initialUserId?: number, images?: ImageContent[], authorityUserId = initialUserId): TopicSession {
    if (!key.instancePath) throw new Error('A session requires its configured instance path');
    if (topicDestination(key.chatId, key.threadId).kind === 'general') throw new Error('A session requires a non-General topic');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const hasTask = Boolean(initialTask || images?.length);
      const result = this.db.prepare('INSERT OR IGNORE INTO sessions (id,bot_id,chat_id,thread_id,name,status,runtime,created_at,initial_task,initial_state,instance_path) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(randomBytes(16).toString('base64url'), key.botId, key.chatId, key.threadId, name, 'open', JSON.stringify(runtime), Date.now(), initialTask ?? null, hasTask ? 'pending' : null, key.instancePath);
      const created = this.getTopic({ botId: key.botId, destination: topicDestination(key.chatId, key.threadId) })!;
      if (created.instancePath !== key.instancePath) throw new Error('This topic history belongs to a different instance path');
      if (Number(result.changes) && runtime.kind === 'managed') this.setPendingSessionTitle(created.id,name);
      if (Number(result.changes) && hasTask && initialUserId) {
        this.db.prepare('INSERT INTO initial_users VALUES (?,?)').run(created.id,initialUserId);
        if (authorityUserId) this.db.prepare('INSERT INTO initial_authorities VALUES (?,?)').run(created.id,authorityUserId);
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
  getPendingSessionTitle(id: string): string | undefined {
    const row = this.db.prepare('SELECT title FROM session_pending_titles WHERE session_id=?').get(id);
    return row ? String(row.title) : undefined;
  }
  setPendingSessionTitle(id: string, title: string | undefined): void {
    if (title === undefined) this.db.prepare('DELETE FROM session_pending_titles WHERE session_id=?').run(id);
    else this.db.prepare('INSERT INTO session_pending_titles VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET title=excluded.title').run(id,title);
  }
  getTopicTitlePrefix(id: string): string | undefined {
    const row = this.db.prepare('SELECT prefix FROM session_topic_title_prefixes WHERE session_id=?').get(id);
    return row ? String(row.prefix) : undefined;
  }
  setTopicTitlePrefix(id: string, prefix: string): void {
    this.db.prepare('INSERT INTO session_topic_title_prefixes VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET prefix=excluded.prefix').run(id,prefix);
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
  getInitialAuthority(id: string): number | undefined {
    const row = this.db.prepare('SELECT user_id FROM initial_authorities WHERE session_id=?').get(id);
    return row ? Number(row.user_id) : undefined;
  }
  getInitialImages(id: string): ImageContent[] | undefined {
    const row = this.db.prepare('SELECT images FROM initial_images WHERE session_id=?').get(id);
    return row ? JSON.parse(String(row.images)) as ImageContent[] : undefined;
  }
  getInitialUser(id: string): number | undefined {
    const row = this.db.prepare('SELECT user_id FROM initial_users WHERE session_id=?').get(id);
    return row ? Number(row.user_id) : undefined;
  }
  getSessionEntry(id: string): {messageId: number; markup: string} | undefined {
    const row = this.db.prepare('SELECT message_id,markup FROM session_entries WHERE session_id=?').get(id);
    return row ? {messageId:Number(row.message_id),markup:String(row.markup)} : undefined;
  }
  setSessionEntry(id: string, messageId: number, markup: string): void {
    this.db.prepare('INSERT INTO session_entries VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET message_id=excluded.message_id,markup=excluded.markup').run(id,messageId,markup);
  }
  clearSessionEntry(id: string): void {
    this.db.prepare('DELETE FROM session_entries WHERE session_id=?').run(id);
  }
  setReplyTarget(id: string, messageId: number | undefined): void {
    if (messageId === undefined) this.db.prepare('DELETE FROM reply_targets WHERE session_id=?').run(id);
    else this.db.prepare('INSERT INTO reply_targets VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET message_id=excluded.message_id').run(id,messageId);
  }
  getReplyTarget(id: string): number | undefined {
    const row = this.db.prepare('SELECT message_id FROM reply_targets WHERE session_id=?').get(id);
    return row ? Number(row.message_id) : undefined;
  }
  getTopicFinishIcon(id: string): string | undefined {
    const row = this.db.prepare('SELECT icon_id FROM session_topic_finish_icons WHERE session_id=?').get(id);
    return row ? String(row.icon_id) : undefined;
  }
  setTopicFinishIcon(id: string, iconId: string | undefined): void {
    if (iconId === undefined) this.db.prepare('DELETE FROM session_topic_finish_icons WHERE session_id=?').run(id);
    else this.db.prepare('INSERT INTO session_topic_finish_icons VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET icon_id=excluded.icon_id').run(id,iconId);
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
