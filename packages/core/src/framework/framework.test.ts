import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { ConflictError, ForbiddenError, ValidationError, type Ctx } from '../index.js';
import {
  addNote, addSourceDocument, addSourcePage, createAccreditor, createFramework, createRequirement, createVersion, deleteNote,
  deleteRequirement, getRequirementWithNotes, listRequirements, moveRequirement, newVersionFrom, normalizeForQuote, publishVersion, quoteInText,
  retireVersion, returnToDraft, reviewNote, reviewReportTemplate, reviewRequirement, setNoteAuthority, submitForReview,
  updateNote, updateRequirement, updateVersionConfig, upsertReportTemplate, validateVersion,
} from './index.js';

let db: TestDb;
let pool: pg.Pool;
const ids = {} as Record<string, string>;
const noQueue = { send: async () => undefined };

async function one(sql: string, params: unknown[] = []) {
  return (await db.su.query(sql, params)).rows[0].id as string;
}
type Who = 'admin' | 'lead' | 'reviewer' | 'viewer';
const run = <T>(who: Who, fn: (ctx: Ctx) => Promise<T>, actorType: 'user' | 'ai' = 'user'): Promise<T> => {
  const caller = { userId: ids[who]!, institutionId: ids.inst!, requestId: crypto.randomUUID(), actorType };
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: noQueue, afterCommit: () => undefined }));
};

const config = (): Parameters<typeof updateVersionConfig>[2] => ({
  levelLabels: ['Standard', 'CFR'],
  lifecycleTemplate: { phases: [
    { type: 'self_study', name: 'Self-study', applies_to: ['reaffirmation'], milestones: [
      { key: 'submit', name: 'Submit report', type: 'submission', deliverable: { report_template_key: 'report' }, due: { anchor: 'submission_date', offset_days: 0 } },
    ] },
  ] },
  decisionVocab: [{ code: 'ok', label: 'Accredited', outcome: 'accredited' }],
  findingVocab: [{ code: 'rec', label: 'Recommendation', requires_action: true }],
  responseVocab: [{ code: 'letter', label: 'Action letter', is_decision: true }],
});
const template = () => ({ key: 'report', name: 'Self-study', kind: 'self_study' as const, structure: { sections: [{ key: 'A', title: 'Intro', block_type: 'narrative' as const }] } });

/** A draft version with one standard, one CFR, a document with one page, and valid configuration. */
async function draft(edition: string) {
  const v = await run('lead', (c) => createVersion(c, { frameworkId: ids.fw!, edition }));
  await run('lead', (c) => updateVersionConfig(c, v.id, config()));
  await run('lead', (c) => upsertReportTemplate(c, v.id, template()));
  const std = await run('lead', (c) => createRequirement(c, { versionId: v.id, code: 'Standard 1', levelLabel: 'Standard', title: 'Purposes' }));
  const cfr = await run('lead', (c) => createRequirement(c, { versionId: v.id, parentId: std.id, code: 'CFR 1.1', levelLabel: 'CFR', title: 'Mission', officialText: 'The institution has a mission.' }));
  const doc = await run('lead', (c) => addSourceDocument(c, { versionId: v.id, title: 'Handbook', role: 'standards', authority: 'binding', filePath: 'h.pdf', sha256: 'a'.repeat(64) }));
  await run('lead', (c) => addSourcePage(c, { documentId: doc.id, pageNo: 12, method: 'pdf_text', text: 'Institutions are required to complete the Compliance with Standards Worksheet before the visit.' }));
  return { v, std, cfr, doc };
}
async function approveAll(x: Awaited<ReturnType<typeof draft>>) {
  for (const r of [x.std, x.cfr]) await run('reviewer', (c) => reviewRequirement(c, r.id, 'approved'));
  await run('reviewer', (c) => reviewReportTemplate(c, x.v.id, 'report', 'approved'));
}

beforeAll(async () => {
  db = await createTestDb('fwcore');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [who, role] of [['admin', 'admin'], ['lead', 'lead'], ['reviewer', 'reviewer'], ['viewer', 'viewer']] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[who], role]);
  }
  const acc = await run('lead', (c) => createAccreditor(c, { name: 'Western Commission', shortName: 'WSCUC', type: 'institutional' }));
  const fw = await run('lead', (c) => createFramework(c, { accreditorId: acc.id, name: 'Handbook', scope: 'institution' }));
  ids.fw = fw.id;
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('quote verification', () => {
  it('matches despite whitespace, case, quotes, dashes and hyphenation', () => {
    const page = 'The institution’s  “mission” is\nre-\nviewed — annually.';
    expect(quoteInText('institution\'s "mission" is reviewed - annually', page)).toBe(true);
  });
  it('matches Arabic regardless of diacritics, tatweel and zero-width marks', () => {
    const page = 'يجب أن تكـون المؤسسةُ مُرخَّصة‏.';
    expect(quoteInText('تكون المؤسسة مرخصة', page)).toBe(true);
    // Taa marbuta and haa are folded together (step C's normalisation), so either spelling matches.
    expect(normalizeForQuote('المؤسسة')).toBe(normalizeForQuote('المؤسسه'));
  });
  it('does not match text that is not there, or an empty quote', () => {
    expect(quoteInText('a different sentence', 'The institution has a mission.')).toBe(false);
    expect(quoteInText('   ', 'anything')).toBe(false);
  });
});

describe('permissions', () => {
  it('viewers read but cannot write; leads write but cannot publish; reviewers review', async () => {
    const x = await draft('perm');
    await expect(run('viewer', (c) => listRequirements(c, x.v.id))).resolves.toHaveLength(2);
    await expect(run('viewer', (c) => createRequirement(c, { versionId: x.v.id, code: 'X', levelLabel: 'Standard', title: 'x' }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run('reviewer', (c) => createRequirement(c, { versionId: x.v.id, code: 'X', levelLabel: 'Standard', title: 'x' }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run('lead', (c) => reviewRequirement(c, x.cfr.id, 'approved'))).resolves.toBeTruthy(); // leads may review too
    await expect(run('viewer', (c) => reviewRequirement(c, x.cfr.id, 'approved'))).rejects.toBeInstanceOf(ForbiddenError);
    await run('lead', (c) => submitForReview(c, x.v.id)).catch(() => undefined);
    await expect(run('lead', (c) => publishVersion(c, x.v.id))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('requirement tree', () => {
  it('lists parents before children with depth, ordered by display order then code', async () => {
    const x = await draft('tree');
    await run('lead', (c) => createRequirement(c, { versionId: x.v.id, parentId: x.std.id, code: 'CFR 1.0', levelLabel: 'CFR', title: 'First', displayOrder: -1 }));
    const rows = await run('lead', (c) => listRequirements(c, x.v.id));
    expect(rows.map((r) => [r.code, r.depth])).toEqual([['Standard 1', 0], ['CFR 1.0', 1], ['CFR 1.1', 1]]);
  });

  it('rejects a duplicate code and a parent from another version', async () => {
    const x = await draft('tree-dup');
    const y = await draft('tree-dup2');
    await expect(run('lead', (c) => createRequirement(c, { versionId: x.v.id, code: 'CFR 1.1', levelLabel: 'CFR', title: 'dup' }))).rejects.toBeInstanceOf(ConflictError);
    await expect(run('lead', (c) => createRequirement(c, { versionId: x.v.id, parentId: y.std.id, code: 'CFR 9', levelLabel: 'CFR', title: 'x' }))).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses to move a node under itself or its descendant, and allows a valid move', async () => {
    const x = await draft('tree-move');
    await expect(run('lead', (c) => moveRequirement(c, x.std.id, x.cfr.id))).rejects.toThrow(/under itself or its own descendant/);
    await expect(run('lead', (c) => moveRequirement(c, x.std.id, x.std.id))).rejects.toThrow(/under itself or its own descendant/);
    const other = await run('lead', (c) => createRequirement(c, { versionId: x.v.id, code: 'Standard 2', levelLabel: 'Standard', title: 'Other' }));
    const moved = await run('lead', (c) => moveRequirement(c, x.cfr.id, other.id));
    expect(moved.parentId).toBe(other.id);
  });

  it('deletes only leaves (with their notes)', async () => {
    const x = await draft('tree-del');
    await expect(run('lead', (c) => deleteRequirement(c, x.std.id))).rejects.toThrow(/child requirements/);
    await run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'guidance', text: 'g', authority: 'suggested' }));
    await run('lead', (c) => deleteRequirement(c, x.cfr.id));
    expect(await run('lead', (c) => listRequirements(c, x.v.id))).toHaveLength(1);
  });

  it('sends an approved requirement back to review when it is edited', async () => {
    const x = await draft('tree-edit');
    const approved = await run('reviewer', (c) => reviewRequirement(c, x.cfr.id, 'approved'));
    expect(approved).toMatchObject({ reviewStatus: 'approved', reviewedBy: ids.reviewer });
    const edited = await run('lead', (c) => updateRequirement(c, x.cfr.id, { officialText: 'Changed.' }));
    expect(edited).toMatchObject({ reviewStatus: 'pending', reviewedBy: null, reviewedAt: null, officialText: 'Changed.' });
  });

  it('rejects invalid applicability tags', async () => {
    const x = await draft('tree-applies');
    await expect(run('lead', (c) => updateRequirement(c, x.cfr.id, { appliesWhen: { colour: ['red'] } as never }))).rejects.toThrow();
  });
});

describe('notes and authority', () => {
  const src = (x: Awaited<ReturnType<typeof draft>>, quote: string, page = 12) => ({ documentId: x.doc.id, page, quote });

  it('verifies a required note against the stored page text', async () => {
    const x = await draft('notes-ok');
    const n = await run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'evidence_expectation', text: 'Complete the worksheet.', authority: 'required', source: src(x, 'required to complete the compliance with standards worksheet') }));
    expect(n).toMatchObject({ authority: 'required', quoteVerified: true, origin: 'manual', reviewStatus: 'pending' });
  });

  it('stores an unverifiable quote as unverified rather than trusting it', async () => {
    const x = await draft('notes-bad');
    const wrongText = await run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'guidance', text: 't', authority: 'required', source: src(x, 'a sentence that is not there') }));
    const wrongPage = await run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'guidance', text: 't', authority: 'required', source: src(x, 'required to complete', 99) }));
    expect(wrongText.quoteVerified).toBe(false);
    expect(wrongPage.quoteVerified).toBe(false);
    await expect(run('reviewer', (c) => reviewNote(c, wrongText.id, 'approved'))).rejects.toThrow(/verified quote/);
  });

  it('needs a citation for required notes, and never lets a person create ai_suggested', async () => {
    const x = await draft('notes-rules');
    await expect(run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'guidance', text: 't', authority: 'required' }))).rejects.toBeInstanceOf(ValidationError);
    await expect(run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'guidance', text: 't', authority: 'ai_suggested' as never }))).rejects.toThrow();
    await expect(run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'guidance', text: 't', authority: 'institution_defined' }))).resolves.toMatchObject({ authority: 'institution_defined' });
  });

  it('refuses every write by an AI identity', async () => {
    const x = await draft('notes-ai');
    await expect(run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'guidance', text: 't', authority: 'example' }), 'ai')).rejects.toThrow(/only a signed-in person/);
    await expect(run('reviewer', (c) => reviewRequirement(c, x.cfr.id, 'approved'), 'ai')).rejects.toThrow(/only a signed-in person/);
  });

  it('promotes an AI-suggested note only by a person, and `required` only with a verified quote', async () => {
    const x = await draft('notes-promote');
    // The worker role is the only author of ai_suggested notes; simulate its row.
    const aiNote = await one(
      `insert into requirement_note (institution_id, requirement_id, type, text, authority, origin, source_document_id, source_page, source_quote)
       values ($1, $2, 'guidance', 'inferred', 'ai_suggested', 'ai', $3, 12, 'the Compliance with Standards Worksheet') returning id`, [ids.inst, x.cfr.id, x.doc.id]);
    await expect(run('lead', (c) => setNoteAuthority(c, aiNote, 'required'), 'ai')).rejects.toThrow(/only a signed-in person/);
    const promoted = await run('lead', (c) => setNoteAuthority(c, aiNote, 'required'));
    expect(promoted.authority).toBe('required');
    const unsourced = await one(`insert into requirement_note (institution_id, requirement_id, type, text, authority, origin) values ($1, $2, 'guidance', 'x', 'ai_suggested', 'ai') returning id`, [ids.inst, x.cfr.id]);
    await expect(run('lead', (c) => setNoteAuthority(c, unsourced, 'required'))).rejects.toThrow(/found on its cited source page/);
    await expect(run('lead', (c) => setNoteAuthority(c, unsourced, 'suggested'))).resolves.toMatchObject({ authority: 'suggested' });
  });

  it('editing a note re-verifies its quote and returns it to review', async () => {
    const x = await draft('notes-edit');
    const n = await run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'guidance', text: 't', authority: 'required', source: src(x, 'required to complete') }));
    await run('reviewer', (c) => reviewNote(c, n.id, 'approved'));
    const edited = await run('lead', (c) => updateNote(c, n.id, { source: src(x, 'a sentence that is not there') }));
    expect(edited).toMatchObject({ quoteVerified: false, reviewStatus: 'pending' });
    await run('lead', (c) => deleteNote(c, n.id));
    expect((await run('lead', (c) => getRequirementWithNotes(c, x.cfr.id))).notes).toHaveLength(0);
  });
});

describe('report templates and configuration', () => {
  it('rejects an invalid template with paths, and replaces by key', async () => {
    const x = await draft('tpl');
    await expect(run('lead', (c) => upsertReportTemplate(c, x.v.id, { ...template(), structure: { sections: [{ key: 'T', title: 'T', block_type: 'data_table' }] } } as never)))
      .rejects.toMatchObject({ issues: [expect.objectContaining({ message: expect.stringContaining('data_table needs columns') })] });
    const replaced = await run('lead', (c) => upsertReportTemplate(c, x.v.id, { ...template(), name: 'Renamed' }));
    expect(replaced).toMatchObject({ name: 'Renamed', reviewStatus: 'pending' });
  });

  it('rejects invalid configuration fields with their paths', async () => {
    const x = await draft('cfg');
    await expect(run('lead', (c) => updateVersionConfig(c, x.v.id, { levelLabels: [] }))).rejects.toBeInstanceOf(ValidationError);
    await expect(run('lead', (c) => updateVersionConfig(c, x.v.id, { lifecycleTemplate: { phases: [] } } as never))).rejects.toBeInstanceOf(ValidationError);
  });

  it('cross-validates references before review', async () => {
    const v = await run('lead', (c) => createVersion(c, { frameworkId: ids.fw!, edition: 'cfg-xref' }));
    await run('lead', (c) => updateVersionConfig(c, v.id, config()));
    // The lifecycle delivers template "report", which does not exist yet.
    const result = await run('lead', (c) => validateVersion(c, v.id));
    expect(result.ok).toBe(false);
    await expect(run('lead', (c) => submitForReview(c, v.id))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('version lifecycle', () => {
  it('draft -> in_review -> published, then everything is immutable', async () => {
    const x = await draft('2023');
    await run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'evidence_expectation', text: 'Worksheet', authority: 'required', source: { documentId: x.doc.id, page: 12, quote: 'required to complete the Compliance' } }));
    const note = (await run('lead', (c) => getRequirementWithNotes(c, x.cfr.id))).notes[0]!;
    await approveAll(x);
    await run('reviewer', (c) => reviewNote(c, note.id, 'approved'));

    expect((await run('lead', (c) => submitForReview(c, x.v.id))).status).toBe('in_review');
    const published = await run('admin', (c) => publishVersion(c, x.v.id));
    expect(published).toMatchObject({ status: 'published', publishedBy: ids.admin });
    expect(published.publishedAt).toBeInstanceOf(Date);

    const frozen = /immutable/;
    await expect(run('lead', (c) => updateRequirement(c, x.cfr.id, { title: 'x' }))).rejects.toThrow(frozen);
    await expect(run('lead', (c) => createRequirement(c, { versionId: x.v.id, code: 'N', levelLabel: 'CFR', title: 'x' }))).rejects.toThrow(frozen);
    await expect(run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'guidance', text: 'x', authority: 'suggested' }))).rejects.toThrow(frozen);
    await expect(run('lead', (c) => upsertReportTemplate(c, x.v.id, template()))).rejects.toThrow(frozen);
    await expect(run('lead', (c) => updateVersionConfig(c, x.v.id, { changeSummary: 'x' }))).rejects.toThrow(frozen);
    await expect(run('lead', (c) => returnToDraft(c, x.v.id))).rejects.toBeInstanceOf(ConflictError);
  });

  it('reports the database publish gate as a conflict naming the rule', async () => {
    const x = await draft('gate');
    await run('reviewer', (c) => reviewRequirement(c, x.std.id, 'approved'));
    await run('reviewer', (c) => reviewReportTemplate(c, x.v.id, 'report', 'approved'));
    // CFR 1.1 is still pending review.
    await run('lead', (c) => submitForReview(c, x.v.id));
    await expect(run('admin', (c) => publishVersion(c, x.v.id))).rejects.toThrow(/publish gate: 1 requirement\(s\) are not approved/);
  });

  it('cannot publish without being in review, or an empty version', async () => {
    const x = await draft('not-in-review');
    await expect(run('admin', (c) => publishVersion(c, x.v.id))).rejects.toThrow(/only a version in review/);
    const empty = await run('lead', (c) => createVersion(c, { frameworkId: ids.fw!, edition: 'empty' }));
    await run('lead', (c) => updateVersionConfig(c, empty.id, config()));
    await run('lead', (c) => upsertReportTemplate(c, empty.id, template()));
    await expect(run('lead', (c) => submitForReview(c, empty.id))).rejects.toThrow(/at least one requirement/);
  });

  it('a new version copies a published one into an editable draft that supersedes it', async () => {
    const x = await draft('2024');
    await run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'guidance', text: 'g', authority: 'suggested' }));
    const note = (await run('lead', (c) => getRequirementWithNotes(c, x.cfr.id))).notes[0]!;
    await approveAll(x);
    await run('reviewer', (c) => reviewNote(c, note.id, 'approved'));
    await run('lead', (c) => submitForReview(c, x.v.id));
    await run('admin', (c) => publishVersion(c, x.v.id));

    const next = await run('lead', (c) => newVersionFrom(c, x.v.id, { edition: '2025', changeSummary: 'Updated CFR 1.1' }));
    expect(next.requirementsCopied).toBe(2);
    expect(next.version).toMatchObject({ status: 'draft', supersedesId: x.v.id, changeSummary: 'Updated CFR 1.1' });

    const copied = await run('lead', (c) => listRequirements(c, next.version.id));
    expect(copied.map((r) => [r.code, r.depth, r.reviewStatus])).toEqual([['Standard 1', 0, 'approved'], ['CFR 1.1', 1, 'approved']]);
    expect(copied[1]!.parentId).toBe(copied[0]!.id); // parent remapped to the copy
    const copiedNotes = await run('lead', (c) => getRequirementWithNotes(c, copied[1]!.id));
    expect(copiedNotes.notes).toHaveLength(1);

    // The copy is editable; the original is untouched.
    const edited = await run('lead', (c) => updateRequirement(c, copied[1]!.id, { officialText: 'Revised wording.' }));
    expect(edited.reviewStatus).toBe('pending');
    const original = await run('lead', (c) => listRequirements(c, x.v.id));
    expect(original[1]).toMatchObject({ officialText: 'The institution has a mission.', reviewStatus: 'approved' });
  });

  it('retires a published version, after which nothing moves', async () => {
    const x = await draft('2020');
    await approveAll(x);
    await run('lead', (c) => submitForReview(c, x.v.id));
    await run('admin', (c) => publishVersion(c, x.v.id));
    await expect(run('lead', (c) => retireVersion(c, x.v.id))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await run('admin', (c) => retireVersion(c, x.v.id))).status).toBe('retired');
    await expect(run('admin', (c) => retireVersion(c, x.v.id))).rejects.toBeInstanceOf(ConflictError);
    await expect(run('lead', (c) => updateRequirement(c, x.cfr.id, { title: 'x' }))).rejects.toThrow(/retired and immutable/);
  });
});
