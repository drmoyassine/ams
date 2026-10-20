// Dataset evidence (PRD 9.4): a specification with columns; rows saved as versions only when every cell is valid; each
// version keeps the columns it was saved with.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { getDatasetSpec, readVersionData, saveDatasetRows, saveDatasetSpec } from './dataset.js';
import { createEvidence, getEvidence } from './evidence.js';

let w: World;
const ids: Record<string, string> = {};
const columns = [
  { key: 'program', label: 'Program', type: 'text' as const, required: true },
  { key: 'year', label: 'Academic year', type: 'choice' as const, choices: ['2023-24', '2024-25'] },
  { key: 'retention', label: 'Retention', type: 'percent' as const, unit: '%' },
];

beforeAll(async () => {
  w = await buildWorld('datasetsvc');
  ids.data = (await w.as('contrib', (c) => createEvidence(c, { title: 'Fall-to-fall retention', type: 'dataset' }))).id;
  ids.doc = (await w.as('contrib', (c) => createEvidence(c, { title: 'Strategic plan', type: 'document' }))).id;
}, 120000);
afterAll(() => w.close());

describe('dataset evidence', () => {
  it('has a specification with columns, only on dataset items', async () => {
    expect(await w.as('alo', (c) => getDatasetSpec(c, ids.data!))).toMatchObject({ columns: [], sourceKind: 'manual_upload' });
    await expect(w.as('contrib', (c) => getDatasetSpec(c, ids.doc!))).rejects.toThrow(ValidationError);
    await expect(w.as('contrib', (c) => saveDatasetSpec(c, ids.data!, { columns: [{ key: 'y', label: 'Year', type: 'choice' }] }))).rejects.toThrow();
    const spec = await w.as('contrib', (c) => saveDatasetSpec(c, ids.data!, { grain: 'program × year', columns }));
    expect(spec.columns.map((x) => x.key)).toEqual(['program', 'year', 'retention']);
    await expect(w.db.su.query(`insert into dataset_spec (institution_id, evidence_item_id) values ($1, $2)`, [w.ids.inst, ids.doc])).rejects.toThrow(/only dataset evidence/);
  });

  it('refuses a save with any invalid cell and names each one', async () => {
    await expect(w.as('outsider', (c) => saveDatasetRows(c, ids.data!, { rows: [] }))).rejects.toThrow(ForbiddenError);
    const err = await w.as('contrib', (c) => saveDatasetRows(c, ids.data!, { rows: [{ program: 'BSME', year: '2025-26', retention: '82%' }, { program: '', retention: 'high' }] })).catch((e: ValidationError) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues.map((i) => i.path)).toEqual(['rows.0.year', 'rows.1.program', 'rows.1.retention']);
  });

  it('saves valid rows as the next version, with their columns', async () => {
    const v = await w.as('contrib', (c) => saveDatasetRows(c, ids.data!, { rows: [{ program: 'BSME', year: '2024-25', retention: '82%' }, { program: 'هندسة مدنية', year: '2024-25', retention: 79.5 }], notes: 'From the registrar' }));
    expect(v).toMatchObject({ versionNo: 1, rowCount: 2, notes: 'From the registrar' });
    const data = await w.as('alo', (c) => readVersionData(c, v.id));
    expect(data.rows).toEqual([{ program: 'BSME', year: '2024-25', retention: 82 }, { program: 'هندسة مدنية', year: '2024-25', retention: 79.5 }]);
    // Changing the specification later does not change what was saved.
    await w.as('contrib', (c) => saveDatasetSpec(c, ids.data!, { columns: [...columns, { key: 'cohort', label: 'Cohort size', type: 'integer' as const }] }));
    expect((await w.as('alo', (c) => readVersionData(c, v.id))).columns).toHaveLength(3);
    const v2 = await w.as('contrib', (c) => saveDatasetRows(c, ids.data!, { rows: [{ program: 'BSME', year: '2024-25', retention: 83, cohort: '120' }] }));
    expect(v2.versionNo).toBe(2);
    expect((await w.as('alo', (c) => getEvidence(c, ids.data!))).item.latest?.rowCount).toBe(1);
    await expect(w.db.su.query(`update evidence_version set data = '{}' where id = $1`, [v.id])).rejects.toThrow(/kept as they were uploaded/);
  });
});
