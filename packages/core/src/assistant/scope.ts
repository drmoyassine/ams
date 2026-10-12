// What a memory (or a context chip) is ABOUT, who may read it and who may write it. The assistant inherits exactly the signed-in
// person's privileges (DEC-027): a scope can be read by whoever can read the thing itself, so removing someone's access to a
// standard removes the memory written about it, at read time, without copying anything.
import { eq, inArray } from 'drizzle-orm';
import { accreditor, engagement, framework, frameworkVersion, institution } from '@ams/db';
import type { MemoryScope, MemoryScopeType } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { isPermitted } from '../permissions.js';

export interface ScopeRef { type: MemoryScopeType; id: string | null }
const key = (s: ScopeRef) => `${s.type}:${s.id ?? ''}`;

/** "IC 2025": the accreditor's short name and the edition, as people read a version. */
export const versionName = (accreditorShort: string, edition: string) => `${accreditorShort} ${edition}`;

/**
 * The readable names of scopes, and which of them exist for this person (row-level security hides other institutions'). A
 * scope that is missing from the map does not exist (or is not visible).
 */
export async function scopeLabels(ctx: Ctx, scopes: readonly ScopeRef[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = (t: MemoryScopeType) => [...new Set(scopes.filter((s) => s.type === t && s.id).map((s) => s.id!))];
  if (scopes.some((s) => s.type === 'institution')) {
    const [inst] = await ctx.tx.select({ name: institution.nameEn }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
    out.set(key({ type: 'institution', id: null }), inst?.name ?? 'The whole institution');
  }
  const fw = ids('framework');
  if (fw.length) {
    for (const r of await ctx.tx.select({ id: framework.id, name: framework.name, short: accreditor.shortName }).from(framework)
      .innerJoin(accreditor, eq(accreditor.id, framework.accreditorId)).where(inArray(framework.id, fw))) {
      out.set(key({ type: 'framework', id: r.id }), r.name.toLowerCase().startsWith(r.short.toLowerCase()) ? r.name : `${r.short} ${r.name}`);
    }
  }
  const vs = ids('version');
  if (vs.length) {
    for (const r of await ctx.tx.select({ id: frameworkVersion.id, edition: frameworkVersion.edition, short: accreditor.shortName }).from(frameworkVersion)
      .innerJoin(framework, eq(framework.id, frameworkVersion.frameworkId)).innerJoin(accreditor, eq(accreditor.id, framework.accreditorId))
      .where(inArray(frameworkVersion.id, vs))) {
      out.set(key({ type: 'version', id: r.id }), versionName(r.short, r.edition));
    }
  }
  const en = ids('engagement');
  if (en.length) {
    for (const r of await ctx.tx.select({ id: engagement.id, title: engagement.title }).from(engagement).where(inArray(engagement.id, en))) {
      out.set(key({ type: 'engagement', id: r.id }), r.title);
    }
  }
  return out;
}

export const labelOf = (labels: Map<string, string>, s: ScopeRef) => labels.get(key(s)) ?? 'Something you can no longer open';
export const toMemoryScope = (labels: Map<string, string>, s: ScopeRef): MemoryScope => ({ type: s.type, id: s.id, label: labelOf(labels, s) });

/** Remembers answers within one request, so a long memory list asks about each scope once. */
export class ScopeAccess {
  private readonly read = new Map<string, boolean>();
  private readonly write = new Map<string, boolean>();
  constructor(private readonly ctx: Ctx, private readonly labels?: Map<string, string>) {}

  private async exists(s: ScopeRef): Promise<boolean> {
    if (s.type === 'institution') return true;
    if (!s.id) return false;
    const labels = this.labels ?? await scopeLabels(this.ctx, [s]);
    return labels.has(key(s));
  }

  /** Can the person read this scope: the framework library for standards and versions, the engagement itself for an engagement. */
  async canRead(s: ScopeRef): Promise<boolean> {
    const k = key(s);
    const known = this.read.get(k);
    if (known !== undefined) return known;
    let ok: boolean;
    if (s.type === 'institution') ok = await isPermitted(this.ctx.tx, 'org:read', { type: 'any' });
    else if (!(await this.exists(s))) ok = false;
    else if (s.type === 'engagement') ok = await isPermitted(this.ctx.tx, 'engagement:read', { type: 'engagement', id: s.id! });
    else ok = await isPermitted(this.ctx.tx, 'framework:read', { type: 'any' });
    this.read.set(k, ok);
    return ok;
  }

  /**
   * Can the person write SHARED memory about this scope: ai:manage for the institution, framework:write for a standard or a
   * version, engagement:manage for an engagement (the same permissions that edit the thing itself).
   */
  async canWrite(s: ScopeRef): Promise<boolean> {
    const k = key(s);
    const known = this.write.get(k);
    if (known !== undefined) return known;
    let ok = false;
    if (await this.canRead(s)) {
      if (s.type === 'institution') ok = await isPermitted(this.ctx.tx, 'ai:manage', { type: 'institution' });
      else if (s.type === 'engagement') ok = await isPermitted(this.ctx.tx, 'engagement:manage', { type: 'engagement', id: s.id! });
      else ok = await isPermitted(this.ctx.tx, 'framework:write', { type: 'institution' });
    }
    this.write.set(k, ok);
    return ok;
  }
}
