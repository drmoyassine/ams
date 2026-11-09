// The syllabus tables (TASK-122): a version in progress, an approved version locked by the trigger, one open and one approved version per
// course, tenant isolation, the audit trail, and the new notification kind.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as { inst: string; other: string; user: string; course: string; course2: string }; // filled in beforeAll
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const insertVersion = (course: string, no: number, status = 'draft') => db.su.query(
  `insert into syllabus_version (institution_id, course_id, version_no, status, content) values ($1, $2, $3, $4, '{"info":{}}')`, [ids.inst, course, no, status]);

beforeAll(async () => {
  db = await createTestDb('syllabus');
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('Other') returning id`);
  ids.user = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'Coordinator', 'c@x.org') returning id`, [ids.inst]);
  ids.course = await one(`insert into course (institution_id, code, title_en) values ($1, 'ECE 420', 'Digital Signal Processing') returning id`, [ids.inst]);
  ids.course2 = await one(`insert into course (institution_id, code, title_en) values ($1, 'ECE 210', 'Circuits') returning id`, [ids.inst]);
}, 120000);
afterAll(async () => { await db.close(); });

describe('syllabus versions', () => {
  it('allows one version in progress and one approved version per course, and numbers the versions once', async () => {
    await insertVersion(ids.course, 1, 'approved');
    await insertVersion(ids.course, 2, 'draft');
    await expect(insertVersion(ids.course, 3, 'in_review')).rejects.toThrow(/syllabus_version_open_idx/);
    await expect(insertVersion(ids.course, 2, 'superseded')).rejects.toThrow(/syllabus_version_no_idx/);
    await expect(insertVersion(ids.course, 4, 'approved')).rejects.toThrow(/syllabus_version_approved_idx/);
  });

  it('locks an approved version: the content cannot change, it cannot be deleted, it can only become superseded', async () => {
    const { rows: [v] } = await db.su.query(`select id from syllabus_version where course_id = $1 and status = 'approved'`, [ids.course]);
    await expect(db.su.query(`update syllabus_version set content = '{"info":{"titleEn":"x"}}' where id = $1`, [v.id])).rejects.toThrow(/cannot be changed/);
    await expect(db.su.query(`update syllabus_version set status = 'draft' where id = $1`, [v.id])).rejects.toThrow(/cannot be changed|can only be superseded/);
    await expect(db.su.query(`delete from syllabus_version where id = $1`, [v.id])).rejects.toThrow(/cannot be deleted/);
    // The computed issue columns may be recomputed (the settings changed), the version stays as it was approved.
    await db.su.query(`update syllabus_version set issues = '[{"code":"clos.max"}]', error_count = 1, flagged_since = now() where id = $1`, [v.id]);
    expect((await db.su.query(`select error_count from syllabus_version where id = $1`, [v.id])).rows[0].error_count).toBe(1);
  });

  it('supersedes the approved version when a new one is approved, and lets a draft be discarded', async () => {
    const { rows: [draft] } = await db.su.query(`select id from syllabus_version where course_id = $1 and status = 'draft'`, [ids.course]);
    await db.su.query(`update syllabus_version set status = 'superseded' where course_id = $1 and status = 'approved'`, [ids.course]);
    await db.su.query(`update syllabus_version set status = 'approved' where id = $1`, [draft.id]);
    expect((await db.su.query(`select version_no from syllabus_version where course_id = $1 and status = 'superseded'`, [ids.course])).rows).toEqual([{ version_no: 1 }]);
    await insertVersion(ids.course2, 1, 'draft');
    await db.su.query(`delete from syllabus_version where course_id = $1`, [ids.course2]);
  });

  it('refuses a status outside the list and content that is not an object', async () => {
    await expect(insertVersion(ids.course2, 1, 'published')).rejects.toThrow(/syllabus_version_status_check/);
    await expect(db.su.query(`insert into syllabus_version (institution_id, course_id, version_no, content) values ($1, $2, 1, '[]')`, [ids.inst, ids.course2])).rejects.toThrow(/syllabus_version_content_check/);
  });

  it('keeps one institution’s syllabi from another', async () => {
    expect((await db.as({ userId: ids.user, institutionId: ids.inst }, (c) => c.query(`select count(*)::int as n from syllabus_version`))).rows[0].n).toBeGreaterThan(0);
    expect((await db.as({ userId: ids.user, institutionId: ids.other }, (c) => c.query(`select count(*)::int as n from syllabus_version`))).rows[0].n).toBe(0);
  });

  it('writes an audit event for a change', async () => {
    const { rows } = await db.su.query(`select count(*)::int as n from audit_event where target_type = 'syllabus_version'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

describe('course fields, requisites and notices', () => {
  it('checks the new course columns and refuses a course as its own prerequisite', async () => {
    await expect(db.su.query(`update course set course_type = 'webinar' where id = $1`, [ids.course])).rejects.toThrow(/course_type_check/);
    await expect(db.su.query(`update course set level_band = '500' where id = $1`, [ids.course])).rejects.toThrow(/course_level_band_check/);
    await expect(db.su.query(`update course set contact_lab = -1 where id = $1`, [ids.course])).rejects.toThrow(/course_contact_check/);
    await db.su.query(`update course set course_type = 'didactic', level_band = '400', category = 'program_core', sustainability = 'none', contact_lecture = 3 where id = $1`, [ids.course]);
    await expect(db.su.query(`insert into course_requisite (institution_id, course_id, requisite_id, kind) values ($1, $2, $2, 'prerequisite')`, [ids.inst, ids.course])).rejects.toThrow(/course_requisite_self_check/);
    await db.su.query(`insert into course_requisite (institution_id, course_id, requisite_id, kind) values ($1, $2, $3, 'prerequisite')`, [ids.inst, ids.course, ids.course2]);
    await expect(db.su.query(`insert into course_requisite (institution_id, course_id, requisite_id, kind) values ($1, $2, $3, 'corequisite')`, [ids.inst, ids.course, ids.course2])).rejects.toThrow(/course_requisite_idx/);
  });

  it('takes the syllabus_flagged notification kind', async () => {
    await db.su.query(`insert into notification (institution_id, user_id, kind, title, body) values ($1, $2, 'syllabus_flagged', 'A syllabus needs attention', 'ECE 420')`, [ids.inst, ids.user]);
    await expect(db.su.query(`insert into notification (institution_id, user_id, kind, title, body) values ($1, $2, 'other', 'x', 'y')`, [ids.inst, ids.user])).rejects.toThrow(/notification_kind_check/);
  });
});
