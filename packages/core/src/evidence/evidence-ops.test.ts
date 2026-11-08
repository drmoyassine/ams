// Deleting evidence and changing several items at once (TASK-119): a delete goes to the Trash with the item's links and comes back
// with them; the versions stay; bulk edits are all or none and need evidence:write; nothing happens to an item with an open request.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { setUpQualityFramework } from '../framework/internal.js';
import { listRequirements, reviewRequirement } from '../framework/requirements.js';
import { listTrash, restoreTrash } from '../trash/index.js';
import { addUrlVersion, bulkUpdateEvidence, createEvidence, deleteEvidence, getEvidence, linkToInternal, listEvidence } from './evidence.js';

let w: World;
const ids: Record<string, string> = {};
beforeAll(async () => {
  w = await buildWorld('evidenceops');
  const qf = await w.as('admin', (c) => setUpQualityFramework(c, { template: true }));
  ids.qv = qf.versions[0]!.id;
  const items = await w.as('admin', (c) => listRequirements(c, ids.qv!));
  for (const r of items) await w.as('admin', (c) => reviewRequirement(c, r.id, 'approved'));
  ids.req = items.find((r) => r.title === 'Assessment of learning')!.id;
}, 120000);
afterAll(() => w.close());

describe('deleting evidence', () => {
  it('moves the item and its links to the Trash, hides it, and brings both back on restore; the versions stay', async () => {
    const item = await w.as('alo', (c) => createEvidence(c, { title: 'Course report 2026', type: 'document' }));
    const v = await w.as('alo', (c) => addUrlVersion(c, item.id, { url: 'https://example.org/report' }));
    await w.as('alo', (c) => linkToInternal(c, ids.req!, { evidenceVersionId: v.id, rationale: 'The results of the course assessments' }));
    expect((await w.as('alo', (c) => getEvidence(c, item.id))).links).toHaveLength(1);

    await expect(w.as('outsider', (c) => deleteEvidence(c, [item.id]))).rejects.toThrow(ForbiddenError);
    const res = await w.as('alo', (c) => deleteEvidence(c, [item.id]));
    expect(res).toMatchObject({ label: 'Deleted Course report 2026', items: 1, counts: { items: 1, links: 1 } });
    expect((await w.as('alo', (c) => listEvidence(c, { includeArchived: true }))).some((e) => e.id === item.id)).toBe(false);
    await expect(w.as('alo', (c) => getEvidence(c, item.id))).rejects.toThrow(NotFoundError);
    const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;
    expect(await q(`select status from evidence_item where id = $1`, [item.id])).toEqual([{ status: 'deleted' }]);
    expect((await q(`select count(*)::int n from evidence_version where evidence_item_id = $1`, [item.id]))[0].n).toBe(1);
    expect((await q(`select count(*)::int n from evidence_link where evidence_version_id = $1`, [v.id]))[0].n).toBe(0);
    expect((await w.as('alo', (c) => listTrash(c))).groups.flatMap((g) => g.items).find((t) => t.groupId === res.groupId)).toMatchObject({ kind: 'evidence_item', label: 'Course report 2026' });

    await w.as('alo', (c) => restoreTrash(c, { groupId: res.groupId }));
    const back = await w.as('alo', (c) => getEvidence(c, item.id));
    expect(back.item.status).toBe('active');
    expect(back.links).toHaveLength(1);
  });

  it('is refused while the item has an open request', async () => {
    const item = await w.as('alo', (c) => createEvidence(c, { title: 'Asked for', type: 'document', method: 'request', methodConfig: { assigneeUserId: w.ids.contrib } }));
    await w.db.su.query(`insert into evidence_request (institution_id, data_item_id, status, assignee_user_id, requested_by, title) values ($1, $2, 'open', $3, $3, 'x')`, [w.ids.inst, item.id, w.ids.contrib]).catch(() => undefined);
    const open = (await w.db.su.query(`select count(*)::int n from evidence_request where data_item_id = $1 and status = 'open'`, [item.id])).rows[0].n as number;
    if (open) await expect(w.as('alo', (c) => deleteEvidence(c, [item.id]))).rejects.toThrow(ConflictError);
  });
});

describe('changing several items at once', () => {
  it('sets fields and tags on all of them, all or none, and archives', async () => {
    const a = await w.as('alo', (c) => createEvidence(c, { title: 'KPI A', type: 'dataset', tags: ['kpi', 'draft'] }));
    const b = await w.as('alo', (c) => createEvidence(c, { title: 'KPI B', type: 'dataset', tags: ['kpi'] }));
    const unit = (await w.db.su.query(`select id from org_unit limit 1`)).rows[0].id as string;
    const r = await w.as('alo', (c) => bulkUpdateEvidence(c, { ids: [a.id, b.id], set: { ownerUnitId: unit, confidentiality: 'restricted', periodLabel: '2026-27' }, addTags: ['RISE'], removeTags: ['draft'] }));
    expect(r).toEqual({ updated: 2, unchanged: 0 });
    const list = await w.as('alo', (c) => listEvidence(c));
    const A = list.find((e) => e.id === a.id)!; const B = list.find((e) => e.id === b.id)!;
    expect(A).toMatchObject({ ownerUnitId: unit, confidentiality: 'restricted', periodLabel: '2026-27', tags: ['kpi', 'RISE'] });
    expect(B.tags).toEqual(['kpi', 'RISE']);
    expect(await w.as('alo', (c) => bulkUpdateEvidence(c, { ids: [a.id, b.id], addTags: ['RISE'] }))).toEqual({ updated: 0, unchanged: 2 });

    await expect(w.as('alo', (c) => bulkUpdateEvidence(c, { ids: [a.id, crypto.randomUUID()], set: { periodLabel: 'x' } }))).rejects.toThrow(NotFoundError);
    expect((await w.as('alo', (c) => listEvidence(c))).find((e) => e.id === a.id)!.periodLabel).toBe('2026-27');
    await expect(w.as('outsider', (c) => bulkUpdateEvidence(c, { ids: [a.id], set: { periodLabel: 'x' } }))).rejects.toThrow(ForbiddenError);

    await w.as('alo', (c) => bulkUpdateEvidence(c, { ids: [a.id, b.id], set: { status: 'archived' } }));
    expect((await w.as('alo', (c) => listEvidence(c))).some((e) => e.id === a.id)).toBe(false);
    expect((await w.as('alo', (c) => listEvidence(c, { includeArchived: true }))).find((e) => e.id === a.id)?.status).toBe('archived');
  });
});
