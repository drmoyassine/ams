// Catalog editions and versions (DEC-046, step 4): the snapshot, what changed, publishing as a frozen version, starting the next edition.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createCourse, setCourseProgram, updateCourse } from '../outcomes/courses.js';
import { updateProgram } from '../org/programs.js';
import { createConcentration, createGenedArea, setAreaCourses, setCatalogSettings, setProgramBlock } from './catalog.js';
import { diffSnapshots, getCatalogVersion, listCatalogEditions, previewCatalogSnapshot, publishCatalogVersion, startCatalogEdition } from './editions.js';

let w: World;
const ids = {} as Record<string, string>;
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;
beforeAll(async () => {
  w = await buildWorld('catalogeditions');
  await w.as('alo', (c) => updateProgram(c, w.ids.mech!, { code: 'BS-ME', credits: 12 }));
  for (const [code, title, credits] of [['ENG 101', 'English I', 3], ['MCE 201', 'Statics', 3], ['MCE 301', 'Dynamics', 3]] as const) ids[code] = (await w.as('alo', (c) => createCourse(c, { code, titleEn: title, credits, orgUnitId: null } as never))).id;
  await w.as('alo', (c) => setCourseProgram(c, ids['ENG 101']!, w.ids.mech!, { role: 'core', year: 1, term: 1, block: 'general_education' }));
  await w.as('alo', (c) => setCourseProgram(c, ids['MCE 201']!, w.ids.mech!, { role: 'core', year: 2, term: 1, block: 'major' }));
  await w.as('alo', (c) => setCatalogSettings(c, { genedCredits: 3 }));
  const area = await w.as('alo', (c) => createGenedArea(c, { code: 'ENG', nameEn: 'English', minCredits: 3 }));
  await w.as('alo', (c) => setAreaCourses(c, area.id, [ids['ENG 101']!]));
}, 120000);
afterAll(() => w.close());

describe('the snapshot', () => {
  it('holds what a catalog prints: programs with their plan and blocks, the courses in a plan or a pool, General education', async () => {
    const s = await w.as('alo', (c) => previewCatalogSnapshot(c));
    expect(s).toMatchObject({ schema: 1, gened: { credits: 3, areas: [{ code: 'ENG', courses: ['ENG 101'] }] } });
    const p = s.programs.find((x) => x.code === 'BS-ME')!;
    expect(p).toMatchObject({ nameEn: 'BS Mechanical Engineering', type: 'degree', college: 'Engineering', credits: 12 });
    expect(p.plan.map((x) => [x.course, x.block, x.year])).toEqual([['ENG 101', 'general_education', 1], ['MCE 201', 'major', 2]]);
    expect(s.courses.map((c) => c.code)).toEqual(['ENG 101', 'MCE 201']); // MCE 301 is in no plan
  });
});

describe('editions and versions', () => {
  it('needs an edition first; publishes version 1 with a first-version change; Academic Affairs only', async () => {
    await expect(w.as('alo', (c) => publishCatalogVersion(c, {}))).rejects.toThrow(/start one first/);
    await expect(w.as('contrib', (c) => startCatalogEdition(c, '2026-27'))).rejects.toThrow(ForbiddenError);
    const ed = await w.as('alo', (c) => startCatalogEdition(c, '2026-27'));
    expect(ed).toMatchObject({ label: '2026-27', status: 'working', versions: [] });
    await expect(w.as('alo', (c) => startCatalogEdition(c, '2027-28'))).rejects.toThrow(/no published version yet/);
    await expect(w.as('contrib', (c) => publishCatalogVersion(c, {}))).rejects.toThrow(ForbiddenError);
    const v1 = await w.as('alo', (c) => publishCatalogVersion(c, { note: 'First release' }));
    expect(v1).toMatchObject({ versionNo: 1, note: 'First release', changeCount: 1 });
    ids.v1 = v1.id;
    const full = await w.as('alo', (c) => getCatalogVersion(c, v1.id));
    expect(full.changes[0]).toMatchObject({ area: 'Catalog' });
    expect(full.editionLabel).toBe('2026-27');
    expect(full.snapshot.programs.map((p) => p.code)).toContain('BS-ME');
  });

  it('a published version never changes; the next one lists exactly what changed, and nothing new is refused', async () => {
    await expect(q(`update catalog_version set note = 'x' where id = $1`, [ids.v1])).rejects.toThrow(/cannot be changed/);
    await expect(q(`delete from catalog_version where id = $1`, [ids.v1])).rejects.toThrow(/cannot be changed/);
    await expect(w.as('alo', (c) => publishCatalogVersion(c, {}))).rejects.toThrow(ConflictError); // nothing changed
    // The draft shows the changes before they are published.
    await w.as('alo', (c) => setCourseProgram(c, ids['MCE 301']!, w.ids.mech!, { role: 'core', year: 3, term: 1, block: 'major' }));
    await w.as('alo', (c) => setCourseProgram(c, ids['MCE 201']!, w.ids.mech!, { role: 'elective', year: 2, term: 2, block: 'major' }));
    await w.as('alo', (c) => updateCourse(c, ids['MCE 201']!, { credits: 4 } as never));
    await w.as('alo', (c) => createConcentration(c, { programId: w.ids.mech!, code: 'DYN', nameEn: 'Dynamics' }));
    await w.as('alo', (c) => setProgramBlock(c, { programId: w.ids.mech!, block: 'major', requirement: 'core', credits: 7 }));
    const list = await w.as('alo', (c) => listCatalogEditions(c));
    expect(list.draft).toMatchObject({ nextVersionNo: 2 });
    expect(list.draft!.changes.map((c) => `${c.area} ${c.subject}: ${c.text}`).sort()).toEqual([
      'Course MCE 201: Credit hours: 3 → 4.',
      'Course MCE 301: Dynamics added.',
      'Program BS-ME: Concentration Dynamics added.',
      'Program BS-ME: Major requirements core credits: none → 7.',
      'Study plan BS-ME: MCE 201 moved from year 2 term 1 to year 2 term 2.',
      'Study plan BS-ME: MCE 201: now Major requirements, elective (was Major requirements, core).',
      'Study plan BS-ME: MCE 301 added (Major requirements, core, year 3 term 1).',
    ]);
    expect(list.draft!.problems.length).toBeGreaterThan(0); // the credits do not add up: shown, not a reason to refuse
    const v2 = await w.as('alo', (c) => publishCatalogVersion(c, { note: 'Added Dynamics' }));
    expect(v2).toMatchObject({ versionNo: 2, changeCount: 7 });
    // Version 1 is still what it was.
    expect((await w.as('alo', (c) => getCatalogVersion(c, ids.v1!))).snapshot.programs.find((p) => p.code === 'BS-ME')!.plan.map((x) => x.course)).toEqual(['ENG 101', 'MCE 201']);
    expect((await w.as('alo', (c) => listCatalogEditions(c))).editions[0]!.versions.map((v) => v.versionNo)).toEqual([2, 1]);
  });

  it('starts the next edition from what is live: the old one is closed, and its first version is compared with the last of the old one', async () => {
    await expect(w.as('alo', (c) => startCatalogEdition(c, '2026-27'))).rejects.toThrow(); // the label is taken
    const next = await w.as('alo', (c) => startCatalogEdition(c, '2027-28'));
    expect(next).toMatchObject({ label: '2027-28', status: 'working' });
    const list = await w.as('alo', (c) => listCatalogEditions(c));
    expect(list.editions.map((e) => [e.label, e.status])).toEqual([['2027-28', 'working'], ['2026-27', 'closed']]);
    expect(list.draft).toMatchObject({ nextVersionNo: 1, changes: [] });
    await w.as('alo', (c) => updateCourse(c, ids['MCE 301']!, { credits: 4 } as never));
    const v = await w.as('alo', (c) => publishCatalogVersion(c, {}));
    expect(v.versionNo).toBe(1);
    expect((await w.as('alo', (c) => getCatalogVersion(c, v.id))).changes.map((c) => c.text)).toEqual(['Credit hours: 3 → 4.']);
    await expect(q(`update catalog_edition set status = 'working' where label = '2026-27'`)).rejects.toThrow();
    await expect(q(`delete from catalog_edition where label = '2027-28'`)).rejects.toThrow(/cannot be deleted/);
  });
});

describe('the change list', () => {
  it('says nothing for equal snapshots and names a removed program and a changed prerequisite', async () => {
    const s = await w.as('alo', (c) => previewCatalogSnapshot(c));
    expect(diffSnapshots(s, s)).toEqual([]);
    const next = JSON.parse(JSON.stringify(s)) as typeof s;
    next.programs = []; next.courses[0]!.prerequisites = [['MCE 100', 'MCE 101'], ['PHY 100']];
    const text = diffSnapshots(s, next).map((c) => c.text);
    expect(text).toContain('BS Mechanical Engineering removed.');
    expect(text).toContain('Prerequisites: none → MCE 100 or MCE 101 and PHY 100.');
  });
});
