import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { bootstrapGarageFromEnv, ensureQueues, pgBossQueue, s3Store } from '@ams/core';
import { runMigrations } from '@ams/db';
import { loadEnv } from '@ams/shared';
import { createApp } from './app.js';
import { createAuth, sessionAuthenticator } from './auth.js';
import { seedAdmin, seedFrameworks, seedGlossary } from './seed.js';

const env = loadEnv();

// When the object store is a Garage node this deployment runs (GARAGE_ADMIN_URL set), prepare it before anything serves:
// layout, the S3 key, the bucket and the grant. Idempotent; a failure stops the start rather than serve half-configured.
// The parser, agent and worker services wait for this app to be healthy, so the bucket exists before they touch files.
const garage = await bootstrapGarageFromEnv(env, { log: (m) => console.log(JSON.stringify({ level: 'info', msg: 'garage bootstrap', detail: m })) });
if (garage) console.log(JSON.stringify({ level: 'info', msg: 'garage ready', ...garage }));

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

// Forward-only SQL migrations, applied before anything else touches the database. The worker never migrates.
await runMigrations(env.DATABASE_URL);

const boss = new PgBoss(env.DATABASE_URL);
boss.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'pg-boss', err: String(err) })));
await boss.start();
await ensureQueues(boss);

const auth = createAuth(pool, env);
if (await seedAdmin(pool, auth, env)) console.log(JSON.stringify({ level: 'info', msg: 'seeded institution and admin' }));
if (env.SEED_DEMO_FRAMEWORKS) {
  const added = await seedFrameworks(pool);
  if (added.length) console.log(JSON.stringify({ level: 'info', msg: 'seeded frameworks', added }));
}
{
  const g = await seedGlossary(pool);
  if (g.terms || g.mapped) console.log(JSON.stringify({ level: 'info', msg: 'seeded glossary', ...g }));
}

const { app } = createApp({ pool, authenticate: sessionAuthenticator(auth, pool), authHandler: auth.handler, queue: pgBossQueue(boss), store: s3Store(env) });

const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webRoot)) {
  app.use('/*', serveStatic({ root: relative(process.cwd(), webRoot) }));
  const index = readFileSync(`${webRoot}/index.html`, 'utf8');
  app.get('*', (c) => (c.req.path.startsWith('/api') ? c.json({ error: 'not_found' }, 404) : c.html(index)));
}

serve({ fetch: app.fetch, port: env.PORT });
console.log(JSON.stringify({ level: 'info', msg: 'api listening', port: env.PORT }));
