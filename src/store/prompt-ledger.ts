import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { PromptContent, TopicSession } from '../../shared/contracts.js';
import type { MessageAnchor } from '../store.js';

// OMP's persisted blob identities hash decoded image bytes, not their base64 encoding.
// https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/blob-store.ts#L342-L360
function promptFingerprint(content: PromptContent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        content.text,
        (content.images ?? []).map((image) => [
          image.mimeType,
          /^blob:sha256:[a-f0-9]{64}$/.test(image.data)
            ? image.data.slice('blob:sha256:'.length)
            : createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex'),
        ]),
      ]),
    )
    .digest('hex');
}

// Queries share Store's connection so receipt/anchor updates stay in one transaction.
// Store alone owns connection initialization and closure.
export class PromptLedger {
  constructor(private readonly db: DatabaseSync, private readonly getSession: (id: string) => TopicSession | undefined) {}
  recordPromptSubmission(
    sessionId: string,
    ompSessionId: string,
    sender: string,
    content: PromptContent,
    messageId?: number,
  ): number {
    const result = this.db
      .prepare(
        "INSERT INTO prompt_submissions (session_id,omp_session_id,sender,message_id,fingerprint,state) VALUES (?,?,?,?,?,'pending')",
      )
      .run(sessionId, ompSessionId, sender, messageId ?? null, promptFingerprint(content));
    return Number(result.lastInsertRowid);
  }
  rejectPromptSubmission(submissionId: number): void {
    this.db.prepare('DELETE FROM prompt_submissions WHERE id=?').run(submissionId);
  }
  markPromptSubmissionUncertain(submissionId: number): void {
    this.db
      .prepare("UPDATE prompt_submissions SET state='uncertain' WHERE id=? AND state='pending'")
      .run(submissionId);
  }
  beginPromptReceiptSnapshot(sessionId: string, ompSessionId: string): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE prompt_submissions SET state='uncertain' WHERE session_id=? AND omp_session_id=? AND state='pending'")
        .run(sessionId, ompSessionId);
      const row = this.db.prepare('SELECT MAX(id) AS boundary FROM prompt_submissions WHERE session_id=? AND omp_session_id=?')
        .get(sessionId, ompSessionId);
      this.db.exec('COMMIT');
      return Number(row?.boundary ?? 0);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  recordPromptReceipt(
    sessionId: string,
    anchor: Omit<MessageAnchor, 'kind' | 'partIndex'>,
    sender: string | undefined,
    content: PromptContent,
    snapshotBoundary?: number,
  ): { fresh: boolean; messageId?: number; submissionId?: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db
        .prepare('SELECT message_id FROM prompt_receipts WHERE session_id=? AND omp_session_id=? AND entry_id=?')
        .get(sessionId, anchor.ompSessionId, anchor.entryId);
      if (previous) {
        if (typeof previous.message_id === 'number') {
          const session = this.getSession(sessionId)!;
          this.recordMessageAnchor(sessionId, session.chatId, previous.message_id, {...anchor, kind:'collab-prompt', partIndex:0});
        }
        this.db.exec('COMMIT');
        return {
          fresh: false,
          ...(previous.message_id === null ? {} : { messageId: Number(previous.message_id) }),
        };
      }
      const condition = 'session_id=? AND omp_session_id=? AND sender=? AND fingerprint=? AND (? IS NULL OR id<=?)';
      const parameters = [
        sessionId,
        anchor.ompSessionId,
        sender ?? '',
        promptFingerprint(content),
        snapshotBoundary ?? null,
        snapshotBoundary ?? null,
      ];
      const candidates =
        sender === undefined
          ? []
          : this.db
              .prepare(
                `SELECT id,message_id,state FROM prompt_submissions WHERE ${condition} ORDER BY id`,
              )
              .all(...parameters);
      const pending = candidates[0];
      const conflicting = candidates.length > 1 && candidates.some((row) => row.state !== 'pending');
      if (conflicting)
        this.db
          .prepare(`UPDATE prompt_submissions SET state='ambiguous' WHERE ${condition}`)
          .run(...parameters);
      const ambiguous = conflicting || pending?.state === 'ambiguous';
      const messageId = ambiguous ? undefined : pending?.message_id;
      this.db
        .prepare('INSERT INTO prompt_receipts VALUES (?,?,?,?)')
        .run(sessionId, anchor.ompSessionId, anchor.entryId, messageId ?? null);
      if (typeof messageId === 'number') {
        const session = this.getSession(sessionId)!;
        const aliases = this.db.prepare('SELECT message_id FROM prompt_message_aliases WHERE session_id=? AND source_message_id=?').all(sessionId, messageId);
        for (const id of [messageId, ...aliases.map(row => Number(row.message_id))])
          this.recordMessageAnchor(sessionId, session.chatId, id, {...anchor, kind:'collab-prompt', partIndex:0});
      }
      if (pending) {
        this.db.prepare('DELETE FROM prompt_submissions WHERE id=?').run(pending.id);
        if (pending.message_id !== null)
          this.db.prepare('DELETE FROM prompt_message_aliases WHERE session_id=? AND source_message_id=?').run(sessionId, pending.message_id);
      }
      this.db.exec('COMMIT');
      return {
        fresh: true,
        ...(messageId === undefined || messageId === null ? {} : { messageId: Number(messageId) }),
        ...(pending && !ambiguous ? { submissionId: Number(pending.id) } : {}),
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  recordPromptMessageAlias(sessionId: string, sourceMessageId: number, messageId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO prompt_message_aliases VALUES (?,?,?)').run(sessionId, sourceMessageId, messageId);
  }
  getMessageAnchor(sessionId: string, ompSessionId: string, chatId: number, messageId: number): MessageAnchor | undefined {
    const row = this.db.prepare('SELECT entry_id,parent_entry_id,kind,part_index FROM message_anchors WHERE session_id=? AND omp_session_id=? AND chat_id=? AND message_id=?').get(sessionId, ompSessionId, chatId, messageId);
    return row ? {
      ompSessionId,
      entryId:String(row.entry_id),
      parentEntryId:row.parent_entry_id === null ? null : String(row.parent_entry_id),
      kind:row.kind as MessageAnchor['kind'],
      partIndex:Number(row.part_index),
    } : undefined;
  }
  recordMessageAnchor(sessionId: string, chatId: number, messageId: number, anchor: MessageAnchor): void {
    const previous = this.getMessageAnchor(sessionId, anchor.ompSessionId, chatId, messageId);
    if (previous) {
      if (previous.entryId !== anchor.entryId || previous.parentEntryId !== anchor.parentEntryId ||
          previous.kind !== anchor.kind || previous.partIndex !== anchor.partIndex)
        throw new Error(`Conflicting message anchor for session ${sessionId}, OMP session ${anchor.ompSessionId}, chat ${chatId}, message ${messageId}`);
      return;
    }
    this.db.prepare('INSERT INTO message_anchors VALUES (?,?,?,?,?,?,?,?)')
      .run(sessionId, anchor.ompSessionId, chatId, messageId, anchor.entryId, anchor.parentEntryId, anchor.kind, anchor.partIndex);
  }
  rememberReply(id: string, ompSessionId: string, entryId: string): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO replies VALUES (?,?,?)').run(id, ompSessionId, entryId);
    return Number(result.changes) === 1;
  }
  hasSnapshot(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM snapshot_baselines WHERE session_id=?').get(id));
  }
  markSnapshot(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO snapshot_baselines VALUES (?)').run(id);
  }
}
