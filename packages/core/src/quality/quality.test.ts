// Quality Management as the IQF in operation (DEC-048): course scope, a frequency of week 12 each semester, the chain program
// coordinator -> dean -> QA office -> champion, the tabs each person sees, submit, approve, return and the frozen approval.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, type World } from '../engagement/test-support.js';
import { setUpQualityFramework } from '../framework/internal.js';
import { createRequirement, reviewRequirement } from '../framework/requirements.js';
import { publishVersion, submitForReview } from '../framework/versions.js';
import { setRequirementChampion, setRequirementScope } from '../scope/index.js';
import {
  decideSubmission, getRequirementQuality, openSubmission, qualityTab, qualityTabs, saveSubmissionEvidence, setQualityOffice, setRequirementApproval,
  setRequirementFrequency, submitSubmission,
} from './service.js';

let w: World;
const ids: Record<string, string> = {};
const one = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows[0].id as string;

beforeAll(async () => {
  w = await buildWorld('qualitysvc');
  const q = await w.as('admin', (c) => setUpQualityFramework(c));
  ids.qv = q.versions[0]!.id;
  const cla = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'S3', levelLabel: 'Standard', title: 'Course learning assessment' }));
  const s31 = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'S3.1', levelLabel: 'Sub-standard', title: 'Direct assessment of CLOs', parentId: cla.id }));
  const s32 = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'S3.2', levelLabel: 'Sub-standard', title: 'Reflection and closing the loop', parentId: cla.id }));
  const other = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'S4', levelLabel: 'Standard', title: 'Governance' }));
  for (const r of [cla, s31, s32, other]) await w.as('admin', (c) => reviewRequirement(c, r.id, 'approved'));
  await w.as('admin', (c) => submitForReview(c, ids.qv!));
  await w.as('admin', (c) => publishVersion(c, ids.qv!));
  ids.fw = await one(`select framework_id as id from framework_version where id = $1`, [ids.qv]);
  // The college (dean: second), its department, the program (coordinator: coord), the course (coordinator: contrib), the QA office (head: alo).
  ids.college = await one(`select id from org_unit where name_en = 'Engineering'`);
  await w.db.su.query(`update org_unit set head_user_id = $1 where id = $2`, [w.ids.second, ids.college]);
  await w.db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'viewer', 'institution', $1)`, [w.ids.inst, w.ids.second]);
  ids.dept = await one(`insert into org_unit (institution_id, parent_id, type, name_en) values ($1, $2, 'department', 'ECE') returning id`, [w.ids.inst, ids.college]);
  ids.qa = await one(`insert into org_unit (institution_id, type, name_en, head_user_id) values ($1, 'department', 'QAIE', $2) returning id`, [w.ids.inst, w.ids.alo]);
  await w.db.su.query(`update program set coordinator_user_id = $1 where id = $2`, [w.ids.coord, w.ids.mech]);
  ids.course = await one(`insert into course (institution_id, org_unit_id, code, title_en, coordinator_user_id) values ($1, $2, 'ECE420', 'Digital Signal Processing', $3) returning id`, [w.ids.inst, ids.dept, w.ids.contrib]);
  await w.db.su.query(`insert into course_program (institution_id, course_id, program_id) values ($1, $2, $3)`, [w.ids.inst, ids.course, w.ids.mech]);
  await w.db.su.query(`insert into academic_term (institution_id, name, kind, start_date, end_date) values ($1, 'Fall 2026', 'term', '2026-08-24', '2026-12-18'), ($1, 'Spring 2027', 'term', '2027-01-11', '2027-05-07')`, [w.ids.inst]);
  // Two evidence items linked (approved) to the sub-standards.
  for (const [k, title, code] of [['clo', 'CLO assessment', 'S3.1'], ['refl', 'Reflection and course improvement', 'S3.2']] as const) {
    ids[k] = await one(`insert into evidence_item (institution_id, title, type) values ($1, $2, 'document') returning id`, [w.ids.inst, title]);
    ids[`${k}v`] = await one(`insert into evidence_version (institution_id, evidence_item_id, version_no, url) values ($1, $2, 1, 'https://x.example/${k}') returning id`, [w.ids.inst, ids[k]]);
    await w.db.su.query(`insert into evidence_link (institution_id, evidence_version_id, internal_framework_id, internal_code, rationale, review_status) values ($1, $2, $3, $4, 'asked for', 'approved')`, [w.ids.inst, ids[`${k}v`], ids.fw, code]);
  }
}, 180000);
afterAll(() => w.close());

describe('Quality Management as the IQF in operation', () => {
  it('sets a semester frequency, the chain and the QA office on the standard; the sub-standards inherit them', async () => {
    await w.as('admin', (c) => setRequirementScope(c, { frameworkId: ids.fw!, code: 'S3', levelKey: 'course', itemIds: [ids.course!] }));
    await w.as('admin', (c) => setRequirementChampion(c, { frameworkId: ids.fw!, code: 'S3', userId: w.ids.admin! }));
    await w.as('admin', (c) => setRequirementFrequency(c, { frameworkId: ids.fw!, code: 'S3', rule: { every: 'semester', week: 12, timezone: 'Asia/Dubai', startDate: '2026-01-01' } }));
    await w.as('admin', (c) => setRequirementApproval(c, { frameworkId: ids.fw!, code: 'S3', steps: [{ kind: 'program_coordinator' }, { kind: 'unit_head', unitType: 'college', label: 'Dean' }] }));
    await w.as('admin', (c) => setQualityOffice(c, ids.qa!));
    const q = await w.as('alo', (c) => getRequirementQuality(c, ids.qv!, ids.fw!));
    expect(q.find((x) => x.code === 'S3.2')).toMatchObject({ frequency: { own: null, text: 'Every semester, week 12', source: { kind: 'parent', code: 'S3' } }, approval: { own: null, source: { kind: 'parent', code: 'S3' } } });
    await expect(w.as('contrib', (c) => setRequirementFrequency(c, { frameworkId: ids.fw!, code: 'S3', optOut: true }))).rejects.toThrow();
  });

  it('shows each person only the standards they submit or approve for; an administrator and the QA office read every one', async () => {
    expect((await w.as('contrib', (c) => qualityTabs(c))).tabs.map((t) => [t.code, t.roles])).toEqual([['S3', ['submit']]]);
    expect((await w.as('coord', (c) => qualityTabs(c))).tabs.map((t) => [t.code, t.roles])).toEqual([['S3', ['approve']]]);
    expect((await w.as('second', (c) => qualityTabs(c))).tabs.map((t) => t.code)).toEqual(['S3']);
    expect((await w.as('outsider', (c) => qualityTabs(c).catch(() => ({ tabs: [] })))).tabs).toEqual([]);
    expect((await w.as('alo', (c) => qualityTabs(c))).tabs.map((t) => t.code)).toEqual(['S3', 'S4']);
    const tab = await w.as('contrib', (c) => qualityTab(c, 'S3'));
    expect(tab.standard.children.map((x) => [x.code, x.evidence.map((e) => e.title)])).toEqual([['S3.1', ['CLO assessment']], ['S3.2', ['Reflection and course improvement']]]);
    expect(tab.submissions.length).toBeGreaterThan(0);
    expect(tab.submissions.every((s) => s.subjectName === 'ECE420 Digital Signal Processing' && s.evidenceTotal === 2)).toBe(true);
  });

  it('is submitted by the course coordinator, approved step by step to "Internally approved", and frozen', async () => {
    const key = { frameworkId: ids.fw!, code: 'S3', subjectKind: 'course' as const, subjectId: ids.course!, periodKey: 'T2026-08-24' };
    await expect(w.as('coord', (c) => openSubmission(c, key))).rejects.toThrow(/Only the person who submits/);
    let s = await w.as('contrib', (c) => openSubmission(c, key));
    expect(s).toMatchObject({ status: 'draft', periodLabel: 'Fall 2026', evidenceTotal: 2, evidenceDone: 0 });
    expect(s.steps.map((x) => [x.label, x.approvers.map((a) => a.id)])).toEqual([
      ['Program coordinator', [w.ids.coord]], ['Dean', [w.ids.second]], ['QA office', [w.ids.alo]], ['Champion', [w.ids.admin]]]);
    await expect(w.as('contrib', (c) => submitSubmission(c, s.id!))).rejects.toThrow(/Provide the evidence first/);
    await w.as('contrib', (c) => saveSubmissionEvidence(c, s.id!, { itemId: ids.clo!, versionId: ids.clov! }));
    s = await w.as('contrib', (c) => saveSubmissionEvidence(c, s.id!, { itemId: ids.refl!, versionId: ids.reflv!, note: 'Lab sessions added.' }));
    expect(s.evidenceDone).toBe(2);
    s = await w.as('contrib', (c) => submitSubmission(c, s.id!));
    expect(s).toMatchObject({ status: 'submitted', waitingOn: 'Program coordinator' });
    await expect(w.as('second', (c) => decideSubmission(c, s.id!, { decision: 'approved' }))).rejects.toThrow(/waiting for Program coordinator/);
    // The program coordinator returns it; the coordinator fixes and resubmits; the next round goes through.
    s = await w.as('coord', (c) => decideSubmission(c, s.id!, { decision: 'returned', note: 'Add the survey.' }));
    expect(s.status).toBe('returned');
    s = await w.as('contrib', (c) => submitSubmission(c, s.id!));
    expect(s.round).toBe(2);
    for (const who of ['coord', 'second', 'alo']) s = await w.as(who, (c) => decideSubmission(c, s.id!, { decision: 'approved' }));
    expect(s).toMatchObject({ status: 'submitted', waitingOn: 'Champion' });
    expect((await w.as('admin', (c) => qualityTabs(c))).tabs.find((t) => t.code === 'S3')!.toApprove).toBe(1);
    s = await w.as('admin', (c) => decideSubmission(c, s.id!, { decision: 'approved' }));
    expect(s.status).toBe('approved');
    expect(s.steps.filter((x) => x.round === 2).map((x) => x.decision)).toEqual(['approved', 'approved', 'approved', 'approved']);
    await expect(w.db.su.query(`update quality_submission set period_label = 'x' where id = $1`, [s.id])).rejects.toThrow(/approved submission is kept/);
    await expect(w.db.su.query(`delete from quality_submission_evidence where submission_id = $1`, [s.id])).rejects.toThrow(/approved submission is kept/);
  });
});
