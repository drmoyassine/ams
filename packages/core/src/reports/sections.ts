// Changing what a report is called, who owns a section, and what a section says (TASK-091). The database holds the
// discipline — a section's words change only while its report is a draft, and only in the section's own state — so these
// services stay thin: permission, load, write. Review moves (approve, return) arrive with TASK-094.
import { and, eq, inArray } from 'drizzle-orm';
import { appUser, evidenceVersion, report, reportSection } from '@ams/db';
import { parseContent, type ReportDetail, type SetSectionOwner, type UpdateReport, type UpdateSectionContent } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ValidationError } from '../ctx.js';
import { nfc } from '../cycles/common.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { loadReport, loadSection, scopeOf } from './common.js';
import { getReport } from './read.js';

/** Renames a report. What it was made from never changes (the database says so; we never send those fields). */
export async function updateReport(ctx: Ctx, id: string, input: UpdateReport): Promise<ReportDetail> {
  assertHuman(ctx);
  const row = await loadReport(ctx, id);
  await assertPermitted(ctx, 'report:manage', scopeOf(row));
  if (input.title !== undefined) {
    await ctx.tx.update(report).set({ title: nfc(input.title) }).where(eq(report.id, id));
  }
  return getReport(ctx, id);
}

/** Hands a section to a person, or takes the owner off. `ownerUnresolved` is only a creation-time flag. */
export async function setSectionOwner(ctx: Ctx, sectionId: string, input: SetSectionOwner): Promise<ReportDetail> {
  assertHuman(ctx);
  const section = await loadSection(ctx, sectionId);
  const row = await loadReport(ctx, section.reportId);
  await assertPermitted(ctx, 'report:manage', scopeOf(row));
  if (input.ownerId !== null) {
    const [person] = await ctx.tx.select({ id: appUser.id }).from(appUser)
      .where(and(eq(appUser.id, input.ownerId), eq(appUser.institutionId, ctx.caller.institutionId)));
    if (!person) throw new ValidationError('The owner must be a person of this institution.');
  }
  await ctx.tx.update(reportSection).set({ ownerId: input.ownerId }).where(eq(reportSection.id, sectionId));
  return getReport(ctx, section.reportId);
}

/** Saves the content of one section, shaped by its block type. The word count of a narrative is the database's doing. */
export async function updateSectionContent(ctx: Ctx, sectionId: string, input: UpdateSectionContent): Promise<ReportDetail> {
  assertHuman(ctx);
  const section = await loadSection(ctx, sectionId);
  const row = await loadReport(ctx, section.reportId);
  await assertPermitted(ctx, 'report:write', scopeOf(row));
  // One key, and it must be this section's block type: the editor cannot cross-write a narrative into a table.
  const keys = Object.keys(input);
  if (keys.length !== 1) throw new ValidationError('Send the content under exactly one key: the section\'s block type.');
  const [key] = keys as [keyof UpdateSectionContent];
  if (key !== section.blockType) {
    throw new ValidationError(`Section "${section.title}" is a ${section.blockType}; send its content under "${section.blockType}".`);
  }
  const content = parseContent(section.blockType, input[key]);
  // An appendix points at evidence versions; each must be one of this tenant's (a wrong id is a mistake to hear about).
  const items = (content as { items?: { evidenceVersionId: string }[] }).items ?? [];
  if (key === 'appendix' && items.length) {
    const known = await ctx.tx.select({ id: evidenceVersion.id }).from(evidenceVersion).where(and(
      eq(evidenceVersion.institutionId, ctx.caller.institutionId), inArray(evidenceVersion.id, items.map((i) => i.evidenceVersionId))));
    const missing = items.filter((i) => !known.some((k) => k.id === i.evidenceVersionId));
    if (missing.length) throw new ValidationError(`${missing.length} of the attached files are not evidence of this institution.`);
  }
  // The database refuses words written after the report left the draft (or outside the section's own state); wrapped,
  // so the refusal reaches the editor as a conflict instead of a crash.
  await guardIntegrity(() => ctx.tx.update(reportSection).set({ content }).where(eq(reportSection.id, sectionId)));
  return getReport(ctx, section.reportId);
}
