// Creating a report from a template (TASK-091, PRD 10.4 step 1). The template's structure is copied into report_section
// rows (a later template edit never changes a report), every requirement code resolves to a requirement id of the version
// now, and each section's owner defaults to the requirement's owner in the engagement, or — for a report about a subject —
// to the standard's champion (TASK-086), else nobody and flagged: nothing is guessed.
import { and, eq, sql } from 'drizzle-orm';
import {
  engagement, engagementRequirement, orgUnit, program, report, reportSection, reportSectionRequirement,
  reportTemplate, requirement, requirementChampion,
} from '@ams/db';
import {
  ReportTemplateStructureSchema, type CreateReport, type ReportDetail, type ReportSubjectKind, type SectionTemplate,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { nfc, nfcOrNull } from '../cycles/common.js';
import { assertHuman, getVersion } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { reportUndo } from '../trash/store.js';
import { subjectName } from './common.js';
import { getReport } from './read.js';

/** A unit and its ancestors, nearest first: a champion set on the college answers for its departments too. */
async function unitChain(ctx: Ctx, unitId: string): Promise<string[]> {
  const res = await ctx.tx.execute<{ id: string }>(sql`
    with recursive up as (
      select id, parent_id, 0 as depth from org_unit where id = ${unitId}
      union all
      select o.id, o.parent_id, up.depth + 1 from org_unit o join up on o.id = up.parent_id)
    select id from up order by depth`);
  return res.rows.map((r) => r.id);
}

/**
 * The champion of one code for a subject, or null. Preference: the subject itself (a program, or the unit's own
 * champion), then its ancestors' (nearest first), then the overall champion; two candidates at the same preference are an
 * ambiguity nobody should guess through.
 */
function championFor(champs: { code: string; kind: string | null; itemId: string | null; userId: string }[], code: string, unitIds: string[], subjectKind: string, subjectId: string): { userId: string | null; ambiguous: boolean } {
  const rows = champs.filter((c) => c.code === code);
  const pick = (match: (c: { kind: string | null; itemId: string | null }) => boolean) => {
    const hits = [...new Set(rows.filter((c) => match(c)).map((c) => c.userId))];
    return hits.length === 1 ? { userId: hits[0]!, ambiguous: false } : hits.length > 1 ? { userId: null, ambiguous: true } : null;
  };
  const wantProgram = subjectKind === 'program';
  for (const unitId of wantProgram ? [] : unitIds) {
    const hit = pick((c) => c.kind === 'org_unit' && c.itemId === unitId);
    if (hit) return hit;
  }
  if (wantProgram) {
    const hit = pick((c) => c.kind === 'program' && c.itemId === subjectId);
    if (hit) return hit;
  }
  return pick((c) => c.kind === null) ?? { userId: null, ambiguous: false };
}

export async function createReport(ctx: Ctx, input: CreateReport): Promise<ReportDetail> {
  assertHuman(ctx);
  const version = await getVersion(ctx, input.frameworkVersionId);
  const [tpl] = await ctx.tx.select().from(reportTemplate).where(and(
    eq(reportTemplate.frameworkVersionId, version.id), eq(reportTemplate.key, input.templateKey)));
  if (!tpl) throw new NotFoundError(`report template ${input.templateKey} of version ${version.id}`);
  if (tpl.reviewStatus !== 'approved') throw new ConflictError(`The template "${tpl.name}" has not been reviewed yet. A report is made from a reviewed template only.`);
  const structure = ReportTemplateStructureSchema.parse(tpl.structure);

  // The wrapper: an engagement (its version must be this one), or a subject that exists here.
  let engagementId: string | null = null;
  let subjectKind: ReportSubjectKind | null = null;
  let subjectId: string | null = null;
  let about: string;
  if (input.engagementId) {
    const [row] = await ctx.tx.select().from(engagement).where(eq(engagement.id, input.engagementId));
    if (!row || row.institutionId !== ctx.caller.institutionId) throw new NotFoundError(`engagement ${input.engagementId}`);
    if (row.frameworkVersionId !== version.id) throw new ConflictError('That engagement runs on a different edition of the framework than the template does.');
    engagementId = row.id;
    about = row.title;
  } else {
    subjectKind = input.subjectKind!;
    subjectId = input.subjectId!;
    if (subjectKind === 'program') {
      const [row] = await ctx.tx.select({ id: program.id }).from(program).where(eq(program.id, subjectId));
      if (!row) throw new NotFoundError(`program ${subjectId}`);
    } else if (subjectKind === 'org_unit') {
      const [row] = await ctx.tx.select({ id: orgUnit.id }).from(orgUnit).where(eq(orgUnit.id, subjectId));
      if (!row) throw new NotFoundError(`org unit ${subjectId}`);
    }
    about = (await subjectName(ctx, subjectKind, subjectId)) ?? '';
  }
  const title = input.title ?? [tpl.name, about].filter(Boolean).join(' · ');
  const round = input.round ?? 1;
  if (engagementId) {
    const [dupe] = await ctx.tx.select({ id: report.id }).from(report)
      .where(and(eq(report.engagementId, engagementId), eq(report.templateId, tpl.id), eq(report.round, round)));
    if (dupe) throw new ConflictError(`Round ${round} of the template "${tpl.name}" already exists for this engagement.`);
  }

  // The version's requirements by code, the engagement's owners, the framework's champions.
  const reqs = await ctx.tx.select({ id: requirement.id, code: requirement.code, title: requirement.title, parentId: requirement.parentId }).from(requirement)
    .where(eq(requirement.frameworkVersionId, version.id));
  const byCode = new Map(reqs.map((r) => [r.code, r]));
  const engOwners = engagementId
    ? new Map((await ctx.tx.select({ requirementId: engagementRequirement.requirementId, ownerId: engagementRequirement.ownerId })
        .from(engagementRequirement).where(eq(engagementRequirement.engagementId, engagementId))).map((r) => [r.requirementId, r.ownerId]))
    : null;
  const champs = subjectKind === 'institution' || subjectKind === 'org_unit' || subjectKind === 'program'
    ? (await ctx.tx.select({ code: requirementChampion.code, kind: requirementChampion.scopeItemKind, itemId: requirementChampion.scopeItemId, userId: requirementChampion.userId })
        .from(requirementChampion).where(and(eq(requirementChampion.institutionId, ctx.caller.institutionId), eq(requirementChampion.frameworkId, version.frameworkId))))
    : [];
  const unitIds = subjectKind === 'org_unit' && subjectId ? await unitChain(ctx, subjectId) : [];
  // Champion inheritance walks the requirement tree: a code with no champion of its own takes its parent's.
  const parentOf = new Map(reqs.map((r) => [r.code, r.parentId ? reqs.find((p) => p.id === r.parentId)?.code ?? null : null]));
  const ownerFor = (codes: string[]): { ownerId: string | null; unresolved: boolean } => {
    for (const code of codes) {
      if (engOwners) {
        const req = byCode.get(code);
        const owner = req ? engOwners.get(req.id) ?? null : null;
        if (owner) return { ownerId: owner, unresolved: false };
      } else {
        for (let c: string | null = code; c; c = parentOf.get(c) ?? null) {
          const hit = championFor(champs, c, unitIds, subjectKind ?? '', subjectId ?? '');
          // Two champions at the same tier are an ambiguity nobody should guess past: flag, do not fall through.
          if (hit.ambiguous) return { ownerId: null, unresolved: true };
          if (hit.userId) return { ownerId: hit.userId, unresolved: false };
        }
      }
    }
    return { ownerId: null, unresolved: true };
  };

  // The structure becomes rows now: a later template edit never reshapes a report already made. Sections insert in order,
  // parents before children, each with the requirement codes resolved to ids of this version (an unknown code is a template
  // defect the creator should hear about, not a silent empty section).
  const [row] = await guardIntegrity(() => ctx.tx.insert(report).values({
    institutionId: ctx.caller.institutionId, title: nfc(title), frameworkVersionId: version.id, templateId: tpl.id,
    templateKey: tpl.key, templateName: tpl.name, kind: tpl.kind, language: tpl.language, wordLimit: tpl.wordLimit,
    requiresAttestation: tpl.requiresAttestation, engagementId, subjectKind, subjectId, status: 'draft', round,
  }).returning());

  const walk = async (defs: SectionTemplate[], parentId: string | null): Promise<void> => {
    for (const [i, def] of defs.entries()) {
      const unknown = (def.requirement_codes ?? []).filter((c) => !byCode.has(c));
      if (unknown.length) throw new ValidationError(`The template section "${def.title}" names requirement code(s) ${unknown.join(', ')} that this framework edition does not have.`);
      const [section] = await guardIntegrity(() => ctx.tx.insert(reportSection).values({
        institutionId: ctx.caller.institutionId, reportId: row!.id, key: def.key, parentId, title: nfc(def.title),
        blockType: def.block_type, displayOrder: i, prompt: nfcOrNull(def.prompt), content: {},
        wordLimit: def.word_limit ?? null, columns: def.columns ?? null, datasetBinding: def.dataset_binding ?? null,
      }).returning());
      const links = (def.requirement_codes ?? []).map((code, j) => {
        const req = byCode.get(code)!;
        const { ownerId } = ownerFor([code]);
        return { section, requirementId: req.id, code, displayOrder: j, ownerId };
      });
      if (links.length) {
        await guardIntegrity(() => ctx.tx.insert(reportSectionRequirement).values(links.map(({ section: s, requirementId, code, displayOrder }) => ({
          institutionId: ctx.caller.institutionId, sectionId: s!.id, requirementId, code, displayOrder,
        }))));
      }
      // The section's owner: the first linked requirement that has one (the engagement's owner, or the framework's champion).
      // A section with requirements and nobody to own them is flagged, never guessed (TASK-091).
      const withOwner = links.find((l) => l.ownerId);
      await guardIntegrity(() => ctx.tx.update(reportSection).set({
        ownerId: withOwner?.ownerId ?? null, ownerUnresolved: !withOwner && links.length > 0,
      }).where(eq(reportSection.id, section!.id)));
      await walk(def.children ?? [], section!.id);
    }
  };
  await walk(structure.sections, null);

  reportUndo(ctx, { label: `Created the report ${nfc(title)}`, method: 'DELETE', path: `/api/reports/${row!.id}` });
  return getReport(ctx, row!.id);
}
