import type { DatabaseSync } from 'node:sqlite';

const schema = `
      CREATE TABLE IF NOT EXISTS groups (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,PRIMARY KEY(bot_id,chat_id));
      CREATE TABLE IF NOT EXISTS bot_status_topics (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL CHECK(thread_id>1),PRIMARY KEY(bot_id,chat_id));
      CREATE TABLE IF NOT EXISTS detached_topics (bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,PRIMARY KEY(bot_id,chat_id,thread_id));
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,bot_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,thread_id INTEGER NOT NULL,instance_id INTEGER NOT NULL CHECK(instance_id>0 AND instance_id<=9007199254740991),cwd TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,runtime TEXT NOT NULL,created_at INTEGER NOT NULL,initial_task TEXT,initial_state TEXT,UNIQUE(bot_id,chat_id,thread_id));
      CREATE TABLE IF NOT EXISTS snapshot_baselines (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS initial_users (session_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS initial_authorities (session_id TEXT PRIMARY KEY REFERENCES sessions(id),user_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS initial_images (session_id TEXT PRIMARY KEY REFERENCES sessions(id),images TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS initial_messages (session_id TEXT PRIMARY KEY REFERENCES sessions(id),message_id INTEGER NOT NULL);
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
      CREATE TABLE prompt_receipts (session_id TEXT NOT NULL REFERENCES sessions(id),omp_session_id TEXT NOT NULL,entry_id TEXT NOT NULL,message_id INTEGER,PRIMARY KEY(session_id,omp_session_id,entry_id));
      CREATE TABLE replies (session_id TEXT NOT NULL REFERENCES sessions(id),omp_session_id TEXT NOT NULL,entry_id TEXT NOT NULL,PRIMARY KEY(session_id,omp_session_id,entry_id));
      CREATE TABLE prompt_message_aliases (session_id TEXT NOT NULL REFERENCES sessions(id),source_message_id INTEGER NOT NULL,message_id INTEGER NOT NULL,PRIMARY KEY(session_id,source_message_id,message_id));
      CREATE TABLE message_anchors (session_id TEXT NOT NULL REFERENCES sessions(id),omp_session_id TEXT NOT NULL,chat_id INTEGER NOT NULL,message_id INTEGER NOT NULL,entry_id TEXT NOT NULL,parent_entry_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('collab-prompt','assistant')),part_index INTEGER NOT NULL CHECK(part_index>=0),PRIMARY KEY(session_id,omp_session_id,chat_id,message_id));
      CREATE TABLE initial_task_preparations (session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id),kind TEXT NOT NULL DEFAULT 'initial' CHECK(kind IN ('initial','fork')));
`;

export function initializeDatabase(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version !== 0 && version !== 6) throw new Error(`Unsupported database schema version ${version}; create a fresh database`);
    if (version === 0) {
      const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
      if (existing) throw new Error('Unsupported existing database; create a fresh database');
      db.exec(schema);
      db.exec('PRAGMA user_version=6');
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
