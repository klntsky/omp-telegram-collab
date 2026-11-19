import type { DatabaseSync } from 'node:sqlite';
import { promptFingerprint } from './prompt-fingerprint.js';

export interface DatabaseMigration {
  from: number;
  to: number;
  apply(db: DatabaseSync): void;
}

export const databaseMigrations: readonly DatabaseMigration[] = [
  {
    from: 10,
    to: 11,
    apply(db) {
      db.exec(`
        CREATE TEMP TABLE submission_sequence AS SELECT seq FROM sqlite_sequence WHERE name='prompt_submissions';
        CREATE TABLE prompt_submissions_next (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          omp_session_id TEXT NOT NULL,
          sender TEXT NOT NULL,
          message_id INTEGER,
          text TEXT NOT NULL,
          fingerprint TEXT,
          unresolved_fingerprint TEXT,
          state TEXT NOT NULL CHECK(state IN ('pending','uncertain','ambiguous')),
          CHECK((fingerprint IS NOT NULL) != (unresolved_fingerprint IS NOT NULL)),
          UNIQUE(session_id,omp_session_id,message_id)
        );
        INSERT INTO prompt_submissions_next (id,session_id,omp_session_id,sender,message_id,text,unresolved_fingerprint,state)
          SELECT id,session_id,omp_session_id,sender,message_id,text,fingerprint,state FROM prompt_submissions;
      `);
      const resolve = db.prepare('UPDATE prompt_submissions_next SET fingerprint=unresolved_fingerprint,unresolved_fingerprint=NULL WHERE text=? AND unresolved_fingerprint=?');
      for (const row of db.prepare('SELECT DISTINCT text,fingerprint FROM prompt_submissions').iterate()) {
        const text = String(row.text);
        const fingerprint = String(row.fingerprint);
        if (fingerprint === promptFingerprint({ text })) resolve.run(text, fingerprint);
      }
      db.exec(`
        DROP TABLE prompt_submissions;
        ALTER TABLE prompt_submissions_next RENAME TO prompt_submissions;
        UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM submission_sequence),0)) WHERE name='prompt_submissions';
        INSERT INTO sqlite_sequence (name,seq)
          SELECT 'prompt_submissions',seq FROM submission_sequence
          WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='prompt_submissions');
        DROP TABLE submission_sequence;
        CREATE TABLE prompt_receipts_next (
          session_id TEXT NOT NULL REFERENCES sessions(id),
          omp_session_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          message_id INTEGER,
          submitted_locally INTEGER CHECK(submitted_locally IN (0,1)),
          PRIMARY KEY(session_id,omp_session_id,entry_id)
        );
        INSERT INTO prompt_receipts_next SELECT session_id,omp_session_id,entry_id,message_id,submitted_locally FROM prompt_receipts;
        DROP TABLE prompt_receipts;
        ALTER TABLE prompt_receipts_next RENAME TO prompt_receipts;
      `);
    },
  },
];
