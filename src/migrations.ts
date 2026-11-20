import type { DatabaseSync } from 'node:sqlite';

const replySchema = `
CREATE TABLE replies (id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES sessions(id),omp_session_id TEXT NOT NULL,entry_id TEXT NOT NULL,parent_entry_id TEXT,parts TEXT NOT NULL,reply_to INTEGER,generation INTEGER NOT NULL,next_part INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL CHECK(state IN ('pending','done')),error TEXT,UNIQUE(session_id,omp_session_id,entry_id));
CREATE TABLE IF NOT EXISTS reply_cooldowns (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,retry_after INTEGER NOT NULL);`;

const schema = `
      CREATE TABLE IF NOT EXISTS groups (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,PRIMARY KEY(bot_id,chat_id));
      CREATE TABLE IF NOT EXISTS bot_status_topics (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL CHECK(thread_id>1),PRIMARY KEY(bot_id,chat_id));
      CREATE TABLE IF NOT EXISTS detached_topics (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,PRIMARY KEY(bot_id,chat_id,thread_id));
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,instance_id INTEGER NOT NULL CHECK(instance_id>0 AND instance_id<=9007199254740991),cwd TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,runtime TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(bot_id,chat_id,thread_id));
      CREATE TABLE IF NOT EXISTS snapshot_baselines (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS reply_targets (session_id TEXT PRIMARY KEY REFERENCES sessions(id),message_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_generations (session_id TEXT PRIMARY KEY REFERENCES sessions(id),generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_topic_finish_icons (session_id TEXT PRIMARY KEY REFERENCES sessions(id),icon_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_pending_close_icons (session_id TEXT PRIMARY KEY REFERENCES sessions(id));
      CREATE TABLE IF NOT EXISTS session_pending_titles (session_id TEXT PRIMARY KEY REFERENCES sessions(id),title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_topic_title_prefixes (session_id TEXT PRIMARY KEY REFERENCES sessions(id),prefix TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_entries (session_id TEXT PRIMARY KEY REFERENCES sessions(id),message_id INTEGER NOT NULL,markup TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS new_topic_skills (session_id TEXT PRIMARY KEY REFERENCES sessions(id),names TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_skills (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,user_id INTEGER NOT NULL,name TEXT NOT NULL,PRIMARY KEY(bot_id,chat_id,thread_id,user_id,name));
      CREATE TABLE IF NOT EXISTS skill_catalogs (instance_id INTEGER PRIMARY KEY,skills TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS setup_requests (code TEXT PRIMARY KEY,bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,user_id INTEGER NOT NULL,username TEXT,title TEXT NOT NULL,expires_at INTEGER NOT NULL,UNIQUE(bot_id,chat_id,user_id));
      CREATE TABLE IF NOT EXISTS settings_panels (bot_id INTEGER NOT NULL,token TEXT NOT NULL,panel TEXT NOT NULL,PRIMARY KEY(bot_id,token));
      CREATE TABLE prompt_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES sessions(id),omp_session_id TEXT NOT NULL,sender TEXT NOT NULL,message_id INTEGER,text TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','uncertain','ambiguous')),UNIQUE(session_id,omp_session_id,message_id));
      CREATE TABLE prompt_receipts (session_id TEXT NOT NULL REFERENCES sessions(id),omp_session_id TEXT NOT NULL,entry_id TEXT NOT NULL,message_id INTEGER,submitted_locally INTEGER NOT NULL CHECK(submitted_locally IN (0,1)),PRIMARY KEY(session_id,omp_session_id,entry_id));
      ${replySchema}
      CREATE TABLE prompt_message_aliases (session_id TEXT NOT NULL REFERENCES sessions(id),source_message_id INTEGER NOT NULL,message_id INTEGER NOT NULL,PRIMARY KEY(session_id,source_message_id,message_id));
      CREATE TABLE message_anchors (session_id TEXT NOT NULL REFERENCES sessions(id),omp_session_id TEXT NOT NULL,chat_id INTEGER NOT NULL,message_id INTEGER NOT NULL,entry_id TEXT NOT NULL,parent_entry_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('collab-prompt','assistant')),part_index INTEGER NOT NULL CHECK(part_index>=0),PRIMARY KEY(session_id,omp_session_id,chat_id,message_id));
      CREATE TABLE session_preparations (session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id),kind TEXT NOT NULL DEFAULT 'topic' CHECK(kind IN ('topic','fork')));
      CREATE TABLE worktree_confirmations (session_id TEXT PRIMARY KEY REFERENCES sessions(id),message_id INTEGER NOT NULL,admin_id INTEGER NOT NULL,token TEXT NOT NULL,identity TEXT NOT NULL);
`;

const promptQueueSchema = `CREATE TABLE IF NOT EXISTS prompt_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  authority_user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','submitted')),
  submission_id INTEGER UNIQUE,
  acceptance_deadline INTEGER,
  available_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id,message_id)
);
-- Keep only source identity after dequeue, including session deletion; no prompt payload or session cascade belongs here.
CREATE TABLE IF NOT EXISTS prompt_admissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  UNIQUE(session_id,message_id)
);
CREATE TABLE IF NOT EXISTS prompt_queue_preparations (
  prompt_id INTEGER PRIMARY KEY REFERENCES prompt_queue(id) ON DELETE CASCADE,
  preparation TEXT NOT NULL
);`;

function upgradeReplies(db: DatabaseSync, version: 10 | 11): void {
  db.exec('ALTER TABLE replies RENAME TO replies_before_upgrade');
  db.exec(replySchema);
  if (version === 10) {
    // The old rows meant "seen", including copied history, not confirmed delivery.
    // Preserve that exclusion rather than replaying whole conversations on upgrade.
    db.exec(`INSERT INTO replies (session_id,omp_session_id,entry_id,parts,generation,state)
      SELECT r.session_id,r.omp_session_id,r.entry_id,'[]',COALESCE(g.generation,0),'done'
      FROM replies_before_upgrade r LEFT JOIN session_generations g ON g.session_id=r.session_id`);
  } else {
    db.exec(`INSERT INTO replies
      SELECT id,session_id,omp_session_id,entry_id,parent_entry_id,parts,reply_to,generation,next_part,
        CASE WHEN state='uncertain' THEN 'pending' ELSE state END,error
      FROM replies_before_upgrade`);
  }
  db.exec('DROP TABLE replies_before_upgrade');
}

export function initializeDatabase(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version !== 0 && version !== 10 && version !== 11 && version !== 12)
      throw new Error(`Unsupported database schema version ${version}`);
    if (version === 0) {
      const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
      if (existing) throw new Error('Unsupported existing database');
      db.exec(schema);
    }
    if (version === 10 || version === 11) upgradeReplies(db, version);
    db.exec(promptQueueSchema);
    if (version !== 12) db.exec('PRAGMA user_version=12');
    db.exec('COMMIT');
  } catch (error) {
    try { if (db.isTransaction) db.exec('ROLLBACK'); }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError],
        `${error instanceof Error ? error.message : String(error)}\n${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw error;
  }
}
