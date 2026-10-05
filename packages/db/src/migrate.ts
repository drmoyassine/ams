import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.dirname is Node 21+; the fallback covers loaders that only provide import.meta.url.
const here = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
export const migrationsFolder = resolve(here, '../migrations');
/** The Appendix A framework files (WSCUC, ABET, PUC), used by tests and the optional demo seed. */
export const fixturesFolder = resolve(here, '../fixtures');

/** Applies committed SQL migrations (forward-only). Also used by tests against a throwaway database. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
