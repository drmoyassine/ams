// Forms on dataset items (DEC-020), like Google Forms: the columns are the questions; each answer is kept as a response,
// checked with the same cell rules as the sheet; responses join the data when someone adds them (the next version).
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { appUser, datasetResponse, datasetSpec, evidenceVersion, institution } from '@ams/db';
import {
  DatasetDataSchema, SubmitResponseSchema, validateRows,
  type CellValue, type DataColumn, type DataForm, type DataResponse, type EvidenceVersion, type PublicForm, type SubmitResponse,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted, isPermitted } from '../permissions.js';
import { dataItem, insertDataVersion } from './dataset.js';

const any = { type: 'any' } as const;

export async function specOf(ctx: Ctx, itemId: string) {
  const item = await dataItem(ctx, itemId);
  const [spec] = await ctx.tx.select().from(datasetSpec).where(eq(datasetSpec.evidenceItemId, itemId));
  return { item, spec, columns: (spec?.columns ?? []) as DataColumn[] };
}

async function counts(ctx: Ctx, itemId: string) {
  const [c] = await ctx.tx.select({
    pending: sql<number>`count(*) filter (where ${datasetResponse.includedInVersionId} is null)::int`,
    included: sql<number>`count(*) filter (where ${datasetResponse.includedInVersionId} is not null)::int`,
  }).from(datasetResponse).where(eq(datasetResponse.evidenceItemId, itemId));
  return { pending: c?.pending ?? 0, included: c?.included ?? 0 };
}

/** The form's state. The public link is shown only to those who may change the form. */
export async function getDataForm(ctx: Ctx, itemId: string): Promise<DataForm> {
  await assertPermitted(ctx, 'evidence:read', any);
  const { spec } = await specOf(ctx, itemId);
  const mayEdit = await isPermitted(ctx.tx, 'evidence:write', any);
  return { open: spec?.formOpen ?? false, linkToken: mayEdit ? spec?.formLinkToken ?? null : null, ...(await counts(ctx, itemId)) };
}

async function updateForm(ctx: Ctx, itemId: string, set: Partial<typeof datasetSpec.$inferInsert>) {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  const { spec, columns } = await specOf(ctx, itemId);
  if (!spec || !columns.length) throw new ValidationError('define the columns first; they are the questions');
  await ctx.tx.update(datasetSpec).set(set).where(eq(datasetSpec.id, spec.id));
  return getDataForm(ctx, itemId);
}

/** Opens or closes the form. A closed form takes no responses, from AMS users or through its link. */
export const setDataFormOpen = (ctx: Ctx, itemId: string, open: boolean) => updateForm(ctx, itemId, { formOpen: open });
/** A new public link; the previous one stops working. */
export const newDataFormLink = (ctx: Ctx, itemId: string) => updateForm(ctx, itemId, { formLinkToken: randomBytes(24).toString('base64url') });
export const removeDataFormLink = (ctx: Ctx, itemId: string) => updateForm(ctx, itemId, { formLinkToken: null });

async function describeForm(ctx: Ctx, itemId: string): Promise<PublicForm> {
  const { item, spec, columns } = await specOf(ctx, itemId);
  if (!spec?.formOpen) throw new ConflictError('this form is not taking responses');
  const [inst] = await ctx.tx.select({ name: institution.nameEn }).from(institution).where(eq(institution.id, item.institutionId));
  return { title: item.title, definition: item.definition, institutionName: inst?.name ?? '', columns };
}

/** Checks the answers against the columns and keeps them as a response; returns its id. Callers decide who may answer. */
export async function insertResponse(ctx: Ctx, itemId: string, input: SubmitResponse, via: 'ams' | 'link'): Promise<string> {
  const { columns } = await specOf(ctx, itemId);
  const d = SubmitResponseSchema.parse(input);
  if (JSON.stringify(d.answers).length > 20_000) throw new ValidationError('the answers are too long');
  const { rows, issues } = validateRows(columns, [d.answers]);
  if (issues.length) throw new ValidationError('some answers need attention', issues.map((i) => ({ path: `answers.${i.key}`, message: i.message })));
  if (!rows.length) throw new ValidationError('answer at least one question');
  const [r] = await ctx.tx.insert(datasetResponse).values({
    institutionId: ctx.caller.institutionId, evidenceItemId: itemId, answers: rows[0]!, via, submittedBy: ctx.caller.userId,
  }).returning({ id: datasetResponse.id });
  return r!.id;
}

/** The form for a signed-in person to answer. */
export async function formToAnswer(ctx: Ctx, itemId: string): Promise<PublicForm> {
  await assertPermitted(ctx, 'evidence:read', any);
  return describeForm(ctx, itemId);
}
export async function submitDataResponse(ctx: Ctx, itemId: string, input: SubmitResponse): Promise<void> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:read', any);
  await describeForm(ctx, itemId);
  await insertResponse(ctx, itemId, input, 'ams');
}

/** Through the public link: `itemId` comes from the link itself, never from the caller. */
export const formByLink = (ctx: Ctx, itemId: string) => describeForm(ctx, itemId);
export async function submitByFormLink(ctx: Ctx, itemId: string, input: SubmitResponse): Promise<void> {
  await describeForm(ctx, itemId);
  await insertResponse(ctx, itemId, input, 'link');
}

/** Every response, newest first, with who gave it (when signed in) and the version it was added to. */
export async function listDataResponses(ctx: Ctx, itemId: string): Promise<DataResponse[]> {
  await assertPermitted(ctx, 'evidence:read', any);
  await dataItem(ctx, itemId);
  const rows = await ctx.tx.select({ r: datasetResponse, who: appUser.fullName, v: evidenceVersion.versionNo }).from(datasetResponse)
    .leftJoin(appUser, eq(appUser.id, datasetResponse.submittedBy)).leftJoin(evidenceVersion, eq(evidenceVersion.id, datasetResponse.includedInVersionId))
    .where(eq(datasetResponse.evidenceItemId, itemId)).orderBy(desc(datasetResponse.createdAt));
  return rows.map(({ r, who, v }) => ({
    id: r.id, answers: r.answers as Record<string, CellValue>, via: r.via, submittedByName: who, createdAt: r.createdAt.toISOString(), includedInVersionNo: v,
  }));
}

/**
 * Adds the waiting responses to the data: the latest saved rows plus the responses, oldest first, checked against the
 * current columns and saved as the next version.
 */
export async function addResponsesToData(ctx: Ctx, itemId: string): Promise<EvidenceVersion> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  const { spec, columns } = await specOf(ctx, itemId);
  if (!columns.length) throw new ValidationError('define the columns first');
  const pending = await ctx.tx.select().from(datasetResponse)
    .where(and(eq(datasetResponse.evidenceItemId, itemId), isNull(datasetResponse.includedInVersionId))).orderBy(asc(datasetResponse.createdAt));
  if (!pending.length) throw new ConflictError('there are no new responses');
  const [latest] = await ctx.tx.select().from(evidenceVersion).where(eq(evidenceVersion.evidenceItemId, itemId)).orderBy(desc(evidenceVersion.versionNo)).limit(1);
  const base = latest?.data ? DatasetDataSchema.parse(latest.data).rows : [];
  const { rows, issues } = validateRows(columns, [...base, ...pending.map((p) => p.answers as Record<string, CellValue>)]);
  if (issues.some((i) => i.row < base.length)) {
    throw new ValidationError('some saved rows do not fit the current columns; correct them in the sheet first');
  }
  if (issues.length) throw new ValidationError('some responses do not fit the current columns');
  const v = await insertDataVersion(ctx, itemId, columns, rows, {
    notes: `Added ${pending.length} form response${pending.length === 1 ? '' : 's'}`, sourceKind: spec!.sourceKind, extra: { form_responses: pending.length },
  });
  await ctx.tx.update(datasetResponse).set({ includedInVersionId: v.id }).where(inArray(datasetResponse.id, pending.map((p) => p.id)));
  return v;
}
