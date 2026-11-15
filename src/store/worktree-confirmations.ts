import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TopicSession } from '../../shared/contracts.js';
import type { WorktreeTarget } from '../omp.js';

function identity(session: TopicSession, target: WorktreeTarget): string {
  return JSON.stringify([session.botId, session.chatId, session.threadId, target.path,
    target.dev, target.ino, target.gitDir, target.commonDir, target.sessionId]);
}

export class WorktreeConfirmations {
  constructor(private readonly db: DatabaseSync) {}

  issue(session: TopicSession, messageId: number, adminId: number, target: WorktreeTarget): string {
    const token = randomBytes(12).toString('base64url');
    this.db.prepare(`INSERT INTO worktree_confirmations(session_id,message_id,admin_id,token,identity)
      VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET message_id=excluded.message_id,
      admin_id=excluded.admin_id,token=excluded.token,identity=excluded.identity`)
      .run(session.id, messageId, adminId, token, identity(session, target));
    return token;
  }

  get(sessionId: string, messageId: number, token: string): { adminId: number; identity: string } | undefined {
    const row = this.db.prepare('SELECT admin_id,identity FROM worktree_confirmations WHERE session_id=? AND message_id=? AND token=?')
      .get(sessionId, messageId, token);
    return row ? { adminId: Number(row.admin_id), identity: String(row.identity) } : undefined;
  }

  matches(saved: { identity: string }, session: TopicSession, target: WorktreeTarget): boolean {
    return saved.identity === identity(session, target);
  }

  invalidate(sessionId: string, token: string): void {
    this.db.prepare('DELETE FROM worktree_confirmations WHERE session_id=? AND token=?').run(sessionId, token);
  }
}
