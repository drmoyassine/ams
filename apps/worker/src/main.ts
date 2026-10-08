import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { s3Store } from '@ams/core';
import { loadEnv } from '@ams/shared';
import { startWorker } from './worker.js';

const env = loadEnv();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const boss = new PgBoss(env.DATABASE_URL);
boss.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'pg-boss', err: String(err) })));

await boss.start();
await startWorker(boss, pool, { store: s3Store(env) });
console.log(JSON.stringify({ level: 'info', msg: 'worker started' }));

const shutdown = async () => {
  await boss.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
