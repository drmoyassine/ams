import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { findLibreOffice, s3Store } from '@ams/core';
import { loadEnv } from '@ams/shared';
import { startWorker } from './worker.js';

const env = loadEnv();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const boss = new PgBoss(env.DATABASE_URL);
boss.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'pg-boss', err: String(err) })));

await boss.start();
// One entry point for the three background services (DEC-024); which one this is comes from WORKER_QUEUES / WORKER_NAME.
const queues = await startWorker(boss, pool, { store: s3Store(env), queues: env.WORKER_QUEUES });
console.log(JSON.stringify({ level: 'info', msg: 'worker started', name: env.WORKER_NAME, queues }));
// The service that reads documents (extract_text) needs LibreOffice for every format but PDF and images (DEC-011).
if (queues.includes('extract_text')) {
  const soffice = await findLibreOffice();
  console.log(JSON.stringify(soffice
    ? { level: 'info', msg: 'libreoffice found', path: soffice }
    : { level: 'warn', msg: 'libreoffice (soffice) NOT found: Word, Excel, PowerPoint, OpenDocument, RTF and CSV files will fail to read; only PDF and images work' }));
}

const shutdown = async () => {
  await boss.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
