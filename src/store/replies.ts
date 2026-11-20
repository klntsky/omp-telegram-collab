import type { DatabaseSync } from 'node:sqlite';

export interface Reply {
  sessionId: string;
  ompSessionId: string;
  entryId: string;
  parentEntryId: string | null;
  parts: string[];
  replyTo?: number;
  generation: number;
  nextPart: number;
  state: 'pending' | 'done';
}

export class ReplyLedger {
  constructor(private readonly db: DatabaseSync) {}

  retryAfter(sessionId: string): number {
    return Number(this.db.prepare('SELECT retry_after FROM reply_cooldowns WHERE session_id=?').get(sessionId)?.retry_after ?? 0);
  }

  defer(sessionId: string, until: number): void {
    this.db.prepare(`INSERT INTO reply_cooldowns VALUES (?,?)
      ON CONFLICT(session_id) DO UPDATE SET retry_after=MAX(retry_after,excluded.retry_after)`).run(sessionId, until);
  }

  stage(sessionId: string, ompSessionId: string, entryId: string, parentEntryId: string | null,
    parts: string[], replyTo: number | undefined, generation: number, historical = false): void {
    this.db.prepare(`INSERT OR IGNORE INTO replies
      (session_id,omp_session_id,entry_id,parent_entry_id,parts,reply_to,generation,state)
      VALUES (?,?,?,?,?,?,?,?)`).run(sessionId, ompSessionId, entryId, parentEntryId,
      JSON.stringify(parts), replyTo ?? null, generation, historical || !parts.length ? 'done' : 'pending');
  }

  pending(sessionId: string): Reply[] {
    return this.db.prepare("SELECT * FROM replies WHERE session_id=? AND state='pending' ORDER BY id").all(sessionId).map(row => ({
      sessionId: String(row.session_id), ompSessionId: String(row.omp_session_id), entryId: String(row.entry_id),
      parentEntryId: row.parent_entry_id === null ? null : String(row.parent_entry_id),
      parts: JSON.parse(String(row.parts)) as string[],
      ...(row.reply_to === null ? {} : {replyTo: Number(row.reply_to)}),
      generation: Number(row.generation), nextPart: Number(row.next_part), state: 'pending',
    }));
  }

  confirm(reply: Reply, chatId: number, messageId: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`UPDATE replies SET next_part=next_part+1,
        state=CASE WHEN next_part+1>=json_array_length(parts) THEN 'done' ELSE 'pending' END
        WHERE session_id=? AND omp_session_id=? AND entry_id=? AND next_part=? AND state='pending'`)
        .run(reply.sessionId, reply.ompSessionId, reply.entryId, reply.nextPart);
      if (Number(result.changes) !== 1) throw new Error(`Reply checkpoint changed for session ${reply.sessionId}, entry ${reply.entryId}, part ${reply.nextPart}`);
      this.db.prepare('INSERT INTO message_anchors VALUES (?,?,?,?,?,?,?,?)').run(
        reply.sessionId, reply.ompSessionId, chatId, messageId, reply.entryId, reply.parentEntryId, 'assistant', reply.nextPart);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  fail(reply: Reply, error: unknown): void {
    this.db.prepare(`UPDATE replies SET error=? WHERE session_id=? AND omp_session_id=?
      AND entry_id=? AND next_part=? AND state='pending'`).run(
      error instanceof Error ? error.message : String(error), reply.sessionId, reply.ompSessionId, reply.entryId, reply.nextPart);
  }

  discard(reply: Reply): void {
    this.db.prepare(`UPDATE replies SET state='done' WHERE session_id=? AND omp_session_id=?
      AND entry_id=? AND next_part=? AND state='pending'`).run(reply.sessionId, reply.ompSessionId, reply.entryId, reply.nextPart);
  }
}
