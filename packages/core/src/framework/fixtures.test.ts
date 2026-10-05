// M1 acceptance (ROADMAP-002): the Appendix A fixtures import, publish and reject every edit after publishing,
// all through the same code path.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { FrameworkExportSchema, validateFrameworkConfig, type FrameworkExport } from '@ams/shared';
import type { Ctx } from '../index.js';
import {
  createRequirement, exportVersion, importVersion, listRequirements, publishVersion, submitForReview, updateRequirement, updateVersionConfig,
  upsertReportTemplate, validateVersion,
} from './index.js';

const FIXTURES = resolve(import.meta.dirname, '../../../db/fixtures');
const load = (name: string) => JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as unknown;
const NAMES = ['wscuc-2023', 'abet-eac-2027-28', 'puc-2019'] as const;

let db: TestDb;
let pool: pg.Pool;
const ids = {} as Record<string, string>;
const published = {} as Record<(typeof NAMES)[number], string>;

const admin = <T>(fn: (ctx: Ctx) => Promise<T>) => {
  const caller = { userId: ids.admin!, institutionId: ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined }));
};

beforeAll(async () => {
  db = await createTestDb('fixtures');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = (await db.su.query(`insert into institution (name_en) values ('U') returning id`)).rows[0].id;
  ids.admin = (await db.su.query(`insert into app_user (institution_id, full_name, email) values ($1, 'Admin', 'a@x.org') returning id`, [ids.inst])).rows[0].id;
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.inst, ids.admin]);
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

describe.each(NAMES)('fixture %s', (name) => {
  it('is a valid framework file with a valid configuration', () => {
    const file = FrameworkExportSchema.parse(load(name));
    const result = validateFrameworkConfig(file.config);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it('imports as a draft, passes the configuration check, and publishes', async () => {
    const { version, counts } = await admin((c) => importVersion(c, load(name), { autoApprove: true }));
    expect(version.status).toBe('draft');
    expect(counts.requirements).toBe(FrameworkExportSchema.parse(load(name)).requirements.length);
    expect(await admin((c) => validateVersion(c, version.id))).toMatchObject({ ok: true });
    await admin((c) => submitForReview(c, version.id));
    const done = await admin((c) => publishVersion(c, version.id));
    expect(done).toMatchObject({ status: 'published', publishedBy: ids.admin });
    published[name] = version.id;
  });

  it('rejects every edit after publishing: through the services', async () => {
    const id = published[name];
    const rows = await admin((c) => listRequirements(c, id));
    await expect(admin((c) => updateRequirement(c, rows[0]!.id, { title: 'changed' }))).rejects.toThrow(/immutable/);
    await expect(admin((c) => createRequirement(c, { versionId: id, code: 'NEW', levelLabel: rows[0]!.levelLabel, title: 'new' }))).rejects.toThrow(/immutable/);
    await expect(admin((c) => updateVersionConfig(c, id, { changeSummary: 'x' }))).rejects.toThrow(/immutable/);
    const tpl = FrameworkExportSchema.parse(load(name)).config.report_templates[0]!;
    await expect(admin((c) => upsertReportTemplate(c, id, tpl))).rejects.toThrow(/immutable/);
  });

  it('rejects every edit after publishing: even for raw SQL by the database owner', async () => {
    const id = published[name];
    const immutable = /immutable/;
    const one = async (sql: string) => (await db.su.query(sql, [id])).rows[0]?.id as string;
    const reqId = await one(`select id from requirement where framework_version_id = $1 limit 1`);
    const tplId = await one(`select id from report_template where framework_version_id = $1 limit 1`);
    await expect(db.su.query(`update requirement set title = 'x' where id = $1`, [reqId])).rejects.toThrow(immutable);
    await expect(db.su.query(`delete from requirement where id = $1`, [reqId])).rejects.toThrow(immutable);
    await expect(db.su.query(`update report_template set name = 'x' where id = $1`, [tplId])).rejects.toThrow(immutable);
    await expect(db.su.query(`delete from report_template where id = $1`, [tplId])).rejects.toThrow(immutable);
    await expect(db.su.query(`update framework_version set lifecycle_template = '{}' where id = $1`, [id])).rejects.toThrow(/only its status may change/);
    await expect(db.su.query(`delete from framework_version where id = $1`, [id])).rejects.toThrow(/cannot be deleted/);
    await expect(db.su.query(
      `insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, 'RAW', 'x', 'x')`, [ids.inst, id])).rejects.toThrow(immutable);
  });

  it('exports exactly what was imported', async () => {
    const out = await admin((c) => exportVersion(c, published[name]));
    // Fixture files are kept in the exporter's canonical order (tree order, templates by key), so equality is exact.
    expect(out).toEqual(FrameworkExportSchema.parse(load(name)));
  });
});

describe('real source text (WSCUC 2023 Handbook)', () => {
  it('every requirement and note quotes a sentence found on the cited page', async () => {
    const id = published['wscuc-2023'];
    const { rows } = await db.su.query(
      `select 'requirement' kind, r.code, r.quote_verified from requirement r where r.framework_version_id = $1 and r.source_quote is not null
       union all
       select 'note', r.code, n.quote_verified from requirement_note n join requirement r on r.id = n.requirement_id where r.framework_version_id = $1 and n.source_quote is not null`, [id]);
    expect(rows).toHaveLength(90); // 4 standards + 41 CFRs, each with a quote; 4 essay notes + 41 worksheet notes
    expect(rows.filter((r) => !r.quote_verified)).toEqual([]);
  });

  it('keeps the accreditor\'s hierarchy: Standard > heading > CFR, with headings not assessable', async () => {
    const file = FrameworkExportSchema.parse(load('wscuc-2023'));
    const byCode = new Map(file.requirements.map((r) => [r.code, r]));
    const cfr = byCode.get('CFR 2.9')!;
    expect(byCode.get(cfr.parent_code!)).toMatchObject({ title: 'Student Learning and Performance', level_label: 'Heading', is_assessable: false, parent_code: 'Standard 2' });
    expect(byCode.get('Standard 3')!.title).toBe('Assuring Resources and Organizational Structures');
    expect(cfr.official_text).toMatch(/^The institution demonstrates that graduates consistently achieve stated learning outcomes/);
  });

  it('classifies only explicit obligations as required', () => {
    const file = FrameworkExportSchema.parse(load('wscuc-2023'));
    const notes = file.requirements.flatMap((r) => r.notes);
    const required = notes.filter((n) => n.authority === 'required');
    expect(required).toHaveLength(41); // the Compliance Worksheet is required for every CFR
    expect(new Set(required.map((n) => n.source!.quote))).toEqual(new Set(['institutions are required to complete the Compliance with WSCUC Standards Worksheet']));
    expect(notes.filter((n) => n.authority === 'suggested')).toHaveLength(4); // essay guidance: descriptive, not "must"
  });
});

describe('real source text (PUC Institutional Accreditation Guide 2019)', () => {
  it('has 7 standards, 24 measures and 151 indicators, all in Arabic with verifiable quotes', async () => {
    const file = FrameworkExportSchema.parse(load('puc-2019'));
    const by = (l: string) => file.requirements.filter((r) => r.level_label === l);
    expect([by('Standard').length, by('Measure').length, by('Indicator').length]).toEqual([7, 24, 151]);
    expect(file.requirements.every((r) => r.language === 'ar')).toBe(true);
    const { rows } = await db.su.query(
      `select count(*)::int as n, count(*) filter (where not r.quote_verified)::int as bad from requirement r where r.framework_version_id = $1 and r.source_quote is not null`,
      [published['puc-2019']],
    );
    expect(rows[0].bad).toBe(0);
    expect(rows[0].n).toBe(182);
  });

  it('keeps indicators that span two pages whole and cites the first page', () => {
    const file = FrameworkExportSchema.parse(load('puc-2019'));
    const r = file.requirements.find((x) => x.code === '6-1-1')!;
    expect(r.source!.page).toBe(9);
    expect(r.official_text!.endsWith('بيع كتب).')).toBe(true);
  });
});

describe('real source text (ABET EAC Criteria and APPM 2025-26)', () => {
  it('quotes every criterion, the Mechanical Program Criteria and APPM I.C, verified against the cited pages', async () => {
    const file = FrameworkExportSchema.parse(load('abet-eac-2027-28'));
    expect(file.requirements.filter((r) => /^Criterion \d$/.test(r.code))).toHaveLength(8);
    expect(file.requirements.filter((r) => r.code.startsWith('I.C.'))).toHaveLength(40);
    expect(file.requirements.every((r) => r.code.startsWith('APPM') || r.official_text)).toBe(true);
    const sourced = file.requirements.filter((r) => r.source).length;
    const { rows } = await db.su.query(
      `select count(*)::int as n, count(*) filter (where not quote_verified)::int as bad from requirement where framework_version_id = $1 and source_quote is not null`,
      [published['abet-eac-2027-28']],
    );
    expect(rows[0].bad).toBe(0);
    expect(rows[0].n).toBe(sourced);
  });

  it('splits student outcomes and curriculum items, keeps verbatim text, and tags program criteria', () => {
    const file = FrameworkExportSchema.parse(load('abet-eac-2027-28'));
    const by = new Map(file.requirements.map((r) => [r.code, r]));
    expect(file.requirements.filter((r) => r.parent_code === 'Criterion 3')).toHaveLength(7);
    expect(by.get('Criterion 3(3)')!.official_text).toBe('an ability to communicate effectively with a range of audiences.');
    expect(file.requirements.filter((r) => r.parent_code === 'Criterion 5').map((r) => r.code)).toEqual(['Criterion 5(a)', 'Criterion 5(b)', 'Criterion 5(c)', 'Criterion 5(d)']);
    expect(by.get('Criterion 5(a)')!.notes[0]).toMatchObject({ type: 'quantitative_norm', authority: 'required', norm: { min: 30, unit: 'semester_credit_hours' } });
    expect(by.get('Criterion 5(b)')!.notes[0]!.norm).toMatchObject({ min: 45 });
    expect(by.get('Mechanical 1')!.applies_when).toEqual({ scope: ['program'], program_tags: ['mechanical'] });
    expect(by.get('I.C.5.a')!.official_text).toBe('A program must have had at least one graduate within the two academic years prior to the on-site review.');
    expect(by.get('I.C.1.a.(1)')!.is_assessable).toBe(false);
  });

  it('carries the Self-Study Questionnaire prompts as unsourced suggested notes, and the ABET data-table columns', () => {
    const file = FrameworkExportSchema.parse(load('abet-eac-2027-28'));
    const ssq = file.requirements.flatMap((r) => r.notes).filter((n) => n.text.startsWith('Self-Study Questionnaire 2027-28'));
    expect(ssq.length).toBeGreaterThanOrEqual(30);
    expect(ssq.every((n) => n.authority === 'suggested' && n.source === null)).toBe(true);
    const ssr = file.config.report_templates.find((t) => t.key === 'ssr')!;
    const tables = new Map<string, string[]>();
    const walk = (ss: typeof ssr.structure.sections): void => { for (const s of ss) { if (s.columns) tables.set(s.key, s.columns.map((c) => c.key)); walk(s.children ?? []); } };
    walk(ssr.structure.sections);
    expect(tables.get('T5-1')).toContain('max_section_enrollment');
    expect(tables.get('T6-1')).toEqual(expect.arrayContaining(['rank', 'appointment', 'registration']));
    expect(tables.get('TD-2')).toEqual(['category', 'head_ft', 'head_pt', 'fte']);
  });
});

describe('the three fixtures share one code path and one database', () => {
  it('are all published side by side', async () => {
    const { rows } = await db.su.query(`select a.short_name, fv.edition, fv.status from framework_version fv join framework f on f.id = fv.framework_id join accreditor a on a.id = f.accreditor_id order by a.short_name`);
    expect(rows).toEqual([
      { short_name: 'ABET', edition: '2027-28', status: 'published' },
      { short_name: 'PUC', edition: '2019', status: 'published' },
      { short_name: 'WSCUC', edition: '2023', status: 'published' },
    ]);
  });

  it('carry the PRD Appendix A configuration', async () => {
    const exp = Object.fromEntries(await Promise.all(NAMES.map(async (n) => [n, await admin((c) => exportVersion(c, published[n]))]))) as Record<(typeof NAMES)[number], FrameworkExport>;
    const find = (f: FrameworkExport, key: string) => f.config.lifecycle_template.phases.flatMap((p) => p.milestones).find((m) => m.key === key)!;

    // WSCUC reaffirmation: due rules relative to the submission date.
    expect(find(exp['wscuc-2023'], 'liaison_consultation').due).toEqual({ anchor: 'submission_date', offset_days: -540 });
    expect(find(exp['wscuc-2023'], 'submit_institutional_report').due).toEqual({ anchor: 'submission_date', offset_days: 0 });
    expect(exp['wscuc-2023'].config.decision_vocab.map((d) => d.code)).toEqual(['reaffirm', 'initial', 'candidacy', 'defer', 'notice_of_concern', 'warning', 'probation', 'show_cause', 'deny', 'withdraw']);
    expect(exp['wscuc-2023'].config.report_templates.find((t) => t.key === 'institutional_report')).toMatchObject({ kind: 'self_study', requires_attestation: true, word_limit: 18000 });
    expect(exp['wscuc-2023'].requirements.filter((r) => r.level_label === 'CFR')).toHaveLength(41);

    // ABET: fixed dates relative to the review year.
    expect(find(exp['abet-eac-2027-28'], 'ssr_submit').due).toEqual({ fixed: '07-01', year_offset: 0 });
    expect(find(exp['abet-eac-2027-28'], 'rrev_report').due).toEqual({ fixed: '09-01', year_offset: -1 });
    expect(find(exp['abet-eac-2027-28'], 'final_statement_received').due).toEqual({ fixed: '08-31', year_offset: 1 });
    expect(exp['abet-eac-2027-28'].config.decision_vocab.map((d) => d.code)).toEqual(['NGR', 'IR', 'IV', 'SCR', 'SCV', 'RE', 'VE', 'SE', 'NA']);
    expect(exp['abet-eac-2027-28'].config.finding_vocab.map((f) => f.code)).toEqual(['deficiency', 'weakness', 'concern', 'observation']);
    expect(exp['abet-eac-2027-28'].requirements.find((r) => r.code === 'Program Criteria: Mechanical')!.applies_when).toEqual({ scope: ['program'], program_tags: ['mechanical'] });

    // PUC: three levels, an Arabic self-study template.
    expect(exp['puc-2019'].config.level_labels).toEqual(['Standard', 'Measure', 'Indicator']);
    expect(exp['puc-2019'].requirements).toHaveLength(182);
    expect(exp['puc-2019'].config.report_templates[0]).toMatchObject({ key: 'puc_self_study', language: 'ar', requires_attestation: true });
    expect(exp['puc-2019'].config.report_templates[0]!.structure.sections).toHaveLength(14);
  });
});
