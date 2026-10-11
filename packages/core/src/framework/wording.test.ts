// A requirement whose wording sits in its title (with no description) is stored like the rest: wording as the
// description, code as the title. On import, when a version is copied, and (migration 0034) in existing drafts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, loadFixture, type World } from '../engagement/test-support.js';
import { importVersion, splitTitleAndText } from './exchange.js';
import { listRequirements, reviewRequirement } from './requirements.js';
import { newVersionFrom, publishVersion, submitForReview } from './versions.js';

let w: World;
const ids: Record<string, string> = {};
const WORDING = 'توضح رسالة المؤسسة الغرض من إنشائها وتتناسب مع احتياجات المجتمع وتطلعاته.';
beforeAll(async () => { w = await buildWorld('wordingsvc'); }, 120000);
afterAll(() => w.close());

const swapped = (edition: string) => {
  const file = structuredClone(loadFixture('puc-2019')) as { version: { edition: string }; requirements: { code: string; title: string; official_text: string | null }[] };
  file.version.edition = edition;
  const r = file.requirements.find((x) => x.code === '1-1-1')!;
  r.title = WORDING; r.official_text = null;
  return file;
};

describe('wording in a title', () => {
  it('is recognised by length or a closing full stop; headings stay titles', () => {
    expect(splitTitleAndText('1-1-1', WORDING, null)).toEqual({ title: '1-1-1', officialText: WORDING });
    expect(splitTitleAndText('2', 'Programs report every year.', '')).toEqual({ title: '2', officialText: 'Programs report every year.' });
    expect(splitTitleAndText('1-1', 'الرسالة والأهداف المؤسسية', null)).toEqual({ title: 'الرسالة والأهداف المؤسسية', officialText: null });
    expect(splitTitleAndText('C3', 'Student Outcomes', 'Existing text')).toEqual({ title: 'Student Outcomes', officialText: 'Existing text' });
  });

  it('moves to the description on import', async () => {
    const { version } = await w.as('admin', (c) => importVersion(c, swapped('2030')));
    const r = (await w.as('admin', (c) => listRequirements(c, version.id))).find((x) => x.code === '1-1-1')!;
    expect(r).toMatchObject({ title: '1-1-1', officialText: WORDING });
    expect((await w.as('admin', (c) => listRequirements(c, version.id))).find((x) => x.code === '1-1')!.title).toBe('الرسالة والأهداف المؤسسية');
  });

  it('moves to the description in a new version copied from a published one, which itself stays as it was', async () => {
    const { version } = await w.as('admin', (c) => importVersion(c, swapped('2031')));
    // Put the wording back in the title of the draft (as an older import or hand edits could have), then publish it.
    await w.db.su.query(`update requirement set title = $1, official_text = null where framework_version_id = $2 and code = '1-1-1'`, [WORDING, version.id]);
    for (const r of await w.as('admin', (c) => listRequirements(c, version.id))) await w.as('admin', (c) => reviewRequirement(c, r.id, 'approved'));
    await w.as('admin', (c) => submitForReview(c, version.id));
    await w.as('admin', (c) => publishVersion(c, version.id));
    const draft = (await w.as('admin', (c) => newVersionFrom(c, version.id, { edition: '2032' }))).version;
    expect((await w.as('admin', (c) => listRequirements(c, draft.id))).find((x) => x.code === '1-1-1')).toMatchObject({ title: '1-1-1', officialText: WORDING });
    expect((await w.as('admin', (c) => listRequirements(c, version.id))).find((x) => x.code === '1-1-1')!.title).toBe(WORDING);
    ids.published = version.id;
  });

  it('migration 0034 corrects drafts and leaves published versions alone', async () => {
    const { version } = await w.as('admin', (c) => importVersion(c, swapped('2033')));
    await w.db.su.query(`update requirement set title = $1, official_text = null where framework_version_id = $2 and code = '1-1-1'`, [WORDING, version.id]);
    const sql = readFileSync(resolve(import.meta.dirname, '../../../db/migrations/0034_requirement_wording_to_description.sql'), 'utf8');
    await w.db.su.query(sql); // runs again without error; published versions are not touched (they would refuse)
    const row = (await w.db.su.query(`select title, official_text from requirement where framework_version_id = $1 and code = '1-1-1'`, [version.id])).rows[0];
    expect(row).toEqual({ title: '1-1-1', official_text: WORDING });
    const pub = (await w.db.su.query(`select title from requirement where framework_version_id = $1 and code = '1-1-1'`, [ids.published])).rows[0];
    expect(pub.title).toBe(WORDING);
  });
});
