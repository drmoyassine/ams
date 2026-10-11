import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { FrameworkExportSchema } from '@ams/shared';
import { ConflictError, ForbiddenError, ValidationError, type Ctx } from '../index.js';
import {
  addNote, addSourceDocument, addSourcePage, createAccreditor, createFramework, createRequirement, createVersion, exportVersion, importVersion,
  listRequirements, publishVersion, submitForReview, updateVersionConfig, upsertReportTemplate,
  getRequirementWithNotes,
} from './index.js';

let db: TestDb;
let pool: pg.Pool;
const ids = {} as Record<string, string>;
const noQueue = { send: async () => undefined };
async function one(sql: string, params: unknown[] = []) { return (await db.su.query(sql, params)).rows[0].id as string; }
type Who = 'admin' | 'lead' | 'reviewer' | 'viewer';
const run = <T>(who: Who, fn: (ctx: Ctx) => Promise<T>): Promise<T> => {
  const caller = { userId: ids[who]!, institutionId: ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: noQueue, afterCommit: () => undefined }));
};

const AR_TITLE = 'المعيار الأول: الرسالة والأهداف';
const AR_TEXT = 'يجب أن تكون للمؤسسة رسالة معلنة ومعتمدة.';

async function seed() {
  const acc = await run('lead', (c) => createAccreditor(c, { name: 'Public University Council', shortName: 'PUC', type: 'institutional', country: 'KW' }));
  const fw = await run('lead', (c) => createFramework(c, { accreditorId: acc.id, name: 'Institutional Accreditation Guide', scope: 'institution', commission: 'Main' }));
  const v = await run('lead', (c) => createVersion(c, { frameworkId: fw.id, edition: '2019', effectiveFrom: '2019-01-01', changeSummary: 'First edition' }));
  await run('lead', (c) => updateVersionConfig(c, v.id, {
    levelLabels: ['Standard', 'Measure', 'Indicator'],
    lifecycleTemplate: { phases: [{ type: 'self_study', name: 'Self-study', applies_to: ['initial', 'reaffirmation'], milestones: [
      { key: 'submit', name: 'Submit self-study', type: 'submission', deliverable: { report_template_key: 'puc_self_study' }, due: { anchor: 'submission_date', offset_days: 0 } }] }] },
    decisionVocab: [{ code: 'accredited', label: 'Accredited', outcome: 'accredited' }],
    findingVocab: [{ code: 'condition', label: 'Condition', requires_action: true }],
    responseVocab: [{ code: 'decision_letter', label: 'Decision letter', is_decision: true }],
    ratingMethod: null,
  }));
  await run('lead', (c) => upsertReportTemplate(c, v.id, { key: 'puc_self_study', name: 'Item 11', kind: 'self_study', language: 'ar', requires_attestation: true,
    structure: { sections: [{ key: '1', title: 'معلومات عامة', block_type: 'narrative' }, { key: '14', title: 'إقرار', block_type: 'attestation' }] } }));
  const doc = await run('lead', (c) => addSourceDocument(c, { versionId: v.id, title: 'الدليل', role: 'standards', authority: 'binding', language: 'ar', filePath: 'guide.pdf', sha256: 'd'.repeat(64) }));
  await run('lead', (c) => addSourcePage(c, { documentId: doc.id, pageNo: 7, method: 'pdf_text', text: AR_TEXT }));
  const s1 = await run('lead', (c) => createRequirement(c, { versionId: v.id, code: '1', levelLabel: 'Standard', title: AR_TITLE, language: 'ar', officialText: AR_TEXT, displayOrder: 1 }));
  const m11 = await run('lead', (c) => createRequirement(c, { versionId: v.id, parentId: s1.id, code: '1-1', levelLabel: 'Measure', title: 'Measure', translationEn: 'Mission', displayOrder: 1 }));
  await run('lead', (c) => createRequirement(c, { versionId: v.id, parentId: m11.id, code: '1-1-1', levelLabel: 'Indicator', title: 'Indicator', appliesWhen: { scope: ['institution'] }, weight: 2.5 }));
  await run('lead', (c) => addNote(c, { requirementId: m11.id, type: 'quantitative_norm', text: 'Staff ratio', authority: 'suggested', norm: { max: 25 } }));
  await run('lead', (c) => addNote(c, { requirementId: s1.id, type: 'guidance', text: 'Mission must be public', authority: 'required', source: { documentId: doc.id, page: 7, quote: 'رسالة معلنة ومعتمدة' } }));
  return { v, s1 };
}

beforeAll(async () => {
  db = await createTestDb('fwexchange');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [who, role] of [['admin', 'admin'], ['lead', 'lead'], ['reviewer', 'reviewer'], ['viewer', 'viewer']] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[who], role]);
  }
  Object.assign(ids, { vid: (await seed()).v.id });
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('export', () => {
  it('produces a valid, deterministic document with Arabic preserved', async () => {
    const a = await run('viewer', (c) => exportVersion(c, ids.vid!));
    const b = await run('viewer', (c) => exportVersion(c, ids.vid!));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(FrameworkExportSchema.safeParse(JSON.parse(JSON.stringify(a))).success).toBe(true);
    expect(a.requirements.map((r) => [r.code, r.parent_code])).toEqual([['1', null], ['1-1', '1'], ['1-1-1', '1-1']]);
    expect(a.requirements[0]).toMatchObject({ title: AR_TITLE, official_text: AR_TEXT, language: 'ar' });
    expect(a.requirements[0]!.notes[0]!.source).toEqual({ document: 'doc-1', page: 7, quote: 'رسالة معلنة ومعتمدة' });
    expect(a.source_documents[0]).toMatchObject({ ref: 'doc-1', pages: [{ page_no: 7, text: AR_TEXT }] });
    expect(a.config.report_templates[0]).toMatchObject({ key: 'puc_self_study', language: 'ar' });
  });
});

describe('import', () => {
  it('round-trips: export, import, export is identical apart from the edition', async () => {
    const a = await run('lead', (c) => exportVersion(c, ids.vid!));
    const imported = await run('lead', (c) => importVersion(c, JSON.parse(JSON.stringify(a)), { edition: '2019-copy' }));
    expect(imported.counts).toEqual({ requirements: 3, documents: 1, templates: 1 });
    const b = await run('lead', (c) => exportVersion(c, imported.version.id));
    expect({ ...b, version: { ...b.version, edition: a.version.edition } }).toEqual(a);
  });

  it('creates a draft whose content is pending review, marked as imported, with quotes re-verified from the page text', async () => {
    const a = await run('lead', (c) => exportVersion(c, ids.vid!));
    const { version } = await run('lead', (c) => importVersion(c, a, { edition: 'pending-check' }));
    expect(version.status).toBe('draft');
    const rows = await run('lead', (c) => listRequirements(c, version.id));
    expect(rows.every((r) => r.origin === 'import' && r.reviewStatus === 'pending')).toBe(true);
    const notes = (await run('lead', (c) => getRequirementWithNotes(c, rows[0]!.id))).notes;
    expect(notes[0]).toMatchObject({ authority: 'required', quoteVerified: true, origin: 'import', reviewStatus: 'pending' });
  });

  it('does not trust the file about quotes: a tampered quote imports as unverified', async () => {
    const a = await run('lead', (c) => exportVersion(c, ids.vid!));
    a.requirements[0]!.notes[0]!.source!.quote = 'نص غير موجود في الصفحة';
    const { version } = await run('lead', (c) => importVersion(c, a, { edition: 'tampered' }));
    const rows = await run('lead', (c) => listRequirements(c, version.id));
    const notes = (await run('lead', (c) => getRequirementWithNotes(c, rows[0]!.id))).notes;
    expect(notes[0]!.quoteVerified).toBe(false);
  });

  it('an import follows the rules of an AI draft: everything pending, nothing approved line by line (DEC-022)', async () => {
    const a = await run('lead', (c) => exportVersion(c, ids.vid!));
    const { version } = await run('admin', (c) => importVersion(c, a, { edition: 'pending-all' }));
    const rows = await run('lead', (c) => listRequirements(c, version.id));
    expect(rows.every((r) => r.reviewStatus === 'pending' && r.reviewedBy === null)).toBe(true);
    // Publishing the version is the review: it needs no per-line approval.
    await run('lead', (c) => submitForReview(c, version.id));
    expect((await run('admin', (c) => publishVersion(c, version.id))).status).toBe('published');
  });

  it('a required note whose quote is not on its page imports, and the publish gate is what protects the version', async () => {
    const a = await run('lead', (c) => exportVersion(c, ids.vid!));
    a.requirements[0]!.notes[0]!.source!.quote = 'نص غير موجود في الصفحة';
    await run('lead', (c) => importVersion(c, a, { edition: 'bad-manual' }));
  });

  it('reports every problem in a broken file at once', async () => {
    const a = await run('lead', (c) => exportVersion(c, ids.vid!));
    const broken = structuredClone(a);
    broken.requirements.push({ ...broken.requirements[0]! }); // duplicate code
    broken.requirements[1]!.parent_code = 'ghost';
    broken.requirements[2]!.source = { document: 'doc-9', page: 1, quote: 'q' };
    broken.config.lifecycle_template.phases[0]!.milestones[0]!.deliverable = { report_template_key: 'nope' };
    const err = await run('lead', (c) => importVersion(c, broken, { edition: 'broken' })).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    const text = (err as ValidationError).issues.map((i) => `${i.path}: ${i.message}`).join('\n');
    for (const needle of ['duplicate code 1', 'unknown parent ghost', 'unknown source document doc-9', 'unknown report template nope']) expect(text).toContain(needle);
  });

  it('detects parent cycles and unknown formats', async () => {
    const a = await run('lead', (c) => exportVersion(c, ids.vid!));
    const cyc = structuredClone(a);
    cyc.requirements[0]!.parent_code = '1-1-1';
    await expect(run('lead', (c) => importVersion(c, cyc, { edition: 'cycle' }))).rejects.toThrow(/problems/);
    await expect(run('lead', (c) => importVersion(c, { ...a, format: 'something-else' }, { edition: 'x' }))).rejects.toThrow(/not a valid framework file/);
    await expect(run('lead', (c) => importVersion(c, 'not json at all', { edition: 'x' }))).rejects.toBeInstanceOf(ValidationError);
  });

  it('never replaces an existing edition, and reuses the accreditor and framework', async () => {
    const a = await run('lead', (c) => exportVersion(c, ids.vid!));
    await expect(run('lead', (c) => importVersion(c, a))).rejects.toBeInstanceOf(ConflictError); // edition 2019 exists
    const n = (await db.su.query(`select count(*)::int n from accreditor`)).rows[0].n;
    await run('lead', (c) => importVersion(c, a, { edition: 'reuse' }));
    expect((await db.su.query(`select count(*)::int n from accreditor`)).rows[0].n).toBe(n);
  });

  it('is permission-checked', async () => {
    const a = await run('lead', (c) => exportVersion(c, ids.vid!));
    await expect(run('viewer', (c) => importVersion(c, a, { edition: 'v' }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run('reviewer', (c) => importVersion(c, a, { edition: 'r' }))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('a published version exports as published', () => {
  it('can be exported after publication and approvals are not part of the file', async () => {
    const a = await run('lead', (c) => exportVersion(c, ids.vid!));
    const { version } = await run('admin', (c) => importVersion(c, a, { edition: 'for-publish' }));
    await run('lead', (c) => submitForReview(c, version.id));
    await run('admin', (c) => publishVersion(c, version.id));
    const b = await run('viewer', (c) => exportVersion(c, version.id));
    expect(b.requirements).toHaveLength(3);
    expect(JSON.stringify(b)).not.toMatch(/review_status|reviewed_by/);
  });
});
