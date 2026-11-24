// Standards numbered by their place (the owner, 2026-11-23): a move or a delete in a draft renumbers it; the published version keeps
// its codes; at publish, what was attached to an old code (scope, champion, evidence link) follows the standard to its new code.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, type World } from '../engagement/test-support.js';
import { setUpQualityFramework } from './internal.js';
import { createRequirement, listRequirements, moveRequirement, reviewRequirement } from './requirements.js';
import { newVersionFrom, publishVersion, submitForReview } from './versions.js';
import { deleteRequirement } from '../trash/delete.js';
import { getOwnAssignment, setRequirementChampion, setRequirementScope } from '../scope/index.js';
import { placeCodes } from './renumber.js';
import { linkToRequirement, linksForInternal } from '../evidence/evidence.js';

let w: World;
const ids: Record<string, string> = {};
const one = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows[0].id as string;
const codes = async (v: string) => (await w.as('admin', (c) => listRequirements(c, v))).map((r) => `${r.code} ${r.title}`);
const approveAll = async (v: string) => { for (const r of await w.as('admin', (c) => listRequirements(c, v))) if (r.reviewStatus !== 'approved') await w.as('admin', (c) => reviewRequirement(c, r.id, 'approved')); };

beforeAll(async () => {
  w = await buildWorld('renumber');
  const q = await w.as('admin', (c) => setUpQualityFramework(c));
  ids.v1 = q.versions[0]!.id;
  const a = await w.as('admin', (c) => createRequirement(c, { versionId: ids.v1!, code: '7', levelLabel: 'Standard', title: 'Mission' }));
  const b = await w.as('admin', (c) => createRequirement(c, { versionId: ids.v1!, code: '8', levelLabel: 'Standard', title: 'Programs' }));
  await w.as('admin', (c) => createRequirement(c, { versionId: ids.v1!, code: '8.5', levelLabel: 'Sub', title: 'Design', parentId: b.id }));
  await w.as('admin', (c) => createRequirement(c, { versionId: ids.v1!, code: '8.6', levelLabel: 'Sub', title: 'Review', parentId: b.id }));
  void a;
}, 180000);
afterAll(() => w.close());

describe('standards numbered by their place', () => {
  it('places codes by position: 1, 2, 2.1, 2.2', () => {
    const m = placeCodes([{ id: 'a', parentId: null, code: '9', displayOrder: 5 }, { id: 'b', parentId: null, code: '4', displayOrder: 1 }, { id: 'c', parentId: 'b', code: '4.7', displayOrder: 0 }]);
    expect([...m].map(([id, v]) => `${id}=${v.code}`)).toEqual(['b=1', 'c=1.1', 'a=2']);
  });

  it('keeps the words and separators of an accreditor\'s codes and renumbers only their numbers', () => {
    const codes = (rows: [string, string | null, string][]) => {
      const m = placeCodes(rows.map(([id, parentId, code], i) => ({ id, parentId, code, displayOrder: i })));
      return rows.map(([id]) => m.get(id)!.code);
    };
    // Criterion 3 moved above Criterion 2; its outcomes 3(4) and 3(2) in that order.
    expect(codes([['c1', null, 'Criterion 1'], ['c3', null, 'Criterion 3'], ['o4', 'c3', 'Criterion 3(4)'], ['o2', 'c3', 'Criterion 3(2)'], ['c2', null, 'Criterion 2']]))
      .toEqual(['Criterion 1', 'Criterion 2', 'Criterion 2(1)', 'Criterion 2(2)', 'Criterion 3']);
    // Dashes, three levels.
    expect(codes([['a', null, '1'], ['b', 'a', '1-2'], ['c', 'b', '1-2-3'], ['d', 'a', '1-1']])).toEqual(['1', '1-1', '1-1-1', '1-2']);
    // Headings that add no number: the count of their children runs on across them.
    expect(codes([['s', null, 'Standard 1'], ['h1', 's', 'Standard 1 - Purposes'], ['f1', 'h1', 'CFR 1.1'], ['f2', 'h1', 'CFR 1.2'],
      ['h2', 's', 'Standard 1 - Integrity'], ['f3', 'h2', 'CFR 1.4'], ['t', null, 'Standard 2'], ['f4', 't', 'CFR 2.3']]))
      .toEqual(['Standard 1', 'Standard 1 - Purposes', 'CFR 1.1', 'CFR 1.2', 'Standard 1 - Integrity', 'CFR 1.3', 'Standard 2', 'CFR 2.1']);
    // A code without numbers stays and takes no place.
    expect(codes([['p', null, 'Preamble'], ['a', null, 'Article 4'], ['b', null, 'Article 9']])).toEqual(['Preamble', 'Article 1', 'Article 2']);
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

  it('a standard added in a draft takes its attachments along when it is renumbered, and keeps them through the publish', async () => {
    const d = await w.as('admin', (c) => newVersionFrom(c, ids.v2!, { edition: '3' }));
    ids.v3 = d.version.id;
    const ethics = await w.as('admin', (c) => createRequirement(c, { versionId: ids.v3!, code: '5', levelLabel: 'Standard', title: 'Ethics' }));
    expect(await codes(ids.v3!)).toEqual(['1 Programs', '1.1 Review', '1.2 Design', '2 Ethics']);
    const item = await one(`insert into evidence_item (institution_id, title, type) values ($1, 'Ethics code', 'document') returning id`, [w.ids.inst]);
    const ver = await one(`insert into evidence_version (institution_id, evidence_item_id, version_no, url) values ($1, $2, 1, 'https://x.example/e') returning id`, [w.ids.inst, item]);
    await w.as('admin', (c) => linkToRequirement(c, ethics.id, { evidenceVersionId: ver, rationale: 'r' }));
    // Ethics moves to the top: it takes 1, which the published Programs still has; its link stays with it.
    const reqs = await w.as('admin', (c) => listRequirements(c, ids.v3!));
    await w.as('admin', (c) => moveRequirement(c, ethics.id, null, -1));
    expect(await codes(ids.v3!)).toEqual(['1 Ethics', '2 Programs', '2.1 Review', '2.2 Design']);
    expect((await w.as('admin', (c) => linksForInternal(c, ethics.id))).map((l) => l.evidenceVersionId)).toEqual([ver]);
    // The carried Programs shows what the published Programs has (its Review evidence sits under its sub-standard).
    const review = reqs.find((r) => r.title === 'Review')!;
    expect((await w.as('admin', (c) => linksForInternal(c, review.id)))).toHaveLength(1);
    expect((await w.as('admin', (c) => linksForInternal(c, ethics.id))).map((l) => l.evidenceVersionId)).not.toContain(undefined);
    await approveAll(ids.v3!);
    await w.as('admin', (c) => submitForReview(c, ids.v3!));
    await w.as('admin', (c) => publishVersion(c, ids.v3!));
    expect((await w.db.su.query(`select internal_code from evidence_link where evidence_version_id = $1`, [ver])).rows[0].internal_code).toBe('1');
    expect((await w.as('admin', (c) => getOwnAssignment(c, { frameworkId: ids.fw!, code: '2.1' }))).scope).toMatchObject({ levelKey: 'program' });
  });
});
