// evidence_link (migration 0058): a link may target a requirement of any standard by (framework, code), on a PUBLISHED version
// too (the link lives outside the frozen tables); it still has exactly one target, belongs to its institution, and its evidence
// and target cannot change afterwards.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
let pool: pg.Pool;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const app = () => ({ userId: ids.user, institutionId: ids.inst });
const link = (fw: string | null, code: string | null, er: string | null = null) =>
  `insert into evidence_link (institution_id, evidence_version_id, internal_framework_id, internal_code, engagement_requirement_id, rationale) values ('${ids.inst}', '${ids.ev}', ${fw ? `'${fw}'` : 'null'}, ${code ? `'${code}'` : 'null'}, ${er ? `'${er}'` : 'null'}, 'because') returning id`;

beforeAll(async () => {
  db = await createTestDb('evidencelinktargets');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('V') returning id`);
  ids.user = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'A', 'a@x.org') returning id`, [ids.inst]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.inst, ids.user]);
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'A', 'A', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'F', 'institution') returning id`, [ids.inst, acc]);
  ids.version = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2027') returning id`, [ids.inst, ids.fw]);
  await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, review_status) values ($1, $2, '1.2', 'Standard', 'T', 'approved') returning id`, [ids.inst, ids.version]);
  await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ids.version]);
  await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [ids.version, ids.user]);
  const item = await one(`insert into evidence_item (institution_id, title, type, owner_user_id) values ($1, 'E', 'document', $2) returning id`, [ids.inst, ids.user]);
  ids.ev = await one(`insert into evidence_version (institution_id, evidence_item_id, version_no, url) values ($1, $2, 1, 'https://x.example/e') returning id`, [ids.inst, item]);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('evidence links to a standard that is not the institution\'s own', () => {
  it('may target an external framework by code, also after its version is published, and then cannot be retargeted', async () => {
    const id = (await db.as(app(), (c) => c.query(link(ids.fw!, '1.2')))).rows[0].id as string;
    expect((await db.su.query(`select count(*)::int as n from evidence_link where internal_framework_id = $1 and internal_code = '1.2'`, [ids.fw])).rows[0].n).toBe(1);
    await expect(db.su.query(`update evidence_link set internal_code = '1.3' where id = $1`, [id])).rejects.toThrow(/cannot change/);
    await expect(db.su.query(`update evidence_link set internal_framework_id = null where id = $1`, [id])).rejects.toThrow();
    // Review state may change (the link itself is not frozen).
    await db.su.query(`update evidence_link set review_status = 'approved' where id = $1`, [id]);
  });

  it('still has exactly one target', async () => {
    await expect(db.su.query(link(null, null))).rejects.toThrow(/one_target/);
    await expect(db.su.query(link(ids.fw!, null))).rejects.toThrow(/one_target/);
  });

  it('is isolated per institution', async () => {
    const other = { userId: ids.user, institutionId: ids.other };
    expect((await db.as(other, (c) => c.query(`select id from evidence_link`))).rows).toEqual([]);
    await expect(db.as(other, (c) => c.query(link(ids.fw!, '1.2')))).rejects.toThrow();
  });
});
