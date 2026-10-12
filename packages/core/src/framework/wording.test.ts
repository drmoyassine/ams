// An external standard's statement (an indicator, a criterion) is the item's title; a title that is only its code is
// replaced by the statement. Longer text stays in the description. On import, when a version is copied, and (migration
// 0047) in existing drafts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, loadFixture, type World } from '../engagement/test-support.js';
import { importVersion, placeWording } from './exchange.js';
import { listRequirements, reviewRequirement } from './requirements.js';
import { newVersionFrom, publishVersion, submitForReview } from './versions.js';

let w: World;
const ids: Record<string, string> = {};
const WORDING = 'توضح رسالة المؤسسة الغرض من إنشائها وتتناسب مع احتياجات المجتمع وتطلعاتها.';
beforeAll(async () => { w = await buildWorld('wordingsvc'); }, 120000);
afterAll(() => w.close());

const withCodeTitle = (edition: string) => {
  const file = structuredClone(loadFixture('puc-2019')) as { version: { edition: string }; requirements: { code: string; title: string; official_text: string | null }[] };
  file.version.edition = edition;
  const r = file.requirements.find((x) => x.code === '1-1-1')!;
  r.title = '1-1-1'; r.official_text = WORDING; // how the demo data stores an indicator
  return file;
};
const row = async (versionId: string, code: string) => (await w.as('admin', (c) => listRequirements(c, versionId))).find((x) => x.code === code)!;

describe('the statement is the title', () => {
  it('replaces a title that is only the code; a heading, an existing description or a long text stay as they are', () => {
    expect(placeWording('1-1-1', '1-1-1', WORDING)).toEqual({ title: WORDING, officialText: null });
    expect(placeWording('1-1-1', ' 1-1-1 ', `  ${WORDING} `)).toEqual({ title: WORDING, officialText: null });
    expect(placeWording('1-1', 'الرسالة والأهداف المؤسسية', null)).toEqual({ title: 'الرسالة والأهداف المؤسسية', officialText: null });
    expect(placeWording('C3', 'Student Outcomes', 'Existing text')).toEqual({ title: 'Student Outcomes', officialText: 'Existing text' });
    const long = 'x'.repeat(301);
    expect(placeWording('2', '2', long)).toEqual({ title: '2', officialText: long }); // too long for a title: stays the description
    expect(placeWording('2', long, null)).toEqual({ title: '2', officialText: long }); // a long statement in the title moves to the description
  });

  it('applies on import', async () => {
    const { version } = await w.as('admin', (c) => importVersion(c, withCodeTitle('2040')));
    expect(await row(version.id, '1-1-1')).toMatchObject({ title: WORDING, officialText: null });
    expect((await row(version.id, '1-1')).title).toBe('الرسالة والأهداف المؤسسية');
  });

  it('applies in a new version copied from a published one, which itself stays as it was', async () => {
    const { version } = await w.as('admin', (c) => importVersion(c, withCodeTitle('2041')));
    // Store it the old way (code as the title) in the draft, then publish it.
    await w.db.su.query(`update requirement set title = '1-1-1', official_text = $1 where framework_version_id = $2 and code = '1-1-1'`, [WORDING, version.id]);
    for (const r of await w.as('admin', (c) => listRequirements(c, version.id))) await w.as('admin', (c) => reviewRequirement(c, r.id, 'approved'));
    await w.as('admin', (c) => submitForReview(c, version.id));
    await w.as('admin', (c) => publishVersion(c, version.id));
    const draft = (await w.as('admin', (c) => newVersionFrom(c, version.id, { edition: '2042' }))).version;
    expect(await row(draft.id, '1-1-1')).toMatchObject({ title: WORDING, officialText: null });
    expect((await row(version.id, '1-1-1')).title).toBe('1-1-1');
    ids.published = version.id;
  });

  it('migration 0047 corrects drafts and leaves published versions alone', async () => {
    const { version } = await w.as('admin', (c) => importVersion(c, withCodeTitle('2043')));
    await w.db.su.query(`update requirement set title = '1-1-1', official_text = $1 where framework_version_id = $2 and code = '1-1-1'`, [WORDING, version.id]);
    const sql = readFileSync(resolve(import.meta.dirname, '../../../db/migrations/0047_requirement_statement_as_title.sql'), 'utf8');
    await w.db.su.query(sql); // runs again without error; published versions are not touched (they would refuse)
    const r = (await w.db.su.query(`select title, official_text from requirement where framework_version_id = $1 and code = '1-1-1'`, [version.id])).rows[0];
    expect(r).toEqual({ title: WORDING, official_text: null });
    const pub = (await w.db.su.query(`select title from requirement where framework_version_id = $1 and code = '1-1-1'`, [ids.published])).rows[0];
    expect(pub.title).toBe('1-1-1');
  });
});
