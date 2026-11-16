import type { DatabaseSync } from 'node:sqlite';
import type { PendingPromptContent } from '../../shared/contracts.js';
import type { PromptExtension } from '../telegram-commands.js';

export interface PromptPreparation {
  skills?: string[];
  extensions?: PromptExtension[];
  preset?: string;
}

export interface QueuedPrompt {
  id: number;
  sessionId: string;
  messageId: number;
  userId: number;
  authorityUserId: number;
  content: PendingPromptContent;
  preparation?: PromptPreparation;
}

export class PromptQueue {
  constructor(private readonly db: DatabaseSync) {}

  enqueue(sessionId: string, messageId: number, userId: number, authorityUserId: number, content: PendingPromptContent, preparation?: PromptPreparation, onAdmitted?: () => void): number {
    this.db.exec('SAVEPOINT enqueue_prompt');
    try {
      const admitted = this.db.prepare(`INSERT INTO prompt_admissions (session_id,message_id) VALUES (?,?)
        ON CONFLICT(session_id,message_id) DO NOTHING RETURNING id`).get(sessionId, messageId);
      const id = Number(admitted?.id ?? this.db.prepare('SELECT id FROM prompt_admissions WHERE session_id=? AND message_id=?').get(sessionId, messageId)!.id);
      // Admission outlives the pending payload: retries must not resurrect sent or cancelled prompts.
      if (admitted) {
        this.db.prepare('INSERT INTO prompt_queue (id,session_id,message_id,user_id,authority_user_id,content) VALUES (?,?,?,?,?,?)')
          .run(id, sessionId, messageId, userId, authorityUserId, JSON.stringify(content));
        if (preparation) this.replacePreparation(id, preparation);
        onAdmitted?.();
      }
      this.db.exec('RELEASE enqueue_prompt');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK TO enqueue_prompt; RELEASE enqueue_prompt');
      throw error;
    }
  }

  list(sessionId: string): QueuedPrompt[] {
    return this.db.prepare(`SELECT q.*, p.preparation FROM prompt_queue q
      LEFT JOIN prompt_queue_preparations p ON p.prompt_id=q.id WHERE q.session_id=? ORDER BY q.id`).all(sessionId).map(row => ({
      id: Number(row.id),
      sessionId: String(row.session_id),
      messageId: Number(row.message_id),
      userId: Number(row.user_id),
      authorityUserId: Number(row.authority_user_id),
      content: JSON.parse(String(row.content)) as PendingPromptContent,
      ...(row.preparation === null ? {} : { preparation: JSON.parse(String(row.preparation)) as PromptPreparation }),
    }));
  }

  replaceContent(id: number, content: PendingPromptContent): void {
    this.db.prepare('UPDATE prompt_queue SET content=? WHERE id=?').run(JSON.stringify(content), id);
  }

  replacePreparation(id: number, preparation: PromptPreparation): void {
    this.db.prepare(`INSERT INTO prompt_queue_preparations (prompt_id,preparation) VALUES (?,?)
      ON CONFLICT(prompt_id) DO UPDATE SET preparation=excluded.preparation`).run(id, JSON.stringify(preparation));
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM prompt_queue WHERE id=?').run(id);
  }

  cancel(sessionId: string): void {
    this.db.prepare('DELETE FROM prompt_queue WHERE session_id=?').run(sessionId);
  }

  contains(id: number): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM prompt_queue WHERE id=?').get(id));
  }

  has(sessionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM prompt_queue WHERE session_id=? LIMIT 1').get(sessionId));
  }
}
