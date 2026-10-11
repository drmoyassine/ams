// F2: "Create from files", the source viewer's page+highlight service, the "needs a look" list, and merge/split. Real
// database (row-level security, the human-edit marker, the audit trigger, the published-version freeze).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createStandardFromFiles, MAX_FILES_PER_STANDARD, titleFromFileName } from './from-files.js';
import { listReviewItems } from './review-items.js';
import { mergeRequirement, splitRequirement } from './restructure.js';
import { listRequirements } from './requirements.js';
import { getSourcePageView } from './source-view.js';
import { MAX_SOURCE_BYTES } from './sources.js';

let w: World;
const ids: Record<string, string> = {};
const one = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows[0].id as string;
const rows = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any

const AR_PAGE = 'المعيار الأول\nيَجِبُ أَنْ تَكُونَ لِلْمُؤَسَّسَةِ رِسَالَةٌ مُعْلَنَةٌ وَمُعْتَمَدَةٌ.\nتُراجَعُ الرِّسَالَةُ كُلَّ سَنَةٍ.';
const EN_PAGE = 'Standard 2\nThe institution must publish its mission statement. It must also review the statement every year.';

async function addReq(code: string, o: { parent?: string | null; text?: string | null; origin?: 'ai' | 'manual'; doc?: string | null; page?: number | null; quote?: string | null; verified?: boolean; order?: number; version?: string } = {}) {
  return one(
    `insert into requirement (institution_id, framework_version_id, parent_id, code, level_label, title, official_text, origin, source_document_id, source_page, source_quote, quote_verified, display_order)
     values ($1,$2,$3,$4,'Standard',$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [ids.inst, o.version ?? ids.draft, o.parent ?? null, code, `Title ${code}`, o.text ?? null, o.origin ?? 'ai', o.doc ?? null, o.page ?? null, o.quote ?? null, o.verified ?? false, o.order ?? 0]);
}
async function addNote(req: string, text: string, o: { authority?: string; origin?: 'ai' | 'manual'; quote?: string | null; verified?: boolean } = {}) {
  return one(
    `insert into requirement_note (institution_id, requirement_id, type, text, authority, origin, source_document_id, source_page, source_quote, quote_verified)
     values ($1,$2,'guidance',$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ids.inst, req, text, o.authority ?? 'suggested', o.origin ?? 'ai', o.quote ? ids.doc : null, o.quote ? 1 : null, o.quote ?? null, o.verified ?? false]);
}

beforeAll(async () => {
  w = await buildWorld('reviewact');
  ids.inst = w.ids.inst!;
  ids.draft = await one(`insert into framework_version (institution_id, framework_id, edition) select $1, framework_id, '2031' from framework_version where id = $2 returning id`, [ids.inst, w.ids.wscuc!]);
  ids.doc = await one(`insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256) values ($1,$2,'Handbook','standards','binding','p',$3) returning id`, [ids.inst, ids.draft, 'a'.repeat(64)]);
  await w.db.su.query(`insert into source_page (institution_id, source_document_id, page_no, text, method) values ($1,$2,1,$3,'pdf_text'),($1,$2,2,$4,'pdf_text'),($1,$2,4,'Later page','pdf_text')`, [ids.inst, ids.doc, AR_PAGE, EN_PAGE]);
}, 120000);
afterAll(() => w.close());

describe('createStandardFromFiles', () => {
  const base = { name: 'Programme Standards', scope: 'program' as const, edition: '2027', files: [{ name: 'Handbook 2027.pdf', size: 1000 }, { name: 'دليل المعايير ٢٠٢٧.docx' }, { name: 'criteria.xlsx' }] };

  it('creates a new accreditor, the standard, a draft version and one unset source per file in one go', async () => {
    const r = await w.as('alo', (c) => createStandardFromFiles(c, { ...base, accreditor: { name: 'Gulf Programme Council', shortName: 'GPC' } }));
    expect(r.accreditor).toMatchObject({ shortName: 'GPC', created: true });
    expect(r.framework).toMatchObject({ name: 'Programme Standards', scope: 'program' });
    expect(r.version).toMatchObject({ edition: '2027', status: 'draft' });
    expect(r.documents.map((d) => d.title)).toEqual(['Handbook 2027', 'دليل المعايير ٢٠٢٧', 'criteria']);
    expect(r.documents.map((d) => d.fileName)).toEqual(['Handbook 2027.pdf', 'دليل المعايير ٢٠٢٧.docx', 'criteria.xlsx']);
    const docs = await rows(`select role, role_origin, file_name, authority from source_document where framework_version_id = $1`, [r.version.id]);
    expect(docs).toHaveLength(3);
    expect(docs.every((d) => d.role === 'other' && d.role_origin === 'unset' && d.file_name === null)).toBe(true); // "the analysis decides"; the file comes next
    expect((await rows(`select type from accreditor where short_name = 'GPC'`))[0]!.type).toBe('programmatic'); // from the scope
    ids.gpc = r.accreditor.id;
  });

  it('reuses an existing accreditor instead of creating another', async () => {
    const before = (await rows(`select count(*)::int as n from accreditor`))[0]!.n;
    const r = await w.as('alo', (c) => createStandardFromFiles(c, { ...base, name: 'Institutional Standards', scope: 'institution', accreditorId: ids.gpc!, files: [{ name: 'one.pdf' }] }));
    expect(r.accreditor).toMatchObject({ id: ids.gpc, created: false });
    expect((await rows(`select count(*)::int as n from accreditor`))[0]!.n).toBe(before);
    expect((await rows(`select count(*)::int as n from framework where accreditor_id = $1`, [ids.gpc]))[0]!.n).toBe(2);
  });

  it('refuses what is unclear before writing anything, and says why', async () => {
    const acc = { name: 'Another Council', shortName: 'ANC' };
    const bad = (over: object) => w.as('alo', (c) => createStandardFromFiles(c, { ...base, accreditor: acc, ...over } as never));
    await expect(bad({ files: [] })).rejects.toThrow(ValidationError);
    await expect(bad({ files: Array.from({ length: MAX_FILES_PER_STANDARD + 1 }, (_, i) => ({ name: `f${i}.pdf` })) })).rejects.toThrow(ValidationError);
    await expect(bad({ edition: ' ' })).rejects.toThrow(ValidationError);
    await expect(bad({ name: '' })).rejects.toThrow(ValidationError);
    await expect(bad({ accreditor: undefined })).rejects.toThrow(/existing accreditor or give a new one/);
    await expect(bad({ accreditorId: ids.gpc })).rejects.toThrow(/existing accreditor or give a new one/);
    await expect(bad({ files: [{ name: 'huge.pdf', size: MAX_SOURCE_BYTES + 1 }] })).rejects.toThrow(/huge\.pdf.*larger than/);
    await expect(w.as('alo', (c) => createStandardFromFiles(c, { ...base, accreditorId: crypto.randomUUID() }))).rejects.toThrow(NotFoundError);
    expect((await rows(`select count(*)::int as n from accreditor where short_name = 'ANC'`))[0]!.n).toBe(0);
  });

  it('refuses a taken short name or a standard name the accreditor already has, and leaves nothing behind', async () => {
    const accreditors = (await rows(`select count(*)::int as n from accreditor`))[0]!.n;
    await expect(w.as('alo', (c) => createStandardFromFiles(c, { ...base, accreditor: { name: 'Other', shortName: 'gpc' } }))).rejects.toThrow(/short name gpc already exists/);
    await expect(w.as('alo', (c) => createStandardFromFiles(c, { ...base, accreditorId: ids.gpc! }))).rejects.toThrow(ConflictError); // "Programme Standards" is there
    expect((await rows(`select count(*)::int as n from accreditor`))[0]!.n).toBe(accreditors);
  });

  it('is one transaction: if anything after it fails, the accreditor, standard, version and sources are all gone', async () => {
    await expect(w.as('alo', async (c) => {
      await createStandardFromFiles(c, { ...base, name: 'Rolled back', accreditor: { name: 'Ghost Council', shortName: 'GHOST' } });
      throw new Error('later step failed');
    })).rejects.toThrow('later step failed');
    expect((await rows(`select count(*)::int as n from accreditor where short_name = 'GHOST'`))[0]!.n).toBe(0);
    expect((await rows(`select count(*)::int as n from framework where name = 'Rolled back'`))[0]!.n).toBe(0);
  });

  it('needs framework:write', async () => {
    await expect(w.as('contrib', (c) => createStandardFromFiles(c, { ...base, name: 'X', accreditorId: ids.gpc! }))).rejects.toThrow(ForbiddenError);
  });

  it('names a source after its file: extension off, Arabic and spaces kept, folders ignored', () => {
    expect(titleFromFileName('C:\\docs\\Handbook v2.1.pdf')).toBe('Handbook v2.1');
    expect(titleFromFileName('دليل  المعايير.PDF')).toBe('دليل  المعايير');
    expect(titleFromFileName('noextension')).toBe('noextension');
    expect(titleFromFileName('.pdf')).toBe('.pdf');
  });
});

describe('getSourcePageView', () => {
  it('returns the page, the stored page numbers and the range of an Arabic quote written without diacritics', async () => {
    const v = await w.as('contrib', (c) => getSourcePageView(c, ids.doc!, 1, 'يجب أن تكون للمؤسسة رسالة معلنة ومعتمدة'));
    expect(v.document).toMatchObject({ title: 'Handbook', hasFile: false });
    expect(v.pageNos).toEqual([1, 2, 4]);
    expect(v.page?.text).toBe(AR_PAGE);
    expect(v.quoteGiven).toBe(true);
    const shown = v.page!.text.slice(v.highlight!.start, v.highlight!.end);
    expect(shown).toBe('يَجِبُ أَنْ تَكُونَ لِلْمُؤَسَّسَةِ رِسَالَةٌ مُعْلَنَةٌ وَمُعْتَمَدَةٌ');
    expect(v.quoteFoundOnPage).toBeNull();
  });

  it('marks an English quote on its page, and nothing on another page, pointing to where it is', async () => {
    const quote = 'must publish its mission statement';
    const on = await w.as('contrib', (c) => getSourcePageView(c, ids.doc!, 2, quote));
    expect(on.page!.text.slice(on.highlight!.start, on.highlight!.end)).toBe(quote);
    const other = await w.as('contrib', (c) => getSourcePageView(c, ids.doc!, 1, quote));
    expect(other.highlight).toBeNull();
    expect(other.page?.pageNo).toBe(1);
    expect(other.quoteFoundOnPage).toBe(2);
  });

  it('says nothing is marked when the quote is not found, or none is given, or the page has no text', async () => {
    const lost = await w.as('contrib', (c) => getSourcePageView(c, ids.doc!, 2, 'Graduates complete a capstone in year four.'));
    expect(lost).toMatchObject({ highlight: null, quoteFoundOnPage: null, quoteGiven: true });
    expect(lost.page?.text).toBe(EN_PAGE);
    const plain = await w.as('contrib', (c) => getSourcePageView(c, ids.doc!, 2));
    expect(plain).toMatchObject({ highlight: null, quoteGiven: false });
    const missing = await w.as('contrib', (c) => getSourcePageView(c, ids.doc!, 3, 'anything'));
    expect(missing.page).toBeNull();
    expect(missing.pageNos).toEqual([1, 2, 4]);
    await expect(w.as('contrib', (c) => getSourcePageView(c, ids.doc!, 0))).rejects.toThrow(ValidationError);
    await expect(w.as('contrib', (c) => getSourcePageView(c, crypto.randomUUID(), 1))).rejects.toThrow(NotFoundError);
  });

  it('is not readable from another institution', async () => {
    const other = await one(`insert into institution (name_en) values ('Elsewhere') returning id`);
    const u = await one(`insert into app_user (institution_id, full_name, email) values ($1,'o','o@else.org') returning id`, [other]);
    await w.db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1,$2,'admin','institution',$1)`, [other, u]);
    const { withIdentity } = await import('@ams/db');
    const caller = { userId: u, institutionId: other, requestId: crypto.randomUUID(), actorType: 'user' as const };
    await expect(withIdentity(w.pool, caller, (tx) => getSourcePageView({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined, store: w.store }, ids.doc!, 1))).rejects.toThrow(NotFoundError);
  });
});

describe('listReviewItems ("needs a look")', () => {
  it('lists quote not found, low confidence, orphans and suggested notes, and drops what a person has touched', async () => {
    const v = await one(`insert into framework_version (institution_id, framework_id, edition) select $1, framework_id, '2032' from framework_version where id = $2 returning id`, [ids.inst, w.ids.wscuc!]);
    const log = (kind: 'requirement' | 'note', item: object) => w.db.su.query(
      `insert into extraction_item (institution_id, framework_version_id, kind, payload) values ($1,$2,$3,$4)`, [ids.inst, v, kind, JSON.stringify({ item, documentId: ids.doc, seq: 0, window: 0 })]);
    const unverified = await addReq('U1', { version: v, doc: ids.doc!, page: 1, quote: 'not on the page', verified: false });
    const lowConf = await addReq('L1', { version: v });
    const orphan = await addReq('O1.1', { version: v });
    const fine = await addReq('F1', { version: v, doc: ids.doc!, page: 2, quote: 'must publish its mission statement', verified: true });
    const touched = await addReq('T1', { version: v });
    await log('requirement', { kind: 'requirement', temp_id: 'a', code: 'L1', text: 'x', source: { page: 1, quote: 'q' }, confidence: 0.3, flags: [] });
    await log('requirement', { kind: 'requirement', temp_id: 'b', code: 'O1.1', parent_code: 'O1', text: 'x', source: { page: 1, quote: 'q' }, confidence: 0.9, flags: [] });
    await log('requirement', { kind: 'requirement', temp_id: 'c', code: 'F1', text: 'x', source: { page: 1, quote: 'q' }, confidence: 0.9, flags: [] });
    await log('requirement', { kind: 'requirement', temp_id: 'd', code: 'T1', text: 'x', source: { page: 1, quote: 'q' }, confidence: 0.2, flags: [] });
    await w.db.su.query(`update requirement set edited_by_person = true where id = $1`, [touched]);
    const lowNote = await addNote(fine, 'Keep minutes of every board meeting held.');
    await log('note', { kind: 'note', temp_id: 'n', parent_code: 'F1', text: 'Keep minutes of every board meeting held.', source: { page: 1, quote: 'q' }, confidence: 0.4, flags: [] });
    const suggested = await addNote(fine, 'Consider a student survey.', { authority: 'ai_suggested' });
    const plainNote = await addNote(fine, 'A plain note.', { authority: 'example' });
    const badNote = await addNote(fine, 'Quoted wrongly.', { authority: 'example', quote: 'nowhere to be found', verified: false });

    const r = await w.as('contrib', (c) => listReviewItems(c, v));
    const byCode = new Map((await rows(`select id, code from requirement where framework_version_id = $1`, [v])).map((x) => [x.id as string, x.code as string]));
    expect(r.requirements.map((x) => [byCode.get(x.id), x.quoteNotFound, x.lowConfidence, x.orphan]).sort()).toEqual([
      ['L1', false, true, false], ['O1.1', false, false, true], ['U1', true, false, false],
    ]);
    expect(r.requirements.some((x) => x.id === fine || x.id === touched)).toBe(false);
    const flagged = new Map(r.notes.map((n) => [n.id, n]));
    expect(flagged.get(lowNote)).toMatchObject({ lowConfidence: true, suggested: false, quoteNotFound: false, requirementId: fine });
    expect(flagged.get(suggested)).toMatchObject({ suggested: true });
    expect(flagged.get(badNote)).toMatchObject({ quoteNotFound: true });
    expect(flagged.has(plainNote)).toBe(false);
    expect(unverified).toBeTruthy();
    expect(lowConf).toBeTruthy();
    expect(orphan).toBeTruthy();
  });

  it('is empty for a version with no requirements', async () => {
    const v = await one(`insert into framework_version (institution_id, framework_id, edition) select $1, framework_id, '2033' from framework_version where id = $2 returning id`, [ids.inst, w.ids.wscuc!]);
    expect(await w.as('contrib', (c) => listReviewItems(c, v))).toEqual({ requirements: [], notes: [] });
  });
});

describe('mergeRequirement', () => {
  async function scene(tag: string) {
    const v = ids.draft!;
    const target = await addReq(`${tag}-T`, { version: v, text: 'Target wording.', doc: ids.doc!, page: 2, quote: 'must publish its mission statement', verified: true });
    const merged = await addReq(`${tag}-M`, { version: v, text: 'Merged wording.', doc: ids.doc!, page: 1, quote: 'يجب أن تكون للمؤسسة رسالة معلنة', verified: true });
    const kids = [await addReq(`${tag}-M.1`, { version: v, parent: merged, order: 0 }), await addReq(`${tag}-M.2`, { version: v, parent: merged, order: 1 })];
    const own = await addReq(`${tag}-T.1`, { version: v, parent: target, order: 0 });
    const notes = [await addNote(merged, 'Note one'), await addNote(merged, 'Note two', { authority: 'example', origin: 'manual' })];
    const targetNote = await addNote(target, 'Target note');
    return { target, merged, kids, own, notes, targetNote };
  }

  it('moves the notes and children to the target, keeps the target\'s wording, removes the merged one, and marks all as edited by a person', async () => {
    const s = await scene('m1');
    const r = await w.as('alo', (c) => mergeRequirement(c, s.merged, { intoId: s.target }));
    expect(r).toMatchObject({ movedChildren: 2, movedNotes: 2, mappingsOnMergedCode: 0 });
    expect(r.requirement).toMatchObject({ id: s.target, officialText: 'Target wording.', title: 'Title m1-T', reviewStatus: 'pending' });
    expect(await rows(`select id from requirement where id = $1`, [s.merged])).toHaveLength(0);
    const kids = await rows(`select id, parent_id, display_order, edited_by_person from requirement where parent_id = $1 order by display_order`, [s.target]);
    expect(kids.map((k) => k.id)).toEqual([s.own, ...s.kids]); // after the target's own child, in their old order
    expect(kids.slice(1).every((k) => k.edited_by_person)).toBe(true);
    const notes = await rows(`select id, edited_by_person from requirement_note where requirement_id = $1`, [s.target]);
    expect(notes.map((n) => n.id).sort()).toEqual([...s.notes, s.targetNote].sort()); // no note lost
    expect(notes.filter((n) => [...s.notes].includes(n.id)).every((n) => n.edited_by_person)).toBe(true);
    expect((await rows(`select edited_by_person from requirement where id = $1`, [s.target]))[0]!.edited_by_person).toBe(true);
  });

  it('records the merge in the audit trail under the caller\'s name: the removed requirement whole, and every row that moved', async () => {
    const s = await scene('m2');
    await w.as('alo', (c) => mergeRequirement(c, s.merged, { intoId: s.target }));
    const del = await rows(`select actor_id, before from audit_event where target_type = 'requirement' and target_id = $1 and action = 'delete'`, [s.merged]);
    expect(del).toHaveLength(1);
    expect(del[0]!.actor_id).toBe(w.ids.alo);
    expect(del[0]!.before).toMatchObject({ code: 'm2-M', official_text: 'Merged wording.', source_page: 1 });
    const moved = await rows(`select after from audit_event where target_type = 'requirement_note' and action = 'update' and target_id = any($1)`, [s.notes]);
    expect(moved.map((m) => m.after.requirement_id)).toEqual([s.target, s.target]);
    expect((await rows(`select 1 from analysis_dismissal where code = 'm2-M' and kind = 'requirement'`))).toHaveLength(1); // the analysis will not add it back
  });

  it('takes the merged requirement\'s wording and source when asked', async () => {
    const s = await scene('m3');
    const r = await w.as('alo', (c) => mergeRequirement(c, s.merged, { intoId: s.target, useMergedWording: true }));
    expect(r.requirement).toMatchObject({ title: 'Title m3-M', officialText: 'Merged wording.', sourcePage: 1, quoteVerified: true });
  });

  it('refuses nonsense: itself, another version, its own descendant, a published version, no permission', async () => {
    const s = await scene('m4');
    await expect(w.as('alo', (c) => mergeRequirement(c, s.merged, { intoId: s.merged }))).rejects.toThrow(ValidationError);
    const elsewhere = (await w.as('alo', (c) => listRequirements(c, w.ids.puc!)))[0]!;
    await expect(w.as('alo', (c) => mergeRequirement(c, s.merged, { intoId: elsewhere.id }))).rejects.toThrow(/another version/);
    await expect(w.as('alo', (c) => mergeRequirement(c, s.merged, { intoId: s.kids[0]! }))).rejects.toThrow(/inside the requirement/);
    const [a, b] = (await w.as('alo', (c) => listRequirements(c, w.ids.wscuc!)));
    await expect(w.as('alo', (c) => mergeRequirement(c, a!.id, { intoId: b!.id }))).rejects.toThrow(/immutable/);
    await expect(w.as('contrib', (c) => mergeRequirement(c, s.merged, { intoId: s.target }))).rejects.toThrow(ForbiddenError);
    // nothing changed
    expect((await rows(`select count(*)::int as n from requirement where parent_id = $1`, [s.merged]))[0]!.n).toBe(2);
  });
});

describe('splitRequirement', () => {
  it('moves the chosen part into a new sibling, keeps both sourced, verifies the new quote, and marks the original as edited by a person', async () => {
    const parent = await addReq('s1', { text: null });
    const req = await addReq('s1.1', { parent, text: 'The institution must publish its mission statement. It must also review the statement every year.', doc: ids.doc!, page: 2, quote: 'must publish its mission statement', verified: true, order: 3 });
    const note = await addNote(req, 'Stays with the original');
    const child = await addReq('s1.1.a', { parent: req });
    const r = await w.as('alo', (c) => splitRequirement(c, req, { part: 'It must also review the statement every year.', code: 's1.2' }));
    expect(r.original).toMatchObject({ id: req, officialText: 'The institution must publish its mission statement.', parentId: parent, sourcePage: 2, sourceDocumentId: ids.doc });
    expect(r.created).toMatchObject({
      code: 's1.2', title: 's1.2', officialText: 'It must also review the statement every year.', parentId: parent, levelLabel: 'Standard', origin: 'manual',
      sourceDocumentId: ids.doc, sourcePage: 2, sourceQuote: 'It must also review the statement every year.', quoteVerified: true, displayOrder: 4,
    });
    expect((await rows(`select edited_by_person from requirement where id = $1`, [req]))[0]!.edited_by_person).toBe(true);
    expect((await rows(`select requirement_id from requirement_note where id = $1`, [note]))[0]!.requirement_id).toBe(req); // notes and children stay
    expect((await rows(`select parent_id from requirement where id = $1`, [child]))[0]!.parent_id).toBe(req);
    // nothing of the wording is lost between the two
    expect(`${r.original.officialText} ${r.created.officialText}`).toBe(EN_PAGE.split('\n')[1]);
    // the audit trail has the insert of the new one and the update of the original (with the old wording)
    expect(await rows(`select 1 from audit_event where target_type = 'requirement' and target_id = $1 and action = 'insert'`, [r.created.id])).toHaveLength(1);
    const upd = await rows(`select before from audit_event where target_type = 'requirement' and target_id = $1 and action = 'update' order by at desc limit 1`, [req]);
    expect(upd[0]!.before.official_text).toMatch(/review the statement every year/);
  });

  it('verifies an Arabic part against the page with diacritics, and flags a part that is not in the source', async () => {
    const req = await addReq('s2', { text: 'يجب أن تكون للمؤسسة رسالة معلنة ومعتمدة. وتراجع الرسالة كل سنة.', doc: ids.doc!, page: 1, quote: 'يجب أن تكون للمؤسسة رسالة معلنة', verified: true });
    const ok = await w.as('alo', (c) => splitRequirement(c, req, { part: 'وتراجع الرسالة كل سنة.', code: 's2b', title: 'مراجعة الرسالة' }));
    expect(ok.created).toMatchObject({ title: 'مراجعة الرسالة', quoteVerified: true, sourcePage: 1 });
    expect(ok.original.officialText).toBe('يجب أن تكون للمؤسسة رسالة معلنة ومعتمدة.');
    const req2 = await addReq('s3', { text: 'Alpha clause. A clause somebody typed in by hand.', doc: ids.doc!, page: 2, quote: 'must publish its mission statement', verified: true });
    const lost = await w.as('alo', (c) => splitRequirement(c, req2, { part: 'A clause somebody typed in by hand.', code: 's3b' }));
    expect(lost.created).toMatchObject({ quoteVerified: false, sourceQuote: 'A clause somebody typed in by hand.' }); // says so, and is not trusted
  });

  it('refuses a part that is not in the text, the whole text, a used code, a published version, no permission', async () => {
    const req = await addReq('s4', { text: 'First half. Second half.' });
    const split = (over: object, who = 'alo') => w.as(who, (c) => splitRequirement(c, req, { part: 'Second half.', code: 's4b', ...over }));
    await expect(split({ part: 'Third half.' })).rejects.toThrow(/not in the requirement/);
    await expect(split({ part: 'First half. Second half.' })).rejects.toThrow(/left empty/);
    await expect(split({ code: 's4' })).rejects.toThrow(/already used/);
    await expect(split({ code: ' ' })).rejects.toThrow(ValidationError);
    await expect(split({}, 'contrib')).rejects.toThrow(ForbiddenError);
    const pub = (await w.as('alo', (c) => listRequirements(c, w.ids.wscuc!))).find((r) => r.officialText)!;
    await expect(w.as('alo', (c) => splitRequirement(c, pub.id, { part: pub.officialText!.slice(0, 5), code: 'zz' }))).rejects.toThrow(/immutable/);
    expect((await rows(`select official_text from requirement where id = $1`, [req]))[0]!.official_text).toBe('First half. Second half.');
  });
});
