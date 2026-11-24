// Standards numbered by their place (the owner, 2026-11-23): a move or a delete in a draft renumbers it; the published version keeps
// its codes; at publish, what was attached to an old code (scope, champion, evidence link) follows the standard to its new code.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, type World } from '../engagement/test-support.js';
import { setUpQualityFramework } from './internal.js';
import { createRequirement, listRequirements, moveRequirement, reviewRequirement } from './requirements.js';
import { newVersionFrom, publishVersion, submitForReview, updateVersionConfig } from './versions.js';
import { deleteRequirement } from '../trash/delete.js';
import { getOwnAssignment, setRequirementChampion, setRequirementScope } from '../scope/index.js';
import { placeCodes } from './renumber.js';

let w: World;
const ids: Record<string, string> = {};
const one = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows[0].id as string;
const codes = async (v: string) => (await w.as('admin', (c) => listRequirements(c, v))).map((r) => `${r.code} ${r.title}`);
const approveAll = async (v: string) => { for (const r of await w.as('admin', (c) => listRequirements(c, v))) if (r.reviewStatus !== 'approved') await w.as('admin', (c) => reviewRequirement(c, r.id, 'approved')); };

beforeAll(async () => {
  w = await buildWorld('renumber');
  const q = await w.as('admin', (c) => setUpQualityFramework(c));
  ids.v1 = q.versions[0]!.id;
  await w.as('admin', (c) => updateVersionConfig(c, ids.v1!, { autoNumber: true }));
  const a = await w.as('admin', (c) => createRequirement(c, { versionId: ids.v1!, code: 'A', levelLabel: 'Standard', title: 'Mission' }));
  const b = await w.as('admin', (c) => createRequirement(c, { versionId: ids.v1!, code: 'B', levelLabel: 'Standard', title: 'Programs' }));
  await w.as('admin', (c) => createRequirement(c, { versionId: ids.v1!, code: 'x', levelLabel: 'Sub', title: 'Design', parentId: b.id }));
  await w.as('admin', (c) => createRequirement(c, { versionId: ids.v1!, code: 'y', levelLabel: 'Sub', title: 'Review', parentId: b.id }));
  void a;
}, 180000);
afterAll(() => w.close());

describe('standards numbered by their place', () => {
  it('places codes by position: 1, 2, 2.1, 2.2', () => {
    const m = placeCodes([{ id: 'a', parentId: null, code: 'z', displayOrder: 5 }, { id: 'b', parentId: null, code: 'y', displayOrder: 1 }, { id: 'c', parentId: 'b', code: 'q', displayOrder: 0 }]);
    expect([...m].map(([id, v]) => `${id}=${v.code}`)).toEqual(['b=1', 'c=1.1', 'a=2']);
  });

  it('numbers a draft as it is built, and the attached data follows a renumbered standard when the draft is published', async () => {
    expect(await codes(ids.v1!)).toEqual(['1 Mission', '2 Programs', '2.1 Design', '2.2 Review']);
    await approveAll(ids.v1!);
    await w.as('admin', (c) => submitForReview(c, ids.v1!));
    await w.as('admin', (c) => publishVersion(c, ids.v1!));
    ids.fw = await one(`select framework_id as id from framework_version where id = $1`, [ids.v1]);
    // Scope and champion on 2.2 (Review), an evidence link on it too.
    await w.as('admin', (c) => setRequirementScope(c, { frameworkId: ids.fw!, code: '2.2', levelKey: 'program', itemIds: [w.ids.mech!] }));
    await w.as('admin', (c) => setRequirementChampion(c, { frameworkId: ids.fw!, code: '2.2', userId: w.ids.alo! }));
    const item = await one(`insert into evidence_item (institution_id, title, type) values ($1, 'Review report', 'document') returning id`, [w.ids.inst]);
    const ver = await one(`insert into evidence_version (institution_id, evidence_item_id, version_no, url) values ($1, $2, 1, 'https://x.example/r') returning id`, [w.ids.inst, item]);
    await w.db.su.query(`insert into evidence_link (institution_id, evidence_version_id, internal_framework_id, internal_code, rationale, review_status) values ($1, $2, $3, '2.2', 'r', 'approved')`, [w.ids.inst, ver, ids.fw]);

    // The next version: Review moves above Design, then Mission is deleted.
    const d = await w.as('admin', (c) => newVersionFrom(c, ids.v1!, { edition: '2' }));
    ids.v2 = d.version.id;
    const reqs = await w.as('admin', (c) => listRequirements(c, ids.v2!));
    const review = reqs.find((r) => r.title === 'Review')!; const programs = reqs.find((r) => r.title === 'Programs')!;
    await w.as('admin', (c) => moveRequirement(c, review.id, programs.id, -1));
    expect(await codes(ids.v2!)).toEqual(['1 Mission', '2 Programs', '2.1 Review', '2.2 Design']);
    await w.as('admin', (c) => deleteRequirement(c, reqs.find((r) => r.title === 'Mission')!.id));
    expect(await codes(ids.v2!)).toEqual(['1 Programs', '1.1 Review', '1.2 Design']);
    // The published version keeps its codes, and the scope stays on its 2.2 until the draft is published.
    expect(await codes(ids.v1!)).toEqual(['1 Mission', '2 Programs', '2.1 Design', '2.2 Review']);
    expect((await w.as('admin', (c) => getOwnAssignment(c, { frameworkId: ids.fw!, code: '2.2' }))).scope).not.toBeNull();

    await approveAll(ids.v2!);
    await w.as('admin', (c) => submitForReview(c, ids.v2!));
    await w.as('admin', (c) => publishVersion(c, ids.v2!));
    const now = await w.as('admin', (c) => getOwnAssignment(c, { frameworkId: ids.fw!, code: '1.1' }));
    expect(now.scope).toMatchObject({ levelKey: 'program', itemIds: [w.ids.mech] });
    expect(now.champions.map((x) => x.userId)).toEqual([w.ids.alo]);
    expect((await w.as('admin', (c) => getOwnAssignment(c, { frameworkId: ids.fw!, code: '2.2' }))).scope).toBeNull();
    expect((await w.db.su.query(`select internal_code from evidence_link where evidence_version_id = $1`, [ver])).rows[0].internal_code).toBe('1.1');
  });
});
