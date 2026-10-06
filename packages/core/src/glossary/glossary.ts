import { and, asc, desc, eq } from 'drizzle-orm';
import { accreditor, framework, frameworkVersion, glossaryAlias, glossaryTerm, reportTemplate, requirement } from '@ams/db';
import type { CreateTerm, ExternalStandard, Glossary, GlossaryAlias, GlossaryTerm, SetAlias, UpdateTerm } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { classifyLevel, DEFAULT_TERMS, findingTermKey, REPORT_TERM_BY_KIND, type LevelStats } from './defaults.js';

type TermRow = typeof glossaryTerm.$inferSelect;
type AliasRow = typeof glossaryAlias.$inferSelect;
const termDto = (r: TermRow): GlossaryTerm => ({ id: r.id, key: r.key, kind: r.kind, labelEn: r.labelEn, labelAr: r.labelAr, definitionEn: r.definitionEn, definitionAr: r.definitionAr, active: r.active });
const aliasDto = (r: AliasRow): GlossaryAlias => ({ id: r.id, termId: r.termId, frameworkId: r.frameworkId, source: r.source, externalTerm: r.externalTerm });
const canEdit = (ctx: Ctx) => assertPermitted(ctx, 'framework:write', { type: 'institution' });

/** The institution's terms and every mapping from an external standard's words onto them. Readable by everyone in the institution. */
export async function getGlossary(ctx: Ctx): Promise<Glossary> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const terms = await ctx.tx.select().from(glossaryTerm).orderBy(asc(glossaryTerm.kind), asc(glossaryTerm.labelEn));
  const aliases = await ctx.tx.select().from(glossaryAlias);
  return { terms: terms.map(termDto), aliases: aliases.map(aliasDto) };
}

/** Adds the starter terms that are missing. Safe to run again; existing terms, including edited ones, are left alone. */
export async function seedDefaultGlossary(ctx: Ctx): Promise<{ added: number }> {
  assertHuman(ctx);
  await canEdit(ctx);
  const have = new Set((await ctx.tx.select({ key: glossaryTerm.key }).from(glossaryTerm)).map((t) => t.key));
  const missing = DEFAULT_TERMS.filter((t) => !have.has(t.key));
  if (missing.length) {
    await ctx.tx.insert(glossaryTerm).values(missing.map((t) => ({
      institutionId: ctx.caller.institutionId, key: t.key, kind: t.kind, labelEn: t.labelEn, definitionEn: t.definitionEn ?? null,
    })));
  }
  return { added: missing.length };
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 't_$1');

export async function createTerm(ctx: Ctx, input: CreateTerm): Promise<GlossaryTerm> {
  assertHuman(ctx);
  await canEdit(ctx);
  const key = input.key ?? slug(input.labelEn);
  if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new ValidationError('give the term a key of lower-case letters, digits and _');
  const [row] = await guardIntegrity(() => ctx.tx.insert(glossaryTerm).values({
    institutionId: ctx.caller.institutionId, key, kind: input.kind, labelEn: input.labelEn, labelAr: input.labelAr ?? null,
    definitionEn: input.definitionEn ?? null, definitionAr: input.definitionAr ?? null,
  }).returning()).catch((e) => { throw e instanceof ConflictError && /glossary_term_key_idx|duplicate/.test(e.message) ? new ConflictError(`a term with the key "${key}" already exists`) : e; });
  return termDto(row!);
}

export async function updateTerm(ctx: Ctx, id: string, patch: UpdateTerm): Promise<GlossaryTerm> {
  assertHuman(ctx);
  await canEdit(ctx);
  const [current] = await ctx.tx.select().from(glossaryTerm).where(eq(glossaryTerm.id, id));
  if (!current) throw new NotFoundError(`term ${id}`);
  const set: Partial<typeof glossaryTerm.$inferInsert> = {};
  if (patch.labelEn !== undefined) set.labelEn = patch.labelEn;
  if (patch.labelAr !== undefined) set.labelAr = patch.labelAr || null;
  if (patch.definitionEn !== undefined) set.definitionEn = patch.definitionEn || null;
  if (patch.definitionAr !== undefined) set.definitionAr = patch.definitionAr || null;
  if (patch.active === false && current.active) {
    const used = await ctx.tx.select({ id: glossaryAlias.id }).from(glossaryAlias).where(eq(glossaryAlias.termId, id)).limit(1);
    if (used.length) throw new ConflictError('standards still map to this term; map them elsewhere first');
    set.active = false;
  } else if (patch.active === true) set.active = true;
  if (Object.keys(set).length === 0) return termDto(current);
  const [row] = await ctx.tx.update(glossaryTerm).set(set).where(eq(glossaryTerm.id, id)).returning();
  return termDto(row!);
}

/** The newest published version of a standard, or its newest version when none is published. */
async function latestVersions(ctx: Ctx) {
  const rows = await ctx.tx.select({ v: frameworkVersion, f: framework, a: accreditor }).from(frameworkVersion)
    .innerJoin(framework, eq(framework.id, frameworkVersion.frameworkId)).innerJoin(accreditor, eq(accreditor.id, framework.accreditorId))
    .orderBy(desc(frameworkVersion.createdAt));
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = best.get(r.f.id);
    if (!cur || (cur.v.status !== 'published' && r.v.status === 'published')) best.set(r.f.id, r);
  }
  return [...best.values()].sort((a, b) => a.a.shortName.localeCompare(b.a.shortName) || a.f.name.localeCompare(b.f.name));
}

/** How each requirement level of a version sits in its tree, from the requirement rows themselves. */
export function levelStats(reqs: { id: string; parentId: string | null; levelLabel: string; isAssessable: boolean }[]): LevelStats[] {
  const hasChildren = new Set(reqs.map((r) => r.parentId).filter((p): p is string => !!p));
  const by = new Map<string, typeof reqs>();
  for (const r of reqs) by.set(r.levelLabel, [...(by.get(r.levelLabel) ?? []), r]);
  return [...by.entries()].map(([label, rs]) => ({
    label, allTopLevel: rs.every((r) => r.parentId === null), noneAssessable: rs.every((r) => !r.isAssessable), allHaveChildren: rs.every((r) => hasChildren.has(r.id)),
  }));
}

/** Every external term of every standard (levels, finding names, report types) with its current mapping and the structural suggestion. */
export async function listExternalTerms(ctx: Ctx): Promise<ExternalStandard[]> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const terms = new Map((await ctx.tx.select().from(glossaryTerm)).map((t) => [t.key, t]));
  const termByKey = (k: string | undefined) => (k ? terms.get(k)?.key ?? null : null);
  const aliases = await ctx.tx.select().from(glossaryAlias);
  const mapped = new Map(aliases.map((a) => [`${a.frameworkId}|${a.source}|${a.externalTerm}`, a.termId]));
  const out: ExternalStandard[] = [];
  for (const { v, f, a } of await latestVersions(ctx)) {
    const reqs = await ctx.tx.select({ id: requirement.id, parentId: requirement.parentId, levelLabel: requirement.levelLabel, isAssessable: requirement.isAssessable }).from(requirement).where(eq(requirement.frameworkVersionId, v.id));
    const templates = await ctx.tx.select({ key: reportTemplate.key, name: reportTemplate.name, kind: reportTemplate.kind }).from(reportTemplate).where(eq(reportTemplate.frameworkVersionId, v.id)).orderBy(asc(reportTemplate.key));
    const findings = (v.findingVocab as { code: string; label: string; requires_action: boolean }[] | null) ?? [];
    const row = (source: 'level_label' | 'finding_code' | 'report_template', externalTerm: string, detail: string, suggested: string | undefined) => ({
      source, externalTerm, detail, termId: mapped.get(`${f.id}|${source}|${externalTerm}`) ?? null, suggestedKey: termByKey(suggested),
    });
    out.push({
      frameworkId: f.id, accreditorShortName: a.shortName, name: f.name, edition: v.edition,
      terms: [
        ...levelStats(reqs).map((s) => row('level_label', s.label, `${reqs.filter((r) => r.levelLabel === s.label).length} requirements`, classifyLevel(s))),
        ...findings.map((x) => row('finding_code', x.code, `${x.label}${x.requires_action ? ' (needs action)' : ' (no action)'}`, findingTermKey(x.requires_action))),
        ...templates.map((t) => row('report_template', t.key, `${t.name} (${t.kind.replace('_', '-')})`, REPORT_TERM_BY_KIND[t.kind])),
      ],
    });
  }
  return out;
}

/** Maps one external term to an internal term, or clears the mapping with a null term. */
export async function setAlias(ctx: Ctx, input: SetAlias): Promise<void> {
  assertHuman(ctx);
  await canEdit(ctx);
  const standard = (await listExternalTerms(ctx)).find((s) => s.frameworkId === input.frameworkId);
  if (!standard) throw new NotFoundError(`standard ${input.frameworkId}`);
  if (!standard.terms.some((t) => t.source === input.source && t.externalTerm === input.externalTerm)) throw new ValidationError(`"${input.externalTerm}" is not a ${input.source.replace('_', ' ')} of this standard`);
  const where = and(eq(glossaryAlias.frameworkId, input.frameworkId), eq(glossaryAlias.source, input.source), eq(glossaryAlias.externalTerm, input.externalTerm));
  if (input.termId === null) { await ctx.tx.delete(glossaryAlias).where(where); return; }
  const [term] = await ctx.tx.select().from(glossaryTerm).where(eq(glossaryTerm.id, input.termId));
  if (!term) throw new NotFoundError(`term ${input.termId}`);
  if (!term.active) throw new ConflictError('that term is inactive');
  await guardIntegrity(async () => {
    const [existing] = await ctx.tx.select().from(glossaryAlias).where(where);
    if (existing) await ctx.tx.update(glossaryAlias).set({ termId: input.termId! }).where(eq(glossaryAlias.id, existing.id));
    else await ctx.tx.insert(glossaryAlias).values({ institutionId: ctx.caller.institutionId, termId: input.termId!, frameworkId: input.frameworkId, source: input.source, externalTerm: input.externalTerm });
  });
}

/** Applies the structural suggestion to every unmapped external term of one standard (or of all). Existing mappings are never changed. */
export async function autoMapStandards(ctx: Ctx, frameworkId?: string): Promise<{ mapped: number }> {
  assertHuman(ctx);
  await canEdit(ctx);
  const all = (await listExternalTerms(ctx)).filter((s) => !frameworkId || s.frameworkId === frameworkId);
  if (frameworkId && all.length === 0) throw new NotFoundError(`standard ${frameworkId}`);
  const terms = new Map((await ctx.tx.select().from(glossaryTerm)).map((t) => [t.key, t.id]));
  const rows = all.flatMap((s) => s.terms.filter((t) => !t.termId && t.suggestedKey && terms.has(t.suggestedKey))
    .map((t) => ({ institutionId: ctx.caller.institutionId, termId: terms.get(t.suggestedKey!)!, frameworkId: s.frameworkId, source: t.source, externalTerm: t.externalTerm })));
  if (rows.length) await ctx.tx.insert(glossaryAlias).values(rows);
  return { mapped: rows.length };
}
