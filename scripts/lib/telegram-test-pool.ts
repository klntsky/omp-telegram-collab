import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync } from 'node:fs';

export class TelegramTokenPool {
  readonly db: DatabaseSync;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(path: string) {
    try {
      const existing = lstatSync(path);
      if (!existing.isFile() || existing.uid !== process.getuid?.()) throw new Error('Unsafe token database path');
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS bots(token TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('free','busy','quarantined')), owner TEXT); UPDATE bots SET state='quarantined', owner=NULL WHERE state='busy'; COMMIT; BEGIN EXCLUSIVE;");
    } catch (error) { this.db.close(); throw error; }
  }
  seed(token: string): void {
    this.db.prepare("INSERT OR IGNORE INTO bots(token,state,owner) VALUES(?,'free',NULL)").run(token);
    this.#persist();
  }
  acquire(owner: string, create: () => Promise<string>, alive: () => boolean): Promise<string> {
    const operation = this.#tail.then(async () => {
      const free = this.db.prepare("SELECT token FROM bots WHERE state='free' LIMIT 1").get() as { token: string } | undefined;
      const token = free?.token ?? await create();
      const state = alive() ? 'busy' : 'quarantined';
      const connection = state === 'busy' ? owner : null;
      if (free) this.db.prepare("UPDATE bots SET state=?,owner=? WHERE token=? AND state='free'").run(state, connection, token);
      else this.db.prepare('INSERT INTO bots(token,state,owner) VALUES(?,?,?)').run(token, state, connection);
      this.#persist();
      return token;
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }
  release(owner: string, token: string): void {
    const result = this.db.prepare("UPDATE bots SET state='free',owner=NULL WHERE token=? AND state='busy' AND owner=?").run(token, owner);
    if (!result.changes) throw new Error('Token is not owned by this connection');
    this.#persist();
  }
  quarantine(owner: string): void {
    this.db.prepare("UPDATE bots SET state='quarantined',owner=NULL WHERE owner=? AND state='busy'").run(owner);
    this.#persist();
  }
  recover(token: string): void {
    const result = this.db.prepare("UPDATE bots SET state='free',owner=NULL WHERE token=? AND state='quarantined'").run(token);
    if (!result.changes) throw new Error('Token is not quarantined');
    this.#persist();
  }
  #persist(): void { this.db.exec('COMMIT; BEGIN EXCLUSIVE;'); }
  async close(): Promise<void> { await this.#tail; this.db.exec('COMMIT'); this.db.close(); }
}
