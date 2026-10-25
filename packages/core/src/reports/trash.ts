// Deleting a draft report to the Trash and putting it back (DEC-026). A draft is the only report that is deleted — once
// it is internally approved or submitted it is part of the record. It goes with its sections and requirement links, as one
// Trash item (kind `report`), and comes back with the same ids.
import { sql } from 'drizzle-orm';
import type { DeleteResult } from '@ams/shared';
import { plural } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { deleteRows, emptyPayload, existing, idsOf, insertRows, readRows, readWhere, uuids, type Row, type TrashPayload } from '../trash/rows.js';
import { reportUndo, restoreUndo, writeTrash } from '../trash/store.js';
import { assertManage, loadReport } from './common.js';

const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** Deletes a draft report to the Trash. */
export async function deleteReport(ctx: Ctx, input: { id: string }): Promise<DeleteResult> {
  assertHuman(ctx);
  const r = await loadReport(ctx, input.id);
  await assertManage(ctx, r);
  if (r.status !== 'draft') throw new ConflictError(`A report that is ${r.status.replace('_', ' ')} is not deleted; it is part of the record. Only a draft can be deleted.`);

  const [reportRow] = await readRows(ctx, 'report', [r.id]);
  const sections = await readWhere(ctx, 'report_section', sql`t.report_id = ${r.id}::uuid`);
  const sectionIds = idsOf(sections);
  const links = await readWhere(ctx, 'report_section_requirement', sql`t.section_id = any(${uuids(sectionIds)})`);

  const payload: TrashPayload = {
    ...emptyPayload({ reportId: r.id, engagementId: r.engagementId, name: r.title }),
    tables: { report: [reportRow!], report_section: sections, report_section_requirement: links }, files: [],
  };
  // Children first: the database lets sections and links go only while the report is a draft, and the report last.
  await deleteRows(ctx, 'report_section_requirement', idsOf(links));
  await deleteRows(ctx, 'report_section', sectionIds);
  await deleteRows(ctx, 'report', [r.id]);
  const groupId = await writeTrash(ctx, [{
    kind: 'report', label: r.title, context: 'Reports', payload,
    counts: { items: 1, sections: sections.length, links: links.length },
  }]);
  const label = `Deleted the report ${r.title}${sections.length ? ` and its ${plural(sections.length, 'section')}` : ''}`;
  reportUndo(ctx, restoreUndo(groupId, label));
  return { groupId, label, counts: { items: 1, sections: sections.length }, items: 1 };
}

/** Puts a deleted draft report back, all or nothing. */
export async function restoreReport(ctx: Ctx, payload: TrashPayload): Promise<{ restored: Record<string, number> }> {
  assertHuman(ctx);
  const [row] = (payload.tables.report ?? []) as Row[];
  if (!row) throw new ConflictError('Cannot restore: the snapshot is empty.');
  await assertManage(ctx, {
    engagementId: text(row.engagement_id) || null,
    subjectKind: (text(row.subject_kind) || null) as 'institution' | 'org_unit' | 'program' | null,
    subjectId: text(row.subject_id) || null,
  });
  const sectionsIn = payload.tables.report_section ?? [];
  // The version, the template and (for an engagement report) the engagement must still exist — the sections' requirement
  // links point into the version, so the version is the guard that matters for them.
  const [version] = (await ctx.tx.execute<{ id: string }>(sql`select id from framework_version where id = ${text(row.framework_version_id)}::uuid`)).rows;
  if (!version) throw new ConflictError('Cannot restore: the framework edition this report was made from no longer exists.');
  const [tpl] = (await ctx.tx.execute<{ id: string }>(sql`select id from report_template where id = ${text(row.template_id)}::uuid`)).rows;
  if (!tpl) throw new ConflictError('Cannot restore: the template this report was made from no longer exists.');
  if (row.engagement_id) {
    const [eng] = (await ctx.tx.execute<{ id: string }>(sql`select id from engagement where id = ${text(row.engagement_id)}::uuid`)).rows;
    if (!eng) throw new ConflictError('Cannot restore: the engagement this report belongs to no longer exists.');
  }
  // A requirement a section points at that is itself in the Trash (or gone) takes no link back; an owner who has since
  // left the institution comes off, and the section is flagged for a person — nothing is guessed (TASK-091).
  const linkRows = (payload.tables.report_section_requirement ?? []).filter((l) => text(l.requirement_id));
  const reqIds = [...new Set(linkRows.map((l) => text(l.requirement_id)))];
  const liveReqs = await existing(ctx, 'requirement', reqIds);
  const links = linkRows.filter((l) => liveReqs.has(text(l.requirement_id)));
  const ownerIds = [...new Set(sectionsIn.map((s) => text(s.owner_id)).filter(Boolean))];
  const liveOwners = new Set((await ctx.tx.execute<{ id: string }>(
    sql`select id from app_user where institution_id = ${ctx.caller.institutionId}::uuid and id = any(${uuids(ownerIds)})`)).rows.map((r) => r.id));
  const sections = sectionsIn.map((s) => {
    const owner = text(s.owner_id);
    if (!owner || liveOwners.has(owner)) return s;
    return { ...s, owner_id: null, owner_unresolved: true };
  });
  await insertRows(ctx, 'report', [row]);
  await insertRows(ctx, 'report_section', sections);
  await insertRows(ctx, 'report_section_requirement', links);
  const dropped = linkRows.length - links.length;
  return { restored: { reports: 1, sections: sections.length, links: links.length, ...(dropped ? { droppedLinks: dropped } : {}) } };
}

/** The delete that undoes a restore (its Redo). */
export const redeleteReportBody = (payload: TrashPayload) => ({ id: text((payload.root as { reportId?: unknown }).reportId) });
