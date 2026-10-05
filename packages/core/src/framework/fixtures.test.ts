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
    // The exporter writes templates in key order; the fixture files are free to list them in reading order.
    const expected = FrameworkExportSchema.parse(load(name));
    expected.config.report_templates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    expect(out).toEqual(expected);
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
    expect(exp['puc-2019'].requirements).toHaveLength(7);
    expect(exp['puc-2019'].config.report_templates[0]).toMatchObject({ key: 'puc_self_study', language: 'ar', requires_attestation: true });
    expect(exp['puc-2019'].config.report_templates[0]!.structure.sections).toHaveLength(14);
  });
});
