import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { sql } from 'drizzle-orm';

export type Tx = NodePgDatabase;

/** Who is acting. `userId` is null only for named system identities. */
export interface Identity {
  userId: string | null;
  institutionId: string;
  requestId: string;
  actorType?: 'user' | 'system' | 'ai';
  /** Database role for the transaction: the API uses ams_app, the worker ams_worker. */
  role?: 'ams_app' | 'ams_worker';
}

/**
 * The only way to reach the database (DEC-010). Opens a transaction, drops to a non-owner role so row-level
 * security applies, and sets the identity settings that RLS policies and the audit trigger read.
 * Commits when `fn` resolves, rolls back when it throws.
 */
export async function withIdentity<T>(pool: pg.Pool, identity: Identity, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const tx = drizzle(client);
    await tx.execute(sql.raw(`set local role ${identity.role ?? 'ams_app'}`));
    await tx.execute(sql`select
      set_config('app.user_id', ${identity.userId ?? ''}, true),
      set_config('app.institution_id', ${identity.institutionId}, true),
      set_config('app.request_id', ${identity.requestId}, true),
      set_config('app.actor_type', ${identity.actorType ?? (identity.userId ? 'user' : 'system')}, true)`);
    const out = await fn(tx);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

type Resolved = { userId: string; institutionId: string } | null;

async function asApp(pool: pg.Pool, sqlText: string, params: unknown[]): Promise<Resolved> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role ams_app');
    const { rows } = await client.query<{ user_id: string; institution_id: string }>(sqlText, params);
    await client.query('commit');
    const row = rows[0];
    return row ? { userId: row.user_id, institutionId: row.institution_id } : null;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Maps a Better Auth user id to the AMS caller, or null if that user has not been provisioned (or is inactive). */
export const resolveIdentity = (pool: pg.Pool, authUserId: string): Promise<Resolved> =>
  asApp(pool, 'select user_id, institution_id from app_resolve_identity($1)', [authUserId]);

/** Links a verified-email auth user to the app_user an administrator created for that address. */
export const linkIdentity = (pool: pg.Pool, authUserId: string, email: string): Promise<Resolved> =>
  asApp(pool, 'select user_id, institution_id from app_link_identity($1, $2)', [authUserId, email]);

/** Runs one lookup function as the API's role before any institution is known (the link routes). */
async function resolveLink<T>(pool: pg.Pool, sqlText: string, arg: string, map: (row: Record<string, string>) => T): Promise<T | null> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role ams_app');
    const { rows } = await client.query<Record<string, string>>(sqlText, [arg]);
    await client.query('commit');
    return rows[0] ? map(rows[0]) : null;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Finds the request a one-time response link opens (DEC-018), given the SHA-256 hex of the link's secret; null for a
 * used, expired, cancelled or unknown link.
 */
export const resolveRequestLink = (pool: pg.Pool, tokenHash: string) =>
  resolveLink(pool, 'select * from app_resolve_request_link($1)', tokenHash, (r) => ({ requestId: r.request_id!, institutionId: r.institution_id! }));

/**
 * What a collection run holds of its BI callback token (TASK-090): the institution, the token's hash and expiry and the run's status, by run
 * id, before any institution is known. Null when the run has no token (never issued, used, or cleared). The caller compares the hash in
 * constant time; this only reads.
 */
export const resolveCollectionCallback = (pool: pg.Pool, runId: string) =>
  resolveLink(pool, 'select * from app_resolve_collection_callback($1)', runId, (r) => ({
    institutionId: r.institution_id!, tokenHash: r.token_hash!, expiresAt: new Date(r.expires_at!), status: r.status!,
  }));

/** Finds the data item whose open form a public link answers (DEC-020); null when the form is closed or the link off. */
export const resolveFormLink = (pool: pg.Pool, token: string) =>
  resolveLink(pool, 'select * from app_resolve_form_link($1)', token, (r) => ({ itemId: r.evidence_item_id!, institutionId: r.institution_id! }));

/**
 * What the sign-in page may show before anyone is authenticated: the one institution's names, accent colour and logo
 * file, and nothing else (the SQL function selects exactly these columns, and returns nothing unless the deployment
 * has exactly one institution). Packages/core turns it into the public answer.
 */
export interface PublicBrandingRow {
  nameEn: string; nameAr: string | null; defaultLocale: string; accentColor: string | null;
  logoPath: string | null; logoMime: string | null; logoUpdatedAt: Date | null;
}
export async function resolvePublicBranding(pool: pg.Pool): Promise<PublicBrandingRow | null> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role ams_app');
    const { rows } = await client.query<{ name_en: string; name_ar: string | null; default_locale: string; accent_color: string | null; logo_path: string | null; logo_mime: string | null; logo_updated_at: Date | null }>('select * from app_public_branding()');
    await client.query('commit');
    const r = rows[0];
    return r ? { nameEn: r.name_en, nameAr: r.name_ar, defaultLocale: r.default_locale, accentColor: r.accent_color, logoPath: r.logo_path, logoMime: r.logo_mime, logoUpdatedAt: r.logo_updated_at } : null;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * What the sign-in page may read of the language setting before anyone is authenticated: the default and secondary
 * language codes of the one institution, and the text of exactly the keys asked for (the API passes the fixed sign-in key
 * list). Returns nothing unless the deployment has exactly one institution.
 */
export async function resolvePublicLanguages(pool: pg.Pool, keys: readonly string[]): Promise<{ defaultLocale: string; secondaryLanguage: string | null; strings: Record<string, string> } | null> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role ams_app');
    const l = await client.query<{ default_locale: string; secondary_language: string | null }>('select * from app_public_languages()');
    const s = await client.query<{ key: string; text: string }>('select * from app_public_ui_strings($1::text[])', [[...keys]]);
    await client.query('commit');
    const r = l.rows[0];
    return r ? { defaultLocale: r.default_locale, secondaryLanguage: r.secondary_language, strings: Object.fromEntries(s.rows.map((x) => [x.key, x.text])) } : null;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
