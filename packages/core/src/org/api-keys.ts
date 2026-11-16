// API keys (DEC-040): how another system calls the API. An administrator issues a key with a name and a role; the key acts as a service user
// of its own, with that role across the institution, so the permissions, row-level security and audit trail apply to it as to a person.
// The key is `ams_<key id>_<secret>`: shown once, only the SHA-256 of the whole key is stored, and it is compared in constant time.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { apiKey, appUser, roleAssignment } from '@ams/db';
import { API_KEY_ROLES, CreateApiKeySchema, type ApiKey, type CreateApiKey, type IssuedApiKey } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';

const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const KEY = /^ams_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{32,})$/;

/** The key id a presented key names, or null when it is not one of ours (the session is tried instead). */
export function apiKeyId(token: string): string | null {
  return KEY.exec(token)?.[1] ?? null;
}
/** Whether a presented key matches the stored hash, in constant time. */
export function apiKeyValid(token: string, storedHash: string): boolean {
  const a = Buffer.from(hash(token), 'hex'); const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function toDtos(ctx: Ctx, rows: (typeof apiKey.$inferSelect)[]): Promise<ApiKey[]> {
  const ids = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
  const names = ids.length ? new Map((await ctx.tx.select({ id: appUser.id, n: appUser.fullName }).from(appUser).where(inArray(appUser.id, ids))).map((u) => [u.id, u.n])) : new Map<string, string>();
  return rows.map((r) => ({
    id: r.id, name: r.name, role: r.role as ApiKey['role'], hint: r.hint, createdAt: r.createdAt.toISOString(), createdByName: r.createdBy ? names.get(r.createdBy) ?? null : null,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null, expiresAt: r.expiresAt?.toISOString() ?? null, revokedAt: r.revokedAt?.toISOString() ?? null,
  }));
}

export async function listApiKeys(ctx: Ctx): Promise<ApiKey[]> {
  await assertPermitted(ctx, 'institution:write', { type: 'institution' });
  return toDtos(ctx, await ctx.tx.select().from(apiKey).orderBy(desc(apiKey.createdAt)));
}

/** Issues a key: its service user, its role across the institution, and the key itself, returned this once. */
export async function createApiKey(ctx: Ctx, input: CreateApiKey): Promise<IssuedApiKey> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'institution:write', { type: 'institution' });
  const { name, role, expiresAt } = CreateApiKeySchema.parse(input);
  if (!(API_KEY_ROLES as readonly string[]).includes(role)) throw new ConflictError(`a key cannot have the role ${role}`);
  const id = randomUUID();
  const token = `ams_${id}_${randomBytes(32).toString('base64url')}`;
  const [user] = await ctx.tx.insert(appUser).values({ institutionId: ctx.caller.institutionId, fullName: `API key: ${name.normalize('NFC').trim()}`, email: `api-key-${id}@api-keys.invalid` }).returning({ id: appUser.id });
  await ctx.tx.insert(roleAssignment).values({ institutionId: ctx.caller.institutionId, userId: user!.id, role, scopeType: 'institution', scopeId: ctx.caller.institutionId });
  const [row] = await ctx.tx.insert(apiKey).values({
    id, institutionId: ctx.caller.institutionId, name: name.normalize('NFC').trim(), userId: user!.id, role, tokenHash: hash(token), hint: token.slice(-4),
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  }).returning();
  return { key: (await toDtos(ctx, [row!]))[0]!, token };
}

/** Revokes a key for good (it is kept for the audit trail); its service user is deactivated with it. */
export async function revokeApiKey(ctx: Ctx, id: string): Promise<ApiKey> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'institution:write', { type: 'institution' });
  const [row] = await ctx.tx.select().from(apiKey).where(eq(apiKey.id, id));
  if (!row) throw new NotFoundError(`API key ${id}`);
  if (row.revokedAt) return (await toDtos(ctx, [row]))[0]!;
  const [done] = await ctx.tx.update(apiKey).set({ revokedAt: new Date() }).where(and(eq(apiKey.id, id))).returning();
  await ctx.tx.update(appUser).set({ active: false }).where(eq(appUser.id, row.userId));
  return (await toDtos(ctx, [done!]))[0]!;
}
