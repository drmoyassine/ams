import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from '@ams/shared';
import { createApp } from './app.js';

const env = loadEnv();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

// TASK-006 replaces this with the Better Auth session lookup. Until then every protected route answers 401.
const { app } = createApp({ pool, authenticate: async () => null });

const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webRoot)) {
  app.use('/*', serveStatic({ root: relative(process.cwd(), webRoot) }));
  const index = readFileSync(`${webRoot}/index.html`, 'utf8');
  app.get('*', (c) => (c.req.path.startsWith('/api') ? c.json({ error: 'not_found' }, 404) : c.html(index)));
}

serve({ fetch: app.fetch, port: env.PORT });
console.log(JSON.stringify({ level: 'info', msg: 'api listening', port: env.PORT }));
