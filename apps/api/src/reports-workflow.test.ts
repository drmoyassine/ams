// The workflow over HTTP (TASK-094, PRD 10.4 steps 2 to 5): a writer sends sections for review, a reviewer approves or
// returns them (the note comes back on the section), the report is internally approved, a manager freezes the snapshot
// (with the word diff against the previous round) and marks it submitted — which completes the milestone and locks the
// report. Writers cannot review; reviewers cannot write; submission is terminal.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const as = (who: string) => ({ 'x-test-user': `${ids[who]}:${ids.inst}` });
async function call(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await app.request(path, {
    method, headers: { 'content-type': 'application/json', ...as(who) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const STRUCTURE = {
  sections: [
    { key: 'intro', title: 'Introduction', block_type: 'narrative', requirement_codes: ['1.1'], word_limit: 100 },
    { key: 'data', title: 'Data', block_type: 'data_table', columns: [{ key: 'name', label: 'Name', type: 'text' }] },
  ],
};

beforeAll(async () => {
  db = await createTestDb('apireportswf');
  pool = new pg.Pool({ connectionString: db.url });
  const made = createApp({ pool, store, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } });
  app = made.app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'writer', 'reader']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['writer', 'contributor'], ['reader', 'reviewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  ids.accreditor = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'WSCUC', 'WSCUC', 'institutional') returning id`, [ids.inst]);
  ids.framework = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'WSCUC 2024', 'institution') returning id`, [ids.inst, ids.accreditor]);
  ids.version = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2024') returning id`, [ids.inst, ids.framework]);
  ids.req1 = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, '1.1', 'Standard', 'Mission') returning id`, [ids.inst, ids.version]);
  ids.template = await one(
    `insert into report_template (institution_id, framework_version_id, key, name, kind, structure, review_status) values ($1, $2, 'self_study', 'Self-Study Report', 'self_study', $3, 'approved') returning id`,
    [ids.inst, ids.version, JSON.stringify(STRUCTURE)]);
  await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ids.version]);
  await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [ids.version, ids.admin]);
  await db.su.query(
    `with e as (insert into engagement (institution_id, framework_version_id, subject_type, subject_id, kind, title, review_year, lead_user_id) values ($1, $2, 'institution', $1, 'initial', 'Initial Accreditation 2026', 2026, $3) returning id, institution_id, lead_user_id)
     insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) select institution_id, lead_user_id, 'engagement_lead', 'engagement', id from e`,
    [ids.inst, ids.version, ids.lead]);
  ids.engagement = await one(`select id from engagement where title = 'Initial Accreditation 2026'`);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

const sectionOf = (detail: { sections: { id: string; key: string }[] }, key: string) => detail.sections.find((s) => s.key === key)!.id;
const approveAll = async (reportId: string, sections: { id: string; key: string }[]) => {
  for (const s of sections) {
    await call('writer', 'POST', `/api/reports/${reportId}/sections/${s.id}/review`);
    await call('reader', 'POST', `/api/reports/${reportId}/sections/${s.id}/decision`, { decision: 'approved' });
  }
};

describe('report workflow API', () => {
  it('runs the review: send for review, approve, return with a note, and the note comes back on the section', async () => {
    const made = await call('admin', 'POST', '/api/reports', { engagementId: ids.engagement, frameworkVersionId: ids.version, templateKey: 'self_study' });
    expect(made.status).toBe(201);
    ids.report = made.body.id;
    const intro = sectionOf(made.body, 'intro');
    // A writer saves, but cannot review; a reviewer decides, but cannot write.
    expect((await call('writer', 'PATCH', `/api/reports/${ids.report}/sections/${intro}/content`, { narrative: { text: 'We serve the public with two libraries.' } })).status).toBe(200);
    expect((await call('writer', 'POST', `/api/reports/${ids.report}/sections/${intro}/decision`, { decision: 'approved' })).status).toBe(403);
    expect((await call('reader', 'POST', `/api/reports/${ids.report}/sections/${intro}/review`)).status).toBe(403);
    expect((await call('writer', 'POST', `/api/reports/${ids.report}/sections/${intro}/review`)).status).toBe(200);
    // Approving needs a section in review; returning needs a note.
    expect((await call('reader', 'POST', `/api/reports/${ids.report}/sections/${intro}/decision`, { decision: 'approved' })).status).toBe(200);
    expect((await call('reader', 'POST', `/api/reports/${ids.report}/sections/${intro}/decision`, { decision: 'returned' })).status).toBe(400);
    // Reopening an approved section of a draft report works: a returned decision, the section goes back to draft.
    const reopened = await call('reader', 'POST', `/api/reports/${ids.report}/sections/${intro}/decision`, { decision: 'returned', note: 'not yet' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe('draft');
    expect(reopened.body.sections.find((s: { key: string }) => s.key === 'intro').status).toBe('draft');
    // The writer revises and resends; this time the reviewer returns it with the note the writer then reads.
    expect((await call('writer', 'PATCH', `/api/reports/${ids.report}/sections/${intro}/content`, { narrative: { text: 'We serve the public with two libraries.' } })).status).toBe(200);
    expect((await call('writer', 'POST', `/api/reports/${ids.report}/sections/${intro}/review`)).status).toBe(200);
    const back = await call('reader', 'POST', `/api/reports/${ids.report}/sections/${intro}/decision`, { decision: 'returned', note: 'Name the libraries.' });
    expect(back.status).toBe(200);
    const after = back.body.sections.find((s: { key: string }) => s.key === 'intro');
    expect(after.status).toBe('returned');
    expect(after.lastDecision.decision).toBe('returned');
    expect(after.lastDecision.note).toBe('Name the libraries.');
    expect(after.lastDecision.decidedByName).toBe('reader');
    // The writer revises once more; every section is approved; the report is internally approved.
    expect((await call('writer', 'PATCH', `/api/reports/${ids.report}/sections/${intro}/content`, { narrative: { text: 'We serve the public with two libraries.' } })).status).toBe(200);
    await approveAll(ids.report!, made.body.sections);
    expect((await call('reader', 'POST', `/api/reports/${ids.report}/approve`)).status).toBe(200);
    const done = await call('reader', 'GET', `/api/reports/${ids.report}`);
    expect(done.body.status).toBe('internally_approved');
  });

  it('the snapshot freezes the report once, immutably; submission completes the milestone and locks', async () => {
    // The engagement's submission milestone points at the report, to be completed by "Mark submitted".
    await db.su.query(
      `insert into milestone (institution_id, engagement_id, phase, name, type, report_id) values ($1, $2, 'self_study', 'Send the self-study', 'submission', $3)`,
      [ids.inst, ids.engagement, ids.report]);
    // Only a manager snapshots; a writer or reviewer cannot.
    expect((await call('writer', 'POST', `/api/reports/${ids.report}/snapshot`)).status).toBe(403);
    expect((await call('reader', 'POST', `/api/reports/${ids.report}/snapshot`)).status).toBe(403);
    const snap = await call('admin', 'POST', `/api/reports/${ids.report}/snapshot`);
    expect(snap.status).toBe(201);
    expect(snap.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.body.manifest.sections).toHaveLength(2);
    expect(snap.body.manifest.report.title).toContain('Self-Study');
    const detail = await call('writer', 'GET', `/api/reports/${ids.report}`);
    expect(detail.body.snapshotId).toBe(snap.body.id);
    expect((await call('admin', 'POST', `/api/reports/${ids.report}/snapshot`)).status).toBe(409);
    // A reader sees the frozen snapshot.
    expect((await call('reader', 'GET', `/api/reports/${ids.report}/snapshot`)).status).toBe(200);
    // Submitting before a snapshot is refused; with one, it stamps and completes the milestone.
    const other = await call('admin', 'POST', '/api/reports', { engagementId: ids.engagement, frameworkVersionId: ids.version, templateKey: 'self_study', round: 2 });
    ids.report2 = other.body.id;
    expect((await call('admin', 'POST', `/api/reports/${ids.report2}/submit`, {})).status).toBe(400);
    const submitted = await call('admin', 'POST', `/api/reports/${ids.report}/submit`, { ref: 'WSCUC-2026-774' });
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('submitted');
    expect(submitted.body.submittedRef).toBe('WSCUC-2026-774');
    const stamp = await db.su.query(`select submitted_by, submitted_at from report where id = $1`, [ids.report]);
    expect(stamp.rows[0].submitted_by).toBe(ids.admin);
    expect(stamp.rows[0].submitted_at).not.toBeNull();
    const ms = await db.su.query(`select status, completed_at from milestone where report_id = $1`, [ids.report]);
    expect(ms.rows[0].status).toBe('done');
    expect(ms.rows[0].completed_at).not.toBeNull();
    // Submitted means locked: no more writing, no more review moves.
    const intro = sectionOf(submitted.body, 'intro');
    expect((await call('writer', 'PATCH', `/api/reports/${ids.report}/sections/${intro}/content`, { narrative: { text: 'no' } })).status).toBe(409);
    expect((await call('writer', 'POST', `/api/reports/${ids.report}/sections/${intro}/review`)).status).toBe(400);
    expect((await call('reader', 'POST', `/api/reports/${ids.report}/sections/${intro}/decision`, { decision: 'returned', note: 'late' })).status).toBe(400);
  });

  it('the next round carries the word diff against this snapshot (PRD 11.4)', async () => {
    const round2 = await call('writer', 'GET', `/api/reports/${ids.report2}`);
    const intro = sectionOf(round2.body, 'intro');
    await call('writer', 'PATCH', `/api/reports/${ids.report2}/sections/${intro}/content`, { narrative: { text: 'We serve the public with two libraries and a digital archive.' } });
    await approveAll(ids.report2!, round2.body.sections);
    expect((await call('lead', 'POST', `/api/reports/${ids.report2}/approve`)).status).toBe(200);
    const snap = await call('admin', 'POST', `/api/reports/${ids.report2}/snapshot`);
    expect(snap.status).toBe(201);
    const changes = snap.body.manifest.changes as { key: string; chunks: { t: string; s: string }[] }[];
    expect(changes).toHaveLength(1);
    expect(changes[0]!.key).toBe('intro');
    const added = changes[0]!.chunks.filter((c) => c.t === 'add').map((c) => c.s).join(' ');
    expect(added).toContain('digital archive');
  });
});
