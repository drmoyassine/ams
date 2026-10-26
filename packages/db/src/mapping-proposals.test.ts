// Framework analysis, step E (0044; DEC-006, DEC-021/022/023): the worker proposes links and new quality framework items and
// nothing more. It cannot approve, reject or delete, cannot touch what a person decided, and cannot write the IQF itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const worker = () => ({ userId: ids.user, institutionId: ids.inst, role: 'ams_worker' as const });
const app = () => ({ userId: ids.user, institutionId: ids.inst });

const link = (code: string, over = '') =>
  `insert into requirement_mapping (institution_id, framework_id, external_code, internal_framework_id, internal_code, relation, origin ${over ? `, ${over.split('|')[0]}` : ''})
   values ('${ids.inst}', '${ids.ext}', '${code}', '${ids.iqf}', 'Q1', 'covers', 'ai' ${over ? `, ${over.split('|')[1]}` : ''}) returning id`;

beforeAll(async () => {
  db = await createTestDb('mapping_proposals');
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('V') returning id`);
  ids.user = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'A', 'a@x.org') returning id`, [ids.inst]);
  ids.otherUser = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'B', 'b@x.org') returning id`, [ids.other]);
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'A', 'A', 'institutional') returning id`, [ids.inst]);
  ids.ext = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'F', 'institution') returning id`, [ids.inst, acc]);
  ids.iqf = await one(`insert into framework (institution_id, accreditor_id, name, scope, internal) values ($1, $2, 'IQF', 'institution', true) returning id`, [ids.inst, acc]);
  ids.extV = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, 'A') returning id`, [ids.inst, ids.ext]);
  ids.iqfV = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '1') returning id`, [ids.inst, ids.iqf]);
});
afterAll(() => db.close());

describe('the worker and suggested links (requirement_mapping)', () => {
  it('inserts a link only as a proposal: origin ai, pending, no reviewer', async () => {
    const id = await db.as(worker(), async (c) => (await c.query(link('E1'))).rows[0].id as string);
    expect((await db.su.query(`select origin, review_status, reviewed_by, edited_by_person from requirement_mapping where id = $1`, [id])).rows[0])
      .toEqual({ origin: 'ai', review_status: 'pending', reviewed_by: null, edited_by_person: false });
    await expect(db.as(worker(), (c) => c.query(link('E2', 'review_status|\'approved\'')))).rejects.toThrow(/proposes links only/);
    await expect(db.as(worker(), (c) => c.query(link('E3', 'reviewed_by|\'' + ids.user + '\'')))).rejects.toThrow(/proposes links only/);
    await expect(db.as(worker(), (c) => c.query(
      `insert into requirement_mapping (institution_id, framework_id, external_code, internal_framework_id, internal_code, relation, origin) values ('${ids.inst}', '${ids.ext}', 'E4', '${ids.iqf}', 'Q1', 'covers', 'manual')`)))
      .rejects.toThrow(/proposes links only/);
  });

  it('refreshes the relation and reason of an untouched AI link, and nothing else; never approves, rejects or deletes', async () => {
    const id = await db.as(worker(), async (c) => (await c.query(link('F1'))).rows[0].id as string);
    await db.as(worker(), (c) => c.query(`update requirement_mapping set relation = 'partly_covers', rationale = 'because' where id = $1`, [id]));
    expect((await db.su.query(`select relation, rationale from requirement_mapping where id = $1`, [id])).rows[0]).toEqual({ relation: 'partly_covers', rationale: 'because' });
    for (const sql of [
      `update requirement_mapping set review_status = 'approved' where id = $1`,
      `update requirement_mapping set reviewed_by = '${ids.user}' where id = $1`,
      `update requirement_mapping set origin = 'manual' where id = $1`,
      `update requirement_mapping set internal_code = 'Q2' where id = $1`,
      `delete from requirement_mapping where id = $1`,
    ]) await expect(db.as(worker(), (c) => c.query(sql, [id])), sql).rejects.toThrow(/permission denied/);
  });

  it('leaves a link a person edited, approved or rejected alone', async () => {
    const edited = await db.as(worker(), async (c) => (await c.query(link('G1'))).rows[0].id as string);
    await db.as(app(), (c) => c.query(`update requirement_mapping set relation = 'related' where id = $1`, [edited]));
    expect((await db.su.query(`select edited_by_person from requirement_mapping where id = $1`, [edited])).rows[0].edited_by_person).toBe(true);
    await expect(db.as(worker(), (c) => c.query(`update requirement_mapping set relation = 'covers' where id = $1`, [edited]))).rejects.toThrow(/a person made, edited or reviewed/);

    for (const status of ['approved', 'rejected']) {
      const id = await db.as(worker(), async (c) => (await c.query(link(`H-${status}`))).rows[0].id as string);
      await db.as(app(), (c) => c.query(`update requirement_mapping set review_status = '${status}', reviewed_by = $2, reviewed_at = now() where id = $1`, [id, ids.user]));
      await expect(db.as(worker(), (c) => c.query(`update requirement_mapping set rationale = 'again' where id = $1`, [id])), status).rejects.toThrow(/a person made, edited or reviewed/);
    }
    // A link a person made is theirs too.
    const manual = await one(`insert into requirement_mapping (institution_id, framework_id, external_code, internal_framework_id, internal_code, relation, origin) values ($1, $2, 'M1', $3, 'Q1', 'covers', 'manual') returning id`, [ids.inst, ids.ext, ids.iqf]);
    await expect(db.as(worker(), (c) => c.query(`update requirement_mapping set rationale = 'ai' where id = $1`, [manual]))).rejects.toThrow(/a person made, edited or reviewed/);
  });

  it('is isolated per institution', async () => {
    expect(await db.as({ userId: ids.otherUser, institutionId: ids.other, role: 'ams_worker' }, async (c) => (await c.query(`select id from requirement_mapping`)).rowCount)).toBe(0);
  });
});

describe('the worker and the quality framework itself', () => {
  it('drafts unreviewed AI proposals into the IQF draft like into an external one, and nothing beyond that (TASK-107)', async () => {
    const req = (version: string, code: string, over = '') =>
      `insert into requirement (institution_id, framework_version_id, code, level_label, title, origin ${over ? `, ${over.split('|')[0]}` : ''}) values ('${ids.inst}', '${version}', '${code}', 'Standard', 'T', 'ai' ${over ? `, ${over.split('|')[1]}` : ''})`;
    // The analysis of the IQF's own documents drafts into it, as unreviewed AI rows only.
    await db.as(worker(), (c) => c.query(req(ids.iqfV!, 'X1')));
    // A person's or reviewed row stays out of reach, as anywhere.
    const mine = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, origin) values ($1, $2, 'Q9', 'Standard', 'T', 'ai') returning id`, [ids.inst, ids.iqfV]);
    await db.as(app(), (c) => c.query(`update requirement set title = 'person' where id = $1`, [mine]));
    await expect(db.as(worker(), (c) => c.query(`update requirement set title = 'x' where id = $1`, [mine]))).rejects.toThrow(/a person made, edited or reviewed/);
    await expect(db.as(worker(), (c) => c.query(`update requirement set review_status = 'approved' where id = $1`, [mine]))).rejects.toThrow(/permission denied/);
    // The institution names its own levels (DEC-016): the worker proposes them on the run, never on the version.
    await expect(db.as(worker(), (c) => c.query(`update framework_version set level_labels = '["A"]' where id = $1`, [ids.iqfV]))).rejects.toThrow(/the institution names the levels of its own framework/);
    await expect(db.as(worker(), (c) => c.query(`delete from requirement where id = $1`, [mine]))).rejects.toThrow(/permission denied/);
    // And a published IQF version is immutable, as anywhere.
    const done = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '9') returning id`, [ids.inst, ids.iqf]);
    await db.su.query(`update requirement set review_status = 'approved', reviewed_by = $2, reviewed_at = now() where framework_version_id = $1`, [done, ids.user]);
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [done]);
    await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [done, ids.user]);
    await expect(db.as(worker(), (c) => c.query(req(done, 'X2')))).rejects.toThrow(/immutable|writes only into a draft framework version/);
    // An external draft is still the worker's to draft into.
    await db.as(worker(), (c) => c.query(req(ids.extV!, 'E1')));
  });

  it('a person-accepted AI item in the IQF publishes without a source page once approved; an external AI item still needs one', async () => {
    const draft = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2') returning id`, [ids.inst, ids.iqf]);
    await db.as(app(), (c) => c.query(`insert into requirement (institution_id, framework_version_id, code, level_label, title, origin, review_status) values ($1, $2, 'N1', 'Standard', 'T', 'ai', 'pending')`, [ids.inst, draft]));
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [draft]);
    const publish = () => db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [draft, ids.user]);
    await expect(publish()).rejects.toThrow(/not approved/); // the IQF's own rule stands
    await db.su.query(`update requirement set review_status = 'approved' where framework_version_id = $1`, [draft]);
    await publish();

    const ext = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, 'B') returning id`, [ids.inst, ids.ext]);
    await db.su.query(`insert into requirement (institution_id, framework_version_id, code, level_label, title, origin) values ($1, $2, 'A1', 'Standard', 'T', 'ai')`, [ids.inst, ext]);
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ext]);
    await expect(db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [ext, ids.user])).rejects.toThrow(/lack a source reference/);
  });
});

describe('suggested new IQF items (iqf_item_proposal)', () => {
  const propose = (code: string, extra = '') =>
    `insert into iqf_item_proposal (institution_id, framework_id, framework_version_id, internal_framework_id, level_label, code, title, links ${extra ? `, ${extra.split('|')[0]}` : ''})
     values ('${ids.inst}', '${ids.ext}', '${ids.extV}', '${ids.iqf}', 'Standard', '${code}', 'T', '[]' ${extra ? `, ${extra.split('|')[1]}` : ''}) returning id`;

  it('the worker proposes pending items, refreshes them while pending, and can mark them superseded', async () => {
    const id = await db.as(worker(), async (c) => (await c.query(propose('P1'))).rows[0].id as string);
    await db.as(worker(), (c) => c.query(`update iqf_item_proposal set title = 'better', description = 'words', links = '[{"externalCode":"E1","relation":"covers","reason":null}]' where id = $1`, [id]));
    await db.as(worker(), (c) => c.query(`update iqf_item_proposal set status = 'superseded' where id = $1`, [id]));
    expect((await db.su.query(`select status, title from iqf_item_proposal where id = $1`, [id])).rows[0]).toEqual({ status: 'superseded', title: 'better' });
  });

  it('the worker cannot accept, dismiss, decide or delete, and cannot touch a decided proposal', async () => {
    await expect(db.as(worker(), (c) => c.query(propose('P2', 'status|\'accepted\'')))).rejects.toThrow(/cannot accept or dismiss/);
    await expect(db.as(worker(), (c) => c.query(propose('P3', `decided_by|'${ids.user}'`)))).rejects.toThrow(/cannot accept or dismiss/);
    const id = await db.as(worker(), async (c) => (await c.query(propose('P4'))).rows[0].id as string);
    await expect(db.as(worker(), (c) => c.query(`update iqf_item_proposal set status = 'accepted' where id = $1`, [id]))).rejects.toThrow(/cannot accept or dismiss/);
    await expect(db.as(worker(), (c) => c.query(`update iqf_item_proposal set status = 'dismissed' where id = $1`, [id]))).rejects.toThrow(/cannot accept or dismiss/);
    await expect(db.as(worker(), (c) => c.query(`update iqf_item_proposal set decided_by = $2 where id = $1`, [id, ids.user]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`delete from iqf_item_proposal where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await db.as(app(), (c) => c.query(`update iqf_item_proposal set status = 'dismissed', decided_by = $2, decided_at = now() where id = $1`, [id, ids.user]));
    await expect(db.as(worker(), (c) => c.query(`update iqf_item_proposal set title = 'again' where id = $1`, [id]))).rejects.toThrow(/a person decided this proposal/);
  });

  it('is from an external standard onto the quality framework, and isolated per institution', async () => {
    await expect(db.su.query(
      `insert into iqf_item_proposal (institution_id, framework_id, framework_version_id, internal_framework_id, level_label, code, title) values ($1, $2, $3, $2, 'S', 'Z', 'T')`, [ids.inst, ids.iqf, ids.iqfV]))
      .resolves.toBeDefined(); // the owner is not bound by the worker's guard; the worker is:
    await expect(db.as(worker(), (c) => c.query(
      `insert into iqf_item_proposal (institution_id, framework_id, framework_version_id, internal_framework_id, level_label, code, title) values ('${ids.inst}', '${ids.iqf}', '${ids.iqfV}', '${ids.iqf}', 'S', 'Z2', 'T')`)))
      .rejects.toThrow(/from an external standard onto the quality framework/);
    expect(await db.as({ userId: ids.otherUser, institutionId: ids.other }, async (c) => (await c.query(`select id from iqf_item_proposal`)).rowCount)).toBe(0);
    await expect(db.su.query(`update iqf_item_proposal set status = 'bogus' where code = 'Z'`)).rejects.toThrow(/iqf_item_proposal_status_check/);
  });
});
