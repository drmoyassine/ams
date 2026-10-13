// Executing a plan: every step is ONE call of an existing core service, made with the signed-in person's own ctx (their
// permissions, their identity on every row: the database marks the rows "edited by a person" and the audit trail names them).
// There is no SQL of its own here. The undo descriptors the services report while they work are collected, in order; undoing runs
// them backwards through `replay`, and what THAT reports is the redo. So undo and redo are the same mechanism the screens use
// (X-Undo / X-Replay), made into one group.
import { sql } from 'drizzle-orm';
import { UndoDescriptorSchema, type UndoDescriptor } from '@ams/shared';
import type { Ctx } from '../../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../../ctx.js';
import { createRequirement, moveRequirement, updateRequirement } from '../../framework/requirements.js';
import { moveMany } from '../../framework/move-many.js';
import { mergeRequirement, splitRequirement, unsplitRequirement } from '../../framework/restructure.js';
import { deleteNote, setNoteAuthority, updateNote } from '../../framework/notes.js';
import { newVersionFrom } from '../../framework/versions.js';
import { deleteAllRequirements, deleteMany, deleteVersion, restoreTrash } from '../../trash/index.js';
import { deleteMapping, reviewMapping, updateMapping } from '../../mapping/mapping.js';
import type { Plan, Step } from './types.js';

export interface ExecOutcome {
  /** The undo descriptors, in the order they must run to take everything back. */
  inverse: UndoDescriptor[];
  /** The draft a `create_draft` step made. */
  newVersionId: string | null;
}

type NoteType = 'guidance' | 'evidence_expectation' | 'data_request' | 'quantitative_norm';
type Authority = 'required' | 'example' | 'suggested' | 'institution_defined';

/** Runs `fn` with a ctx that records (instead of forwarding) the undo descriptor the service reports. */
async function reported<T>(ctx: Ctx, out: UndoDescriptor[], fn: (c: Ctx) => Promise<T>): Promise<T> {
  let last: UndoDescriptor | null = null;
  const value = await fn({ ...ctx, undo: (d) => { last = d; } });
  if (last) out.push(last);
  return value;
}

/** Applies the steps of a plan in order. Throws on the first refusal; the caller rolls back to its savepoint. */
export async function executePlan(ctx: Ctx, plan: Plan): Promise<ExecOutcome> {
  const reports: UndoDescriptor[] = [];
  const ids = new Map<string, string>();
  const real = (id: string) => ids.get(id) ?? id;
  let newVersionId: string | null = null;
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'req_fields':
        await reported(ctx, reports, (c) => updateRequirement(c, real(step.id), step.set));
        break;
      case 'note_fields':
        await reported(ctx, reports, (c) => updateNote(c, step.id, {
          ...(step.set.text !== undefined ? { text: step.set.text } : {}),
          ...(step.set.type !== undefined ? { type: step.set.type as NoteType } : {}),
        }));
        break;
      case 'note_authority':
        await reported(ctx, reports, (c) => setNoteAuthority(c, step.id, step.authority as Authority));
        break;
      case 'move':
        await reported(ctx, reports, (c) => moveMany(c, plan.versionId, { moves: step.moves.map((m) => ({ id: real(m.id), parentId: m.parentId ? real(m.parentId) : null, index: m.index })) }));
        break;
      case 'create': {
        const row = await reported(ctx, reports, (c) => createRequirement(c, {
          versionId: plan.versionId, parentId: step.parentId ? real(step.parentId) : null, code: step.code, levelLabel: step.levelLabel, title: step.title,
          ...(step.officialText !== null ? { officialText: step.officialText } : {}), language: step.language, isAssessable: step.isAssessable, displayOrder: step.displayOrder,
        }));
        ids.set(step.tempId, row.id);
        break;
      }
      case 'delete':
        await reported(ctx, reports, (c) => deleteMany(c, { ids: step.ids.map(real) }));
        break;
      case 'merge':
        await reported(ctx, reports, (c) => mergeRequirement(c, real(step.id), { intoId: real(step.intoId), useMergedWording: step.useMergedWording }));
        break;
      case 'split': {
        const r = await reported(ctx, reports, (c) => splitRequirement(c, real(step.id), { part: step.part, code: step.newCode, ...(step.title ? { title: step.title } : {}) }));
        ids.set(step.tempId, r.created.id);
        break;
      }
      case 'link_review':
        await reviewMapping(ctx, step.id, step.decision);
        // reviewMapping reports no undo of its own; taking a review back returns the link to pending.
        reports.push({ label: `Reviewed the link ${step.externalCode} to ${step.internalCode}`, method: 'POST', path: `/internal/mappings/${step.id}/unreview` });
        break;
      case 'new_draft': {
        const r = await newVersionFrom(ctx, step.sourceVersionId, { edition: step.edition, ...(step.changeSummary ? { changeSummary: step.changeSummary } : {}) });
        newVersionId = r.version.id;
        reports.push({ label: `Started the draft ${step.edition}`, method: 'DELETE', path: `/api/framework-versions/${r.version.id}` });
        break;
      }
    }
  }
  return { inverse: reports.reverse(), newVersionId };
}

// ---- Replaying descriptors (undo and redo) ---------------------------------------------------------------------------------------
type Handler = (ctx: Ctx, m: RegExpMatchArray, body: Record<string, unknown>, out: UndoDescriptor[]) => Promise<unknown>;
const ID = '([0-9a-f-]{36})';
const ROUTES: { method: string; re: RegExp; run: Handler }[] = [
  { method: 'PATCH', re: new RegExp(`^/api/requirements/${ID}$`), run: (c, m, b) => updateRequirement(c, m[1]!, b) },
  { method: 'POST', re: new RegExp(`^/api/requirements/${ID}/move$`), run: (c, m, b) => moveRequirement(c, m[1]!, (b.parentId as string | null | undefined) ?? null, b.displayOrder as number | undefined) },
  { method: 'POST', re: new RegExp(`^/api/framework-versions/${ID}/requirements/move-many$`), run: (c, m, b) => moveMany(c, m[1]!, b) },
  { method: 'POST', re: new RegExp(`^/api/framework-versions/${ID}/requirements/delete-all$`), run: (c, m) => deleteAllRequirements(c, m[1]!) },
  { method: 'POST', re: new RegExp(`^/api/trash/groups/${ID}/restore$`), run: (c, m, b) => restoreTrash(c, { groupId: m[1]! }, b) },
  { method: 'DELETE', re: new RegExp(`^/api/requirements/${ID}$`), run: (c, m) => deleteMany(c, { ids: [m[1]!] }) },
  { method: 'POST', re: /^\/api\/requirements\/delete$/, run: (c, _m, b) => deleteMany(c, { ids: b.ids as string[] }) },
  { method: 'POST', re: new RegExp(`^/api/requirements/${ID}/unsplit$`), run: (c, m, b) => unsplitRequirement(c, m[1]!, b as { createdId: string; officialText: string }) },
  { method: 'POST', re: new RegExp(`^/api/requirements/${ID}/split$`), run: (c, m, b) => splitRequirement(c, m[1]!, b as { part: string; code: string; title?: string }) },
  { method: 'POST', re: new RegExp(`^/api/requirements/${ID}/merge$`), run: (c, m, b) => mergeRequirement(c, m[1]!, b as { intoId: string; useMergedWording?: boolean }) },
  { method: 'PATCH', re: new RegExp(`^/api/notes/${ID}$`), run: (c, m, b) => updateNote(c, m[1]!, b) },
  { method: 'POST', re: new RegExp(`^/api/notes/${ID}/authority$`), run: (c, m, b) => setNoteAuthority(c, m[1]!, b.authority as Authority) },
  { method: 'DELETE', re: new RegExp(`^/api/notes/${ID}$`), run: (c, m) => deleteNote(c, m[1]!) },
  { method: 'DELETE', re: new RegExp(`^/api/framework-versions/${ID}$`), run: (c, m) => deleteVersion(c, m[1]!) },
  { method: 'PATCH', re: new RegExp(`^/api/mappings/${ID}$`), run: (c, m, b) => updateMapping(c, m[1]!, b as { relation?: 'covers' | 'partly_covers' | 'related'; rationale?: string }) },
  { method: 'DELETE', re: new RegExp(`^/api/mappings/${ID}$`), run: (c, m) => deleteMapping(c, m[1]!) },
  {
    // A link review has no endpoint of its own to undo; these two are the pair, and each reports the other.
    method: 'POST', re: new RegExp(`^/internal/mappings/${ID}/unreview$`),
    run: async (c, m, _b, out) => {
      const id = m[1]!;
      const before = await c.tx.execute<{ review_status: string; relation: 'covers' | 'partly_covers' | 'related'; rationale: string | null; external_code: string; internal_code: string }>(
        sql`select review_status, relation, rationale, external_code, internal_code from requirement_mapping where id = ${id}`);
      const row = before.rows[0];
      if (!row) throw new NotFoundError(`mapping ${id}`);
      // An edit returns a link to review (pending), which is what it was before the review.
      await updateMapping({ ...c, undo: () => undefined }, id, { relation: row.relation, rationale: row.rationale ?? '' });
      out.push({ label: `Reviewed the link ${row.external_code} to ${row.internal_code}`, method: 'POST', path: `/internal/mappings/${id}/review`, body: { decision: row.review_status === 'rejected' ? 'rejected' : 'approved' } });
    },
  },
  {
    method: 'POST', re: new RegExp(`^/internal/mappings/${ID}/review$`),
    run: async (c, m, b, out) => {
      const row = await reviewMapping({ ...c, undo: () => undefined }, m[1]!, b.decision === 'rejected' ? 'rejected' : 'approved');
      out.push({ label: `Reviewed the link ${row.externalCode} to ${row.internalCode}`, method: 'POST', path: `/internal/mappings/${m[1]}/unreview` });
    },
  },
];

/** Runs descriptors in order as the person; returns what they reported, ready to be run in the other direction (reversed). */
export async function replay(ctx: Ctx, descriptors: readonly unknown[]): Promise<UndoDescriptor[]> {
  const out: UndoDescriptor[] = [];
  for (const raw of descriptors) {
    const parsed = UndoDescriptorSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError('a stored step could not be read');
    const d = parsed.data;
    const route = ROUTES.find((r) => r.method === d.method && r.re.test(d.path));
    if (!route) throw new ConflictError(`a stored step (${d.method} ${d.path}) is not one the assistant can run`);
    const body = d.body && typeof d.body === 'object' ? (d.body as Record<string, unknown>) : {};
    let last: UndoDescriptor | null = null;
    const inner: Ctx = { ...ctx, undo: (x) => { last = x; } };
    await route.run(inner, d.path.match(route.re)!, body, out);
    if (last) out.push(last);
  }
  return out.reverse();
}

/** The savepoint a piece of work runs in: a refusal inside it leaves the rest of the transaction usable. */
export async function inSavepoint<T>(ctx: Ctx, name: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  await ctx.tx.execute(sql.raw(`savepoint ${name}`));
  try {
    const value = await fn();
    await ctx.tx.execute(sql.raw(`release savepoint ${name}`));
    return { ok: true, value };
  } catch (e) {
    await ctx.tx.execute(sql.raw(`rollback to savepoint ${name}`));
    await ctx.tx.execute(sql.raw(`release savepoint ${name}`));
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/**
 * The dry run: executes the plan through the real services inside a savepoint and ALWAYS rolls it back. Anything the database or
 * a service would refuse (a frozen version, a cycle, a code collision, a missing permission) comes back as the reason.
 */
export async function dryRunPlan(ctx: Ctx, plan: Plan): Promise<{ ok: true } | { ok: false; reason: string }> {
  await ctx.tx.execute(sql`savepoint assistant_dry_run`);
  let result: { ok: true } | { ok: false; reason: string } = { ok: true };
  try {
    await executePlan(ctx, plan);
  } catch (e) {
    result = { ok: false, reason: reasonOf(e) };
  }
  await ctx.tx.execute(sql`rollback to savepoint assistant_dry_run`);
  await ctx.tx.execute(sql`release savepoint assistant_dry_run`);
  return result;
}

/** A plain sentence for a refusal: the service's own message when it is one of ours, a generic line otherwise. */
export function reasonOf(e: unknown): string {
  if (e instanceof ConflictError || e instanceof ValidationError || e instanceof NotFoundError) return e.message;
  const status = (e as { status?: number } | null)?.status;
  if (status === 403) return 'You do not have permission to make this change.';
  const cause = (e as { cause?: { message?: string } } | null)?.cause?.message;
  if (cause) return cause;
  return e instanceof Error ? e.message.slice(0, 200) : 'the change could not be made';
}

export type { Step };
