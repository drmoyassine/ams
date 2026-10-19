// Scope and champion services (TASK-086): the levels, setting and clearing on a requirement (also on a published version),
// inheritance down the tree and through approved mappings, the batched answer, new versions, permissions, Undo and the tenant boundary.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity } from '@ams/db';
import type { UndoDescriptor } from '@ams/shared';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Ctx } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { requirementContexts } from '../evidence/evidence.js';
import { setUpQualityFramework } from '../framework/internal.js';
import { createRequirement, listRequirements, reviewRequirement } from '../framework/requirements.js';
import { newVersionFrom, publishVersion, submitForReview } from '../framework/versions.js';
import { createMapping, reviewMapping } from '../mapping/mapping.js';
import {
  clearRequirementChampion, clearRequirementScope, createScopeLevel, getOwnAssignment, listScopeItems, listScopeLevels, loadAssignments, reorderScopeLevels, setRequirementChampion,
  setRequirementScope, updateScopeLevel,
} from './index.js';

let w: World;
const ids: Record<string, string> = {};
let lastUndo: UndoDescriptor | null = null;
/** Like w.as, but remembers the Undo the service reported. */
const asU = <T>(who: string, fn: (ctx: Ctx) => Promise<T>) => {
  const caller = { userId: w.ids[who]!, institutionId: w.ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  lastUndo = null;
  return withIdentity(w.pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined, store: w.store, undo: (d) => { lastUndo = d; } }));
};
const one = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows[0].id as string;
const tgt = (code: string, frameworkId = ids.iqfFw!) => ({ frameworkId, code });
const eff = async (versionId: string, code: string) => (await w.as('alo', (c) => loadAssignments(c, versionId))).get(code)!;

beforeAll(async () => {
  w = await buildWorld('scopesvc');
  // The institution's own framework: Q1 > Q1.1, Q1.2 and Q2, published.
  const q = await w.as('admin', (c) => setUpQualityFramework(c));
  ids.qv = q.versions[0]!.id;
  const std = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'Q1', levelLabel: 'Standard', title: 'Teaching quality' }));
  const sub1 = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'Q1.1', levelLabel: 'Sub-standard', title: 'Course review', parentId: std.id }));
  const sub2 = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'Q1.2', levelLabel: 'Sub-standard', title: 'Assessment', parentId: std.id }));
  const std2 = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'Q2', levelLabel: 'Standard', title: 'Students' }));
  for (const r of [std, sub1, sub2, std2]) await w.as('admin', (c) => reviewRequirement(c, r.id, 'approved'));
  await w.as('admin', (c) => submitForReview(c, ids.qv!));
  await w.as('admin', (c) => publishVersion(c, ids.qv!));
  ids.iqfFw = await one(`select framework_id as id from framework_version where id = $1`, [ids.qv]);
  ids.abetFw = await one(`select framework_id as id from framework_version where id = $1`, [w.ids.abet]);
  const ext = await w.as('admin', (c) => listRequirements(c, w.ids.abet!));
  ids.ext1 = ext.find((r) => r.isAssessable)!.id;
  ids.ext2 = ext.filter((r) => r.isAssessable)[1]!.id;
  ids.extCode1 = ext.find((r) => r.id === ids.ext1)!.code;
  ids.extCode2 = ext.find((r) => r.id === ids.ext2)!.code;
  ids.q1 = std.id; ids.q11 = sub1.id; ids.q12 = sub2.id;
  ids.unit = await one(`select id from org_unit limit 1`);
  ids.unit2 = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'department', 'Mechanical') returning id`, [w.ids.inst]);
  ids.prog2 = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS Civil', 'bachelor') returning id`, [w.ids.inst, ids.unit]);
  ids.other = await one(`insert into institution (name_en) values ('Other University') returning id`);
  ids.otherUnit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Theirs') returning id`, [ids.other]);
  ids.otherUser = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'theirs', 'theirs@x.org') returning id`, [ids.other]);
}, 180000);
afterAll(() => w.close());

describe('scope levels', () => {
  it('start as Institution, Unit, Program and Course for every institution, new ones included', async () => {
    const levels = await w.as('contrib', (c) => listScopeLevels(c));
    expect(levels.map((l) => [l.key, l.kind, l.active])).toEqual([['institution', 'institution', true], ['unit', 'org_unit', true], ['program', 'program', true], ['course', 'course', true]]);
    expect(levels.map((l) => l.displayOrder)).toEqual([0, 1, 2, 3]);
    expect(levels.find((l) => l.key === 'unit')!.itemCount).toBe(2);
    expect(levels.find((l) => l.key === 'course')!.itemCount).toBe(0);   // the placeholder: selectable, an empty list
    const theirs = (await w.db.su.query(`select key from scope_level where institution_id = $1 order by display_order`, [ids.other])).rows.map((r) => r.key);
    expect(theirs).toEqual(['institution', 'unit', 'program', 'course']);
  });

  it('lists the units and programs a scope can name', async () => {
    const items = await w.as('alo', (c) => listScopeItems(c));
    expect(items.orgUnit.map((u) => u.nameEn).sort()).toEqual(['Engineering', 'Mechanical']);
    expect(items.program.map((p) => [p.nameEn, p.detail]).sort()).toContainEqual(['BS Civil', 'Engineering']);
  });

  it('are added (custom), renamed, reordered and deactivated by whoever writes the organization; never deleted', async () => {
    await expect(w.as('contrib', (c) => createScopeLevel(c, { labelEn: 'Nope' }))).rejects.toThrow(ForbiddenError);
    const lvl = await asU('admin', (c) => createScopeLevel(c, { labelEn: 'Research centre', labelAr: 'مركز بحث' }));
    expect(lvl).toMatchObject({ key: 'research_centre', kind: 'custom', displayOrder: 4, active: true, itemCount: 0 });
    await expect(w.as('admin', (c) => createScopeLevel(c, { labelEn: 'research CENTRE' }))).rejects.toThrow(ConflictError);
    const renamed = await asU('admin', (c) => updateScopeLevel(c, lvl.id, { labelEn: 'Centre', labelAr: null }));
    expect(renamed).toMatchObject({ labelEn: 'Centre', labelAr: null });
    expect(lastUndo).toMatchObject({ method: 'PATCH', path: `/api/scope-levels/${lvl.id}`, body: { labelEn: 'Research centre', labelAr: 'مركز بحث' } });
    const all = await w.as('admin', (c) => listScopeLevels(c));
    const order = [all[4]!.id, ...all.slice(0, 4).map((l) => l.id)];
    expect((await w.as('admin', (c) => reorderScopeLevels(c, { ids: order }))).map((l) => l.key)[0]).toBe('research_centre');
    await expect(w.as('admin', (c) => reorderScopeLevels(c, { ids: order.slice(1) }))).rejects.toThrow(ValidationError);
    expect((await w.as('admin', (c) => updateScopeLevel(c, lvl.id, { active: false }))).active).toBe(false);
    await w.as('admin', (c) => updateScopeLevel(c, lvl.id, { active: true }));
    // Back to the standard order for the rest of the tests.
    await w.as('admin', (c) => reorderScopeLevels(c, { ids: [...all.slice(0, 4).map((l) => l.id), all[4]!.id] }));
    expect((await w.as('admin', (c) => listScopeLevels(c))).map((l) => l.key)).toEqual(['institution', 'unit', 'program', 'course', 'research_centre']);
  });
});

describe('setting a scope', () => {
  it('needs framework:write; a viewer reads, a contributor cannot set', async () => {
    await expect(w.as('contrib', (c) => setRequirementScope(c, { ...tgt('Q1'), levelKey: 'program', itemIds: [] }))).rejects.toThrow(ForbiddenError);
    await expect(w.as('contrib', (c) => setRequirementChampion(c, { ...tgt('Q1'), userId: w.ids.alo! }))).rejects.toThrow(ForbiddenError);
    expect(await w.as('contrib', (c) => getOwnAssignment(c, tgt('Q1')))).toEqual({ scope: null, champions: [] });
  });

  it('is set on a published version, keyed by code, and reported with an Undo that removes it', async () => {
    const own = await asU('alo', (c) => setRequirementScope(c, { ...tgt('Q1'), levelKey: 'program', itemIds: [w.ids.mech!, ids.prog2!] }));
    expect(own.scope).toEqual({ levelKey: 'program', itemIds: [w.ids.mech, ids.prog2] });
    expect(lastUndo).toMatchObject({ method: 'DELETE', path: expect.stringContaining('/api/requirement-scope?frameworkId=') });
    // Changing it reports the earlier value as the Undo.
    await asU('alo', (c) => setRequirementScope(c, { ...tgt('Q1'), levelKey: 'program', itemIds: [w.ids.mech!] }));
    expect(lastUndo).toMatchObject({ method: 'PUT', path: '/api/requirement-scope', body: { code: 'Q1', levelKey: 'program', itemIds: [w.ids.mech, ids.prog2] } });
    const a = await eff(ids.qv!, 'Q1');
    expect(a.scope.own).toEqual({ levelKey: 'program', itemIds: [w.ids.mech] });
    expect(a.scope.effective).toMatchObject({ levels: [{ levelKey: 'program', labelEn: 'Program', all: false, items: [{ id: w.ids.mech, nameEn: 'BS Mechanical Engineering' }] }], sources: [{ kind: 'own' }] });
  });

  it('refuses a level that does not exist, an inactive one, a list on a level without one, and units of another institution', async () => {
    await expect(w.as('alo', (c) => setRequirementScope(c, { ...tgt('Q1'), levelKey: 'galaxy' }))).rejects.toThrow(ValidationError);
    await expect(w.as('alo', (c) => setRequirementScope(c, { ...tgt('Q1'), levelKey: 'course', itemIds: [w.ids.mech!] }))).rejects.toThrow(/no list to choose from/);
    await expect(w.as('alo', (c) => setRequirementScope(c, { ...tgt('Q1'), levelKey: 'unit', itemIds: [ids.otherUnit!] }))).rejects.toThrow(ValidationError);
    await expect(w.as('alo', (c) => setRequirementScope(c, { ...tgt('Q1'), levelKey: 'unit', itemIds: [w.ids.mech!] }))).rejects.toThrow(ValidationError);   // a program is not a unit
    await expect(w.as('alo', (c) => setRequirementScope(c, { ...tgt('NOPE'), levelKey: 'unit' }))).rejects.toThrow(NotFoundError);
    const course = (await w.as('admin', (c) => listScopeLevels(c))).find((l) => l.key === 'research_centre')!;
    await w.as('admin', (c) => updateScopeLevel(c, course.id, { active: false }));
    await expect(w.as('alo', (c) => setRequirementScope(c, { ...tgt('Q1'), levelKey: 'research_centre' }))).rejects.toThrow(ConflictError);
    await w.as('admin', (c) => updateScopeLevel(c, course.id, { active: true }));
    // A level can be Course (empty list = all courses), the placeholder.
    await w.as('alo', (c) => setRequirementScope(c, { ...tgt('Q2'), levelKey: 'course' }));
    expect((await eff(ids.qv!, 'Q2')).scope.effective).toMatchObject({ levels: [{ levelKey: 'course', all: true, items: [] }] });
    await w.as('alo', (c) => clearRequirementScope(c, tgt('Q2')));
  });
});

describe('inheritance down the framework', () => {
  it('a sub-standard takes its standard\'s scope and champion, with the source; its own value overrides; Back to inherited restores', async () => {
    await w.as('alo', (c) => setRequirementChampion(c, { ...tgt('Q1'), userId: w.ids.coord! }));
    const sub = await eff(ids.qv!, 'Q1.1');
    expect(sub.scope.effective).toMatchObject({ sources: [{ kind: 'parent', code: 'Q1' }] });
    expect(sub.champion.effective).toEqual([expect.objectContaining({ itemKind: null, userId: w.ids.coord, userName: 'coord', needsOne: false, sources: [{ kind: 'parent', code: 'Q1' }] })]);
    expect(sub.scope.own).toBeNull();

    await w.as('alo', (c) => setRequirementScope(c, { ...tgt('Q1.1'), levelKey: 'unit', itemIds: [ids.unit2!] }));
    await w.as('alo', (c) => setRequirementChampion(c, { ...tgt('Q1.1'), userId: w.ids.second! }));
    const own = await eff(ids.qv!, 'Q1.1');
    expect(own.scope.effective).toMatchObject({ levels: [{ levelKey: 'unit', items: [{ nameEn: 'Mechanical' }] }], sources: [{ kind: 'own' }] });
    expect(own.scope.inherited).toMatchObject({ levels: [{ levelKey: 'program' }], sources: [{ kind: 'parent', code: 'Q1' }] });
    expect(own.champion.effective[0]).toMatchObject({ userId: w.ids.second, sources: [{ kind: 'own' }] });
    expect(own.champion.inherited[0]).toMatchObject({ userId: w.ids.coord, sources: [{ kind: 'parent', code: 'Q1' }] });
    // The sibling is untouched.
    expect((await eff(ids.qv!, 'Q1.2')).scope.effective).toMatchObject({ sources: [{ kind: 'parent', code: 'Q1' }] });

    await w.as('alo', (c) => clearRequirementScope(c, tgt('Q1.1')));
    await w.as('alo', (c) => clearRequirementChampion(c, { ...tgt('Q1.1'), all: 'true' }));
    const back = await eff(ids.qv!, 'Q1.1');
    expect(back.scope.own).toBeNull();
    expect(back.scope.effective).toMatchObject({ sources: [{ kind: 'parent', code: 'Q1' }] });
    expect(back.champion.own).toEqual([]);
    expect(back.champion.effective[0]).toMatchObject({ userId: w.ids.coord });
  });

  it('keeps a champion per scoped item beside the overall one, validated against this institution\'s units and programs', async () => {
    await w.as('alo', (c) => setRequirementChampion(c, { ...tgt('Q1'), userId: w.ids.second!, itemKind: 'program', itemId: w.ids.mech! }));
    const a = await eff(ids.qv!, 'Q1.2');
    expect(a.champion.effective.map((c) => [c.itemKind, c.itemName, c.userName])).toEqual([[null, null, 'coord'], ['program', 'BS Mechanical Engineering', 'second']]);
    await expect(w.as('alo', (c) => setRequirementChampion(c, { ...tgt('Q1'), userId: w.ids.second!, itemKind: 'program', itemId: ids.otherUnit! }))).rejects.toThrow(ValidationError);
    await expect(w.as('alo', (c) => setRequirementChampion(c, { ...tgt('Q1'), userId: ids.otherUser! }))).rejects.toThrow(ValidationError);
    await expect(w.as('alo', (c) => setRequirementChampion(c, { ...tgt('Q1'), userId: w.ids.second!, itemKind: 'program' }))).rejects.toThrow(ValidationError);
    // One removed on its own; the overall one stays, and removing a single row offers an Undo that puts it back.
    await asU('alo', (c) => clearRequirementChampion(c, { ...tgt('Q1'), itemKind: 'program', itemId: w.ids.mech! }));
    expect(lastUndo).toMatchObject({ method: 'PUT', path: '/api/requirement-champion', body: { itemKind: 'program', itemId: w.ids.mech, userId: w.ids.second } });
    expect((await eff(ids.qv!, 'Q1.2')).champion.effective.map((c) => c.itemKind)).toEqual([null]);
  });
});

describe('external requirements through approved mappings', () => {
  const map = async (ext: string, internal: string, review: 'approved' | null) => {
    const m = await w.as('alo', (c) => createMapping(c, w.ids.abet!, { externalRequirementId: ext, internalRequirementId: internal, relation: 'covers', rationale: 'same ground' }));
    if (review) await w.as('admin', (c) => reviewMapping(c, m.id, review));
    return m;
  };

  it('a proposed mapping passes nothing; an approved one passes the IQF node\'s scope and champion, labelled "IQF"', async () => {
    const m = await map(ids.ext1!, ids.q12!, null);
    expect((await eff(w.ids.abet!, ids.extCode1!)).scope.effective).toBeNull();
    await w.as('admin', (c) => reviewMapping(c, m.id, 'approved'));
    const a = await eff(w.ids.abet!, ids.extCode1!);
    expect(a.scope.effective).toMatchObject({ levels: [{ levelKey: 'program', items: [{ nameEn: 'BS Mechanical Engineering' }] }], sources: [{ kind: 'iqf', code: 'Q1.2' }] });
    expect(a.champion.effective).toEqual([expect.objectContaining({ itemKind: null, userName: 'coord', sources: [{ kind: 'iqf', code: 'Q1.2' }] })]);
  });

  it('unites the scopes of several mapped nodes and asks for a champion when they disagree', async () => {
    await map(ids.ext1!, ids.q11!, 'approved');   // Q1.1 inherits Q1 (program, coord): agrees so far
    expect((await eff(w.ids.abet!, ids.extCode1!)).champion.effective[0]).toMatchObject({ userName: 'coord', needsOne: false, sources: [{ code: 'Q1.1' }, { code: 'Q1.2' }].map((s) => ({ kind: 'iqf', ...s })) });
    await w.as('alo', (c) => setRequirementScope(c, { ...tgt('Q1.1'), levelKey: 'unit', itemIds: [ids.unit2!] }));
    await w.as('alo', (c) => setRequirementChampion(c, { ...tgt('Q1.1'), userId: w.ids.second! }));
    const a = await eff(w.ids.abet!, ids.extCode1!);
    expect(a.scope.effective!.levels.map((l) => l.levelKey).sort()).toEqual(['program', 'unit']);
    expect(a.champion.effective[0]).toMatchObject({ userId: null, userName: null, needsOne: true });
  });

  it('can be overridden on the external requirement itself, and "Back to inherited" shows and restores the mapped value', async () => {
    await w.as('alo', (c) => setRequirementChampion(c, { frameworkId: ids.abetFw!, code: ids.extCode1!, userId: w.ids.contrib! }));
    await w.as('alo', (c) => setRequirementScope(c, { frameworkId: ids.abetFw!, code: ids.extCode1!, levelKey: 'institution' }));
    const a = await eff(w.ids.abet!, ids.extCode1!);
    expect(a.champion.effective[0]).toMatchObject({ userName: 'contrib', needsOne: false, sources: [{ kind: 'own' }] });
    expect(a.champion.inherited[0]).toMatchObject({ needsOne: true });
    expect(a.scope.effective).toMatchObject({ levels: [{ levelKey: 'institution', all: true }], sources: [{ kind: 'own' }] });
    expect(a.scope.inherited!.levels.map((l) => l.levelKey).sort()).toEqual(['program', 'unit']);
    await w.as('alo', (c) => clearRequirementChampion(c, { frameworkId: ids.abetFw!, code: ids.extCode1!, all: 'true' }));
    await w.as('alo', (c) => clearRequirementScope(c, { frameworkId: ids.abetFw!, code: ids.extCode1! }));
    const back = await eff(w.ids.abet!, ids.extCode1!);
    expect(back.scope.own).toBeNull();
    expect(back.champion.effective[0]).toMatchObject({ needsOne: true });
  });

  it('shows in the version\'s batched context (the hover card\'s data), for the external standard and for the IQF', async () => {
    const ext = await w.as('contrib', (c) => requirementContexts(c, w.ids.abet!));
    expect(ext.byCode[ids.extCode1!]!.scope!.effective!.levels.length).toBe(2);
    expect(ext.byCode[ids.extCode1!]!.champion!.effective[0]!.needsOne).toBe(true);
    const iqf = await w.as('contrib', (c) => requirementContexts(c, ids.qv!));
    expect(iqf.byCode.Q1!.scope!.effective!.sources).toEqual([{ kind: 'own', code: null }]);
    expect(iqf.byCode.Q2!.scope!.effective).toBeNull();
  });

  it('carries over to the next version of the standard without copying: same codes, same values', async () => {
    const before = await eff(w.ids.abet!, ids.extCode1!);
    await w.as('alo', (c) => setRequirementScope(c, { frameworkId: ids.abetFw!, code: ids.extCode2!, levelKey: 'program', itemIds: [ids.prog2!] }));
    const draft = await w.as('admin', (c) => newVersionFrom(c, w.ids.abet!, { edition: 'next' }));
    const after = await eff(draft.version.id, ids.extCode1!);
    expect(after).toEqual(before);
    expect((await eff(draft.version.id, ids.extCode2!)).scope.own).toEqual({ levelKey: 'program', itemIds: [ids.prog2] });
  });
});

describe('tenant boundary and the worker', () => {
  it('another institution sees none of it, and rows cannot name its units or people', async () => {
    const rows = await w.db.as({ userId: ids.otherUser!, institutionId: ids.other! }, (cl) => cl.query(`select id from requirement_scope union all select id from requirement_champion`));
    expect(rows.rows).toEqual([]);
    await expect(w.db.su.query(`insert into requirement_champion (institution_id, framework_id, code, user_id) values ($1, $2, 'Q1', $3)`, [w.ids.inst, ids.iqfFw, ids.otherUser])).rejects.toThrow(/person of the same institution/);
    await expect(w.db.su.query(`insert into requirement_scope (institution_id, framework_id, code, level_key, item_ids) values ($1, $2, 'Q1', 'unit', $3)`, [w.ids.inst, ids.iqfFw, [ids.otherUnit]])).rejects.toThrow();
  });
});
