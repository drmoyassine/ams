// ai_setting and embedding: tenant isolation, privileges, and the rule that only framework text can be embedded (DEC-023).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const vec = (n: number) => `{${Array.from({ length: n }, (_, i) => i / 10).join(',')}}`;

beforeAll(async () => {
  db = await createTestDb('ai');
  ids.a = await one(`insert into institution (name_en) values ('A') returning id`);
  ids.b = await one(`insert into institution (name_en) values ('B') returning id`);
  ids.userA = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'a', 'a@x.org') returning id`, [ids.a]);
  ids.owner = crypto.randomUUID();
});
afterAll(() => db.close());

describe('ai_setting', () => {
  it('is one row per institution, isolated by RLS, and read-only for the worker', async () => {
    await db.su.query(`insert into ai_setting (institution_id, model) values ($1, 'm-a'), ($2, 'm-b')`, [ids.a, ids.b]);
    await expect(db.su.query(`insert into ai_setting (institution_id) values ($1)`, [ids.a])).rejects.toThrow(/duplicate key/);
    const seen = await db.as({ userId: ids.userA, institutionId: ids.a }, async (c) => (await c.query(`select model from ai_setting`)).rows);
    expect(seen).toEqual([{ model: 'm-a' }]);
    await db.as({ userId: ids.userA, institutionId: ids.a, role: 'ams_worker' }, async (c) => {
      expect((await c.query(`select model from ai_setting`)).rowCount).toBe(1);
      await expect(c.query(`update ai_setting set model = 'x'`)).rejects.toThrow(/permission denied/);
    });
  });

  it('refuses non-positive limits', async () => {
    await expect(db.su.query(`update ai_setting set max_tokens_per_run = 0 where institution_id = $1`, [ids.a])).rejects.toThrow(/ai_setting_limits_check/);
  });
});

describe('embedding', () => {
  it('accepts a requirement vector and rejects any other owner type', async () => {
    await db.su.query(`insert into embedding (institution_id, owner_type, owner_id, model, dimension, text_hash, vector) values ($1, 'requirement', $2, 'm', 4, 'h', $3)`, [ids.a, ids.owner, vec(4)]);
    for (const type of ['evidence', 'dataset', 'response', 'request', 'letter']) {
      await expect(db.su.query(`insert into embedding (institution_id, owner_type, owner_id, model, dimension, text_hash, vector) values ($1, $2, $3, 'm', 4, 'h', $4)`, [ids.a, type, crypto.randomUUID(), vec(4)]))
        .rejects.toThrow(/embedding_owner_type_check/);
    }
  });

  it('is unique per owner and model, and the vector must have the stated dimension', async () => {
    await expect(db.su.query(`insert into embedding (institution_id, owner_type, owner_id, model, dimension, text_hash, vector) values ($1, 'requirement', $2, 'm', 4, 'h', $3)`, [ids.a, ids.owner, vec(4)]))
      .rejects.toThrow(/duplicate key/);
    await expect(db.su.query(`insert into embedding (institution_id, owner_type, owner_id, model, dimension, text_hash, vector) values ($1, 'requirement', $2, 'm2', 4, 'h', $3)`, [ids.a, ids.owner, vec(3)]))
      .rejects.toThrow(/embedding_dimension_check/);
  });

  it('is invisible to another institution and cannot be written into one', async () => {
    const other = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'b', 'b@x.org') returning id`, [ids.b]);
    expect(await db.as({ userId: other, institutionId: ids.b }, async (c) => (await c.query(`select id from embedding`)).rowCount)).toBe(0);
    await db.as({ userId: other, institutionId: ids.b }, async (c) => {
      await expect(c.query(`insert into embedding (institution_id, owner_type, owner_id, model, dimension, text_hash, vector) values ($1, 'requirement', $2, 'm', 4, 'h', $3)`, [ids.a, crypto.randomUUID(), vec(4)]))
        .rejects.toThrow(/row-level security/);
    });
    expect(await db.as({ userId: ids.userA, institutionId: ids.a }, async (c) => (await c.query(`select id from embedding`)).rowCount)).toBe(1);
  });

  it('can be written by the worker (derived data)', async () => {
    await db.as({ userId: ids.userA, institutionId: ids.a, role: 'ams_worker' }, async (c) => {
      await c.query(`insert into embedding (institution_id, owner_type, owner_id, model, dimension, text_hash, vector) values ($1, 'requirement', $2, 'm', 4, 'h', $3)`, [ids.a, crypto.randomUUID(), vec(4)]);
    });
  });
});
