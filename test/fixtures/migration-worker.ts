import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../../src/migrations.js';

const db = new DatabaseSync(process.argv[2]!);
process.once('message', message => {
  if (message !== 'initialize') throw new Error('Unexpected migration barrier message');
  process.send!('entering');
  try {
    initializeDatabase(db);
  } finally { db.close(); }
  process.send!('finished', () => process.disconnect!());
});
process.send!('ready');
