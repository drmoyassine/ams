import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { biRuntimeFromEnv, findLibreOffice, s3Store } from '@ams/core';
import { loadEnv } from '@ams/shared';
import { startWorker } from './worker.js';

const env = loadEnv();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const boss = new PgBoss(env.DATABASE_URL);
boss.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'pg-boss', err: String(err) })));

await boss.start();
// One entry point for the three background services (DEC-024); which one this is comes from WORKER_QUEUES / WORKER_NAME.
const bi = biRuntimeFromEnv(env);
const queues = await startWorker(boss, pool, { store: s3Store(env), queues: env.WORKER_QUEUES, bi });
console.log(JSON.stringify({ level: 'info', msg: 'worker started', name: env.WORKER_NAME, queues }));
if (queues.includes('collect_tick')) console.log(JSON.stringify({ level: 'info', msg: bi.config.baseUrl ? 'bi configured' : 'bi not configured: runs of the bi method fail with that reason until BI_BASE_URL is set' }));
// The service that reads documents (extract_text) reads PDF, Word, Excel, CSV and images with the owned liteparse; only the
// temporary fallback formats (PowerPoint, OpenDocument, RTF, legacy DOC/XLS) need LibreOffice (DEC-011).
if (queues.includes('extract_text')) {
  const soffice = await findLibreOffice();
  console.log(JSON.stringify(soffice
    ? { level: 'info', msg: 'libreoffice found', path: soffice }
    : { level: 'warn', msg: 'libreoffice (soffice) NOT found: PowerPoint, OpenDocument, RTF and legacy DOC/XLS files will fail to read; PDF, DOCX, XLSX, CSV and images are unaffected' }));
}

const shutdown = async () => {
  await boss.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
