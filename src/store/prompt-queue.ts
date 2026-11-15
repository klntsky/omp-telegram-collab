import type { DatabaseSync } from 'node:sqlite';
import type { PendingPromptContent } from '../../shared/contracts.js';

export interface QueuedPrompt {
  id: number;
  sessionId: string;
  messageId: number;
  userId: number;
  authorityUserId: number;
  content: PendingPromptContent;
}

export class PromptQueue {
  constructor(private readonly db: DatabaseSync) {}

  enqueue(sessionId: string, messageId: number, userId: number, authorityUserId: number, content: PendingPromptContent): number {
    const row = this.db.prepare(`INSERT INTO prompt_queue (session_id,message_id,user_id,authority_user_id,content) VALUES (?,?,?,?,?)
      ON CONFLICT(session_id,message_id) DO NOTHING RETURNING id`).get(sessionId, messageId, userId, authorityUserId, JSON.stringify(content));
    return Number(row?.id ?? this.db.prepare('SELECT id FROM prompt_queue WHERE session_id=? AND message_id=?').get(sessionId, messageId)!.id);
  }

  list(sessionId: string): QueuedPrompt[] {
    return this.db.prepare('SELECT * FROM prompt_queue WHERE session_id=? ORDER BY id').all(sessionId).map(row => ({
      id: Number(row.id),
      sessionId: String(row.session_id),
      messageId: Number(row.message_id),
      userId: Number(row.user_id),
      authorityUserId: Number(row.authority_user_id),
      content: JSON.parse(String(row.content)) as PendingPromptContent,
    }));
  }

  replaceContent(id: number, content: PendingPromptContent): void {
    this.db.prepare('UPDATE prompt_queue SET content=? WHERE id=?').run(JSON.stringify(content), id);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM prompt_queue WHERE id=?').run(id);
  }

  has(sessionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM prompt_queue WHERE session_id=? LIMIT 1').get(sessionId));
  }
}
