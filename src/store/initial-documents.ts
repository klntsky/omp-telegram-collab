import type { DatabaseSync } from 'node:sqlite';
import type { PendingPromptContent } from '../../shared/contracts.js';
import type { PromptExtension } from '../telegram-commands.js';

export interface InitialDocumentSetup {
  automaticWorktree: boolean;
  extensions: PromptExtension[];
  preset?: string;
}

export class InitialDocuments {
  constructor(private readonly db: DatabaseSync) {}

  getSetup(id: string): InitialDocumentSetup | undefined {
    const row = this.db.prepare('SELECT setup FROM initial_document_setups WHERE session_id=?').get(id);
    return row ? JSON.parse(String(row.setup)) as InitialDocumentSetup : undefined;
  }

  setSetup(id: string, setup: InitialDocumentSetup | undefined): void {
    if (setup === undefined) {
      this.db.prepare('DELETE FROM initial_document_setups WHERE session_id=?').run(id);
    } else {
      this.db.prepare('INSERT INTO initial_document_setups VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET setup=excluded.setup')
        .run(id, JSON.stringify(setup));
    }
  }

  getPendingTask(id: string): PendingPromptContent | undefined {
    const row = this.db.prepare("SELECT initial_task FROM sessions WHERE id=? AND initial_state='pending' AND NOT EXISTS (SELECT 1 FROM initial_task_preparations WHERE session_id=sessions.id)").get(id);
    if (!row) return undefined;
    const images = this.db.prepare('SELECT images FROM initial_images WHERE session_id=?').get(id);
    const documents = this.db.prepare('SELECT documents FROM initial_documents WHERE session_id=?').get(id);
    return {
      text: String(row.initial_task),
      ...(images ? { images: JSON.parse(String(images.images)) } : {}),
      ...(documents ? { documents: JSON.parse(String(documents.documents)) } : {}),
    };
  }

  replacePendingTask(id: string, task: PendingPromptContent): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare("UPDATE sessions SET initial_task=? WHERE id=? AND initial_state='pending' AND status='open'").run(task.text, id);
      if (!Number(result.changes)) throw new Error('Session cannot update its initial task');
      if (task.documents?.length) {
        this.db.prepare('INSERT INTO initial_documents VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET documents=excluded.documents')
          .run(id, JSON.stringify(task.documents));
      } else {
        this.db.prepare('DELETE FROM initial_documents WHERE session_id=?').run(id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
