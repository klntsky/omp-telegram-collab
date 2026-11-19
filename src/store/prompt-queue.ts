import type { DatabaseSync } from 'node:sqlite';
import type { PendingPromptContent } from '../../shared/contracts.js';
import type { PromptExtension } from '../telegram-commands.js';

export interface PromptPreparation {
  skills?: string[];
  extensions?: PromptExtension[];
  preset?: string;
  automaticWorktree?: boolean;
  nativeSessionId?: string;
}

export interface NewSessionPrompt {
  messageId: number;
  userId: number;
  authorityUserId: number;
  content: PendingPromptContent;
  preparation?: PromptPreparation;
}
export type StartupRetry = { kind: 'retry'; availableAt: number } | { kind: 'absent' };


export interface QueuedPrompt {
  id: number;
  sessionId: string;
  messageId: number;
  userId: number;
  authorityUserId: number;
  content: PendingPromptContent;
  preparation?: PromptPreparation;
  state: 'pending' | 'submitted';
  submissionId?: number;
  acceptanceDeadline?: number;
  availableAt: number;
  attempts: number;
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

  private read(sessionId: string, first: boolean): QueuedPrompt[] {
    return this.db.prepare(`SELECT q.*, p.preparation FROM prompt_queue q
      LEFT JOIN prompt_queue_preparations p ON p.prompt_id=q.id WHERE q.session_id=? ORDER BY q.id${first ? ' LIMIT 1' : ''}`).all(sessionId).map(row => ({
      id: Number(row.id),
      sessionId: String(row.session_id),
      messageId: Number(row.message_id),
      userId: Number(row.user_id),
      authorityUserId: Number(row.authority_user_id),
      content: JSON.parse(String(row.content)) as PendingPromptContent,
      state: row.state as QueuedPrompt['state'],
      ...(row.submission_id === null ? {} : { submissionId: Number(row.submission_id) }),
      ...(row.acceptance_deadline === null ? {} : { acceptanceDeadline: Number(row.acceptance_deadline) }),
      availableAt: Number(row.available_at),
      attempts: Number(row.attempts),
      ...(row.preparation === null ? {} : { preparation: JSON.parse(String(row.preparation)) as PromptPreparation }),
    }));
  }

  list(sessionId: string): QueuedPrompt[] { return this.read(sessionId, false); }
  first(sessionId: string): QueuedPrompt | undefined { return this.read(sessionId, true)[0]; }

  markSubmitted(id: number, submissionId: number, deadline: number): void {
    this.db.prepare("UPDATE prompt_queue SET state='submitted',submission_id=?,acceptance_deadline=? WHERE id=? AND state='pending'").run(submissionId, deadline, id);
  }

  retryStartup(submissionId: number, now: number): StartupRetry {
    this.db.exec('SAVEPOINT retry_prompt');
    try {
      const row = this.db.prepare("SELECT id,attempts FROM prompt_queue WHERE submission_id=? AND state='submitted'").get(submissionId);
      let result: StartupRetry = { kind: 'absent' };
      if (row) {
        const availableAt = now + Math.min(1000, 250 * (Number(row.attempts) + 1));
        this.db.prepare("UPDATE prompt_queue SET state='pending',submission_id=NULL,acceptance_deadline=NULL,attempts=attempts+1,available_at=? WHERE id=?").run(availableAt, Number(row.id));
        result = { kind: 'retry', availableAt };
      }
      this.db.exec('RELEASE retry_prompt');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO retry_prompt; RELEASE retry_prompt');
      throw error;
    }
  }

  completeSubmission(submissionId: number): void {
    this.db.prepare("DELETE FROM prompt_queue WHERE submission_id=? AND state='submitted'").run(submissionId);
  }

  recoverSubmissions(botId: number): void {
    this.db.exec('SAVEPOINT recover_prompt_submissions');
    try {
      this.db.prepare(`UPDATE prompt_submissions SET state='uncertain' WHERE state='pending' AND id IN
        (SELECT q.submission_id FROM prompt_queue q JOIN sessions s ON s.id=q.session_id WHERE s.bot_id=? AND q.state='submitted')`).run(botId);
      this.db.prepare("DELETE FROM prompt_queue WHERE state='submitted' AND session_id IN (SELECT id FROM sessions WHERE bot_id=?)").run(botId);
      this.db.exec('RELEASE recover_prompt_submissions');
    } catch (error) {
      this.db.exec('ROLLBACK TO recover_prompt_submissions; RELEASE recover_prompt_submissions');
      throw error;
    }
  }

  replaceContent(id: number, content: PendingPromptContent): void {
    this.db.prepare('UPDATE prompt_queue SET content=? WHERE id=?').run(JSON.stringify(content), id);
  }

  replacePreparation(id: number, preparation: PromptPreparation): void {
    this.db.prepare(`INSERT INTO prompt_queue_preparations (prompt_id,preparation) VALUES (?,?)
      ON CONFLICT(prompt_id) DO UPDATE SET preparation=excluded.preparation`).run(id, JSON.stringify(preparation));
  }

  replacePreparedContent(id: number, content: PendingPromptContent, preparation: PromptPreparation): void {
    // Replaying skill expansion after a crash duplicates directives unless its checkpoint commits with it.
    this.db.exec('SAVEPOINT prepare_prompt_content');
    try {
      this.replaceContent(id, content);
      this.replacePreparation(id, preparation);
      this.db.exec('RELEASE prepare_prompt_content');
    } catch (error) {
      this.db.exec('ROLLBACK TO prepare_prompt_content; RELEASE prepare_prompt_content');
      throw error;
    }
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
