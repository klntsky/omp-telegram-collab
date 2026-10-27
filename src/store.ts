import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TopicKey, TopicSession } from '../shared/contracts.js';

type Row = Record<string, string | number | null>;
function session(row: Row | undefined): TopicSession | undefined {
  if (!row) return undefined;
  return { id: String(row.id), botId: Number(row.bot_id), chatId: Number(row.chat_id), threadId: Number(row.thread_id), name: String(row.name), status: row.status as TopicSession['status'], runtime: JSON.parse(String(row.runtime)) as TopicSession['runtime'], createdAt: Number(row.created_at) };
}
export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS groups (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,PRIMARY KEY(bot_id,chat_id));
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,runtime TEXT NOT NULL,created_at INTEGER NOT NULL,initial_task TEXT,initial_state TEXT,UNIQUE(bot_id,chat_id,thread_id));
      CREATE TABLE IF NOT EXISTS replies (session_id TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(session_id,fingerprint));
      CREATE TABLE IF NOT EXISTS snapshot_baselines (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS initial_users (session_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_requests (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,message_id INTEGER NOT NULL,user_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(bot_id,chat_id,message_id));`);
  }
  enrollGroup(botId: number, chatId: number): void { this.db.prepare('INSERT OR IGNORE INTO groups VALUES (?,?)').run(botId, chatId); }
  isEnrolled(botId: number, chatId: number): boolean { return Boolean(this.db.prepare('SELECT 1 FROM groups WHERE bot_id=? AND chat_id=?').get(botId, chatId)); }
  getSession(id: string): TopicSession | undefined { return session(this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Row | undefined); }
  getTopic(key: TopicKey): TopicSession | undefined { return session(this.db.prepare('SELECT * FROM sessions WHERE bot_id=? AND chat_id=? AND thread_id=?').get(key.botId, key.chatId, key.threadId) as Row | undefined); }
  createSession(key: TopicKey, name: string, runtime: TopicSession['runtime'] = { kind: 'managed' }, initialTask?: string, initialUserId?: number): TopicSession {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT OR IGNORE INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomBytes(16).toString('base64url'), key.botId, key.chatId, key.threadId, name, 'open', JSON.stringify(runtime), Date.now(), initialTask ?? null, initialTask ? 'pending' : null);
      const created = this.getTopic(key)!;
      if (Number(result.changes) && initialTask && initialUserId) {
        this.db.prepare('INSERT INTO initial_users VALUES (?,?)').run(created.id,initialUserId);
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
  claimInitialTask(id: string): string | undefined {
    const row = this.db.prepare("UPDATE sessions SET initial_state='submitted' WHERE id=? AND initial_state='pending' RETURNING initial_task").get(id) as Row | undefined;
    return row?.initial_task === undefined ? undefined : String(row.initial_task);
  }
  getInitialUser(id: string): number | undefined {
    const row = this.db.prepare('SELECT user_id FROM initial_users WHERE session_id=?').get(id);
    return row ? Number(row.user_id) : undefined;
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
  addTaskRequest(botId: number, chatId: number, messageId: number, userId: number, threadId: number): void {
    this.db.prepare('DELETE FROM task_requests WHERE created_at<?').run(Date.now() - 3600000);
    this.db.prepare('INSERT OR REPLACE INTO task_requests VALUES (?,?,?,?,?,?)').run(botId, chatId, messageId, userId, threadId, Date.now());
  }
  takeTaskRequest(botId: number, chatId: number, messageId: number, userId: number): boolean {
    return Number(this.db.prepare('DELETE FROM task_requests WHERE bot_id=? AND chat_id=? AND message_id=? AND user_id=? AND created_at>? RETURNING message_id').get(botId, chatId, messageId, userId, Date.now() - 3600000)?.message_id) === messageId;
  }
  close(): void { this.db.close(); }
}
