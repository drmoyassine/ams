// The workflow (PRD 10.4 steps 2 to 5, TASK-094). A writer sends a section for review; a reviewer approves it or sends
// it back with a note; when every section is approved a reviewer internally approves the report; a manager freezes the
// immutable submission snapshot (manifest, hashes, the word diff against the previous round); "Mark submitted" stamps
// the report and completes its submission milestone. The database holds the discipline (0066, 0067); these services
// choose the moves and read back the whole report.
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  appUser, evidenceItem, evidenceVersion, milestone, report, reportSection, reportSectionDecision,
  submissionSnapshot,
} from '@ams/db';
import {
  diffWords, diffableText,
  type DecideSection, type MarkSubmitted, type ReportDetail, type SectionDiff,
  type SnapshotApproval, type SnapshotEvidence, type SnapshotManifest, type SnapshotSection, type SubmissionSnapshot,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { nfc } from '../cycles/common.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { assertManage, loadReport, loadSection, scopeOf } from './common.js';
import { getReport, loadSections } from './read.js';

const CITE = /\[E:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/g;

/** Step 2, the writer's move: hands a section (draft or returned) to the reviewers. */
export async function submitSectionForReview(ctx: Ctx, sectionId: string): Promise<ReportDetail> {
  assertHuman(ctx);
  const section = await loadSection(ctx, sectionId);
  const row = await loadReport(ctx, section.reportId);
  await assertPermitted(ctx, 'report:write', scopeOf(row));
  if (row.status !== 'draft') throw new ValidationError('Content and review move only while the report is a draft.');
  if (section.status !== 'draft' && section.status !== 'returned') {
    throw new ValidationError(`Section "${section.title}" is ${section.status}; only a draft or a returned section can be sent for review.`);
  }
  await guardIntegrity(() => ctx.tx.update(reportSection).set({ status: 'in_review' }).where(eq(reportSection.id, sectionId)));
  return getReport(ctx, section.reportId);
}

/** Step 2, the reviewer's move: approve a section in review, or return it with a note (what to fix). An approved section
 *  can be reopened — a `returned` decision and the section goes back to draft — and if the report was internally
 *  approved, that approval is demoted in the same transaction (the database holds that together even against a
 *  forgotten demotion). After submission nothing reopens. */
export async function decideSection(ctx: Ctx, sectionId: string, input: DecideSection): Promise<ReportDetail> {
  assertHuman(ctx);
  const section = await loadSection(ctx, sectionId);
  const row = await loadReport(ctx, section.reportId);
  await assertPermitted(ctx, 'report:review', scopeOf(row));
  if (input.decision === 'approved') {
    if (section.status !== 'in_review') {
      throw new ValidationError(`Section "${section.title}" is ${section.status}; only a section in review can be approved.`);
    }
    await guardIntegrity(() => ctx.tx.insert(reportSectionDecision).values({
      institutionId: ctx.caller.institutionId, sectionId, decision: 'approved', note: null, decidedBy: ctx.caller.userId!,
    }));
    await guardIntegrity(() => ctx.tx.update(reportSection).set({ status: 'approved' }).where(eq(reportSection.id, sectionId)));
    return getReport(ctx, section.reportId);
  }
  if (!input.note) throw new ValidationError('Returning a section needs a note saying what to fix.');
  const note = nfc(input.note);
  if (section.status === 'in_review') {
    await guardIntegrity(() => ctx.tx.insert(reportSectionDecision).values({
      institutionId: ctx.caller.institutionId, sectionId, decision: 'returned', note, decidedBy: ctx.caller.userId!,
    }));
    await guardIntegrity(() => ctx.tx.update(reportSection).set({ status: 'returned' }).where(eq(reportSection.id, sectionId)));
    return getReport(ctx, section.reportId);
  }
  // Reopening: an approved section of a draft report goes back to draft; of an internally approved report it also
  // demotes the report (the review starts over).
  if (section.status !== 'approved' || (row.status !== 'draft' && row.status !== 'internally_approved')) {
    throw new ValidationError(`Section "${section.title}" is ${section.status} and the report is ${row.status}; only an approved section of a draft or internally approved report can be reopened.`);
  }
  await guardIntegrity(() => ctx.tx.insert(reportSectionDecision).values({
    institutionId: ctx.caller.institutionId, sectionId, decision: 'returned', note, decidedBy: ctx.caller.userId!,
  }));
  await guardIntegrity(() => ctx.tx.update(reportSection).set({ status: 'draft' }).where(eq(reportSection.id, sectionId)));
  if (row.status === 'internally_approved') {
    await guardIntegrity(() => ctx.tx.update(report).set({ status: 'draft' }).where(eq(report.id, row.id)));
  }
  return getReport(ctx, section.reportId);
}

/** Step 3: internal approval. The database checks that every section is approved and the attestation is there, and
 *  stamps who approved and when. The wording is exactly "Internally approved" (DEC-005) — never "compliant". */
export async function approveReport(ctx: Ctx, id: string): Promise<ReportDetail> {
  assertHuman(ctx);
  const row = await loadReport(ctx, id);
  await assertPermitted(ctx, 'report:review', scopeOf(row));
  if (row.status !== 'draft') throw new ValidationError(`The report is ${row.status}; a draft is internally approved.`);
  await guardIntegrity(() => ctx.tx.update(report).set({ status: 'internally_approved' }).where(eq(report.id, id)));
  return getReport(ctx, id);
}

const lastApproved = async (ctx: Ctx, sectionIds: string[]): Promise<Map<string, SnapshotApproval[]>> => {
  const rows = sectionIds.length ? await ctx.tx.select({
    sectionId: reportSectionDecision.sectionId, decidedBy: reportSectionDecision.decidedBy,
    decidedByName: appUser.fullName, decidedAt: reportSectionDecision.decidedAt,
  }).from(reportSectionDecision).innerJoin(appUser, eq(appUser.id, reportSectionDecision.decidedBy))
    .where(and(inArray(reportSectionDecision.sectionId, sectionIds), eq(reportSectionDecision.decision, 'approved')))
    .orderBy(desc(reportSectionDecision.decidedAt)) : [];
  const by = new Map<string, SnapshotApproval[]>();
  for (const r of rows) {
    by.set(r.sectionId, [...(by.get(r.sectionId) ?? []), {
      decidedBy: r.decidedBy, decidedByName: r.decidedByName ?? null, decidedAt: r.decidedAt.toISOString(),
    }]);
  }
  return by;
};

/** Step 4: the immutable submission snapshot (PRD 6.9). One per report: the whole report in a manifest — sections and
 *  content, the requirements they answer, the approvals, the attestation, the cited evidence with its hashes — and the
 *  word-level changes against the nearest earlier round's snapshot. Hashed, so what went out can always be shown. */
export async function createSnapshot(ctx: Ctx, id: string): Promise<SubmissionSnapshot> {
  assertHuman(ctx);
  const row = await loadReport(ctx, id);
  await assertManage(ctx, row);
  if (row.status !== 'internally_approved') {
    throw new ValidationError(`The report is ${row.status}; a snapshot freezes an internally approved report.`);
  }
  const [taken] = await ctx.tx.select({ id: submissionSnapshot.id }).from(submissionSnapshot).where(eq(submissionSnapshot.reportId, id));
  if (taken) throw new ConflictError('This report already has a submission snapshot; it is immutable.');

  const flat = await loadSections(ctx, id);
  const approvals = await lastApproved(ctx, flat.map((s) => s.id));
  const sections: SnapshotSection[] = flat.map((s) => ({
    id: s.id, key: s.key, title: s.title, blockType: s.blockType, wordCount: s.wordCount,
    requirements: s.requirements, approvals: approvals.get(s.id) ?? [], content: s.content,
  }));

  // Every cited evidence version — inline `[E:<versionId>]` tokens and appendix items — with its hash.
  const cited = new Set<string>();
  for (const s of flat) {
    if (s.blockType === 'narrative') {
      for (const m of String((s.content as { text?: unknown }).text ?? '').matchAll(CITE)) cited.add(m[1]!);
    }
    if (s.blockType === 'appendix') {
      for (const i of ((s.content as { items?: { evidenceVersionId: string }[] }).items ?? [])) cited.add(i.evidenceVersionId);
    }
  }
  const evidenceRows = cited.size ? await ctx.tx.select({
    id: evidenceVersion.id, itemId: evidenceVersion.evidenceItemId, title: evidenceItem.title,
    versionNo: evidenceVersion.versionNo, fileName: evidenceVersion.fileName, sha256: evidenceVersion.sha256,
    filePath: evidenceVersion.filePath,
  }).from(evidenceVersion).innerJoin(evidenceItem, eq(evidenceItem.id, evidenceVersion.evidenceItemId))
    .where(and(eq(evidenceVersion.institutionId, ctx.caller.institutionId), inArray(evidenceVersion.id, [...cited]))) : [];
  const evidence: SnapshotEvidence[] = evidenceRows.map((e) => ({
    versionId: e.id, evidenceItemId: e.itemId, title: e.title, versionNo: e.versionNo,
    fileName: e.fileName, sha256: e.sha256,
  }));

  const att = flat.find((s) => s.blockType === 'attestation');
  const attContent = (att?.content ?? {}) as { signatoryName?: string | null; fileName?: string | null; fileKey?: string | null };
  const attestation = attContent.fileKey
    ? { signatoryName: attContent.signatoryName ?? null, fileName: attContent.fileName ?? null }
    : null;

  // The changes since the nearest earlier round that was snapshotted (PRD 11.4); sections missing there are new, not diffs.
  const wrapper = row.engagementId !== null
    ? eq(report.engagementId, row.engagementId)
    : and(eq(report.subjectKind, row.subjectKind!), row.subjectId === null ? sql`${report.subjectId} is null` : sql`${report.subjectId} = ${row.subjectId}::uuid`);
  const [prev] = await ctx.tx.select({ manifest: submissionSnapshot.manifest })
    .from(report).innerJoin(submissionSnapshot, eq(submissionSnapshot.reportId, report.id))
    .where(and(eq(report.institutionId, ctx.caller.institutionId), eq(report.templateId, row.templateId), lt(report.round, row.round), wrapper))
    .orderBy(desc(report.round)).limit(1);
  const oldBy = new Map<string, SnapshotSection>();
  for (const s of ((prev?.manifest as SnapshotManifest | undefined)?.sections ?? [])) oldBy.set(s.key, s);
  const changes: SectionDiff[] = [];
  for (const s of sections) {
    const old = oldBy.get(s.key);
    if (!old) continue;
    const chunks = diffWords(diffableText(old), diffableText(s));
    if (chunks.some((c) => c.t !== 'same')) changes.push({ key: s.key, title: s.title, chunks });
  }

  const [approver] = row.approvedBy ? await ctx.tx.select({ name: appUser.fullName }).from(appUser).where(eq(appUser.id, row.approvedBy)) : [];
  const wordCount = flat.reduce((n, s) => n + (s.blockType === 'narrative' ? s.wordCount ?? 0 : 0), 0);
  const manifest: SnapshotManifest = {
    report: {
      id: row.id, title: row.title, round: row.round, kind: row.kind, language: row.language,
      frameworkVersionId: row.frameworkVersionId, templateKey: row.templateKey, templateName: row.templateName,
      engagementId: row.engagementId, subjectKind: row.subjectKind, subjectId: row.subjectId,
      wordLimit: row.wordLimit, wordCount, requiresAttestation: row.requiresAttestation,
      approvedAt: row.approvedAt!.toISOString(), approvedBy: row.approvedBy!, approvedByName: approver?.name ?? null,
    },
    sections, evidence, attestation, changes,
  };
  const sha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const exportFiles = [
    ...(attContent.fileKey ? [{ kind: 'attestation_letter', key: attContent.fileKey }] : []),
    ...evidenceRows.filter((e) => e.filePath).map((e) => ({ kind: 'evidence', key: e.filePath!, versionId: e.id })),
  ];
  const [snap] = await guardIntegrity(() => ctx.tx.insert(submissionSnapshot).values({
    institutionId: ctx.caller.institutionId, reportId: id, round: row.round,
    manifest: manifest as unknown as Record<string, unknown>, exportFiles, sha256,
  }).returning());
  return {
    id: snap!.id, reportId: id, round: row.round,
    manifest: manifest as unknown as Record<string, unknown>, sha256, createdAt: snap!.createdAt.toISOString(),
  };
}

/** Reads a report's snapshot; there is none until a manager froze one. */
export async function getSnapshot(ctx: Ctx, id: string): Promise<SubmissionSnapshot> {
  const row = await loadReport(ctx, id);
  const [snap] = await ctx.tx.select().from(submissionSnapshot).where(eq(submissionSnapshot.reportId, row.id));
  if (!snap) throw new NotFoundError(`snapshot of report ${id}`);
  return {
    id: snap.id, reportId: snap.reportId, round: snap.round,
    manifest: snap.manifest as Record<string, unknown>, sha256: snap.sha256, createdAt: snap.createdAt.toISOString(),
  };
}

/** Step 5: "Mark submitted". The snapshot must be there first — what went out is frozen before anyone says it did. The
 *  database stamps who submitted and when; the accreditor's own reference is kept as given. Completes the round's
 *  submission milestone of the engagement, if the report was made for one. */
export async function markSubmitted(ctx: Ctx, id: string, input: MarkSubmitted): Promise<ReportDetail> {
  assertHuman(ctx);
  const row = await loadReport(ctx, id);
  await assertManage(ctx, row);
  if (row.status !== 'internally_approved') throw new ValidationError(`The report is ${row.status}; an internally approved report is marked submitted.`);
  const [taken] = await ctx.tx.select({ id: submissionSnapshot.id }).from(submissionSnapshot).where(eq(submissionSnapshot.reportId, id));
  if (!taken) throw new ValidationError('Take the submission snapshot before marking the report submitted.');
  await guardIntegrity(() => ctx.tx.update(report).set({
    status: 'submitted', ...(input.ref ? { submittedRef: nfc(input.ref) } : {}),
  }).where(eq(report.id, id)));
  if (row.engagementId) {
    await ctx.tx.update(milestone).set({ status: 'done', completedAt: new Date() })
      .where(and(eq(milestone.institutionId, ctx.caller.institutionId), eq(milestone.reportId, id), eq(milestone.type, 'submission'), ne(milestone.status, 'done')));
  }
  return getReport(ctx, id);
}
