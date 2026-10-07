// Forms on data items (DEC-020): the columns are the questions; answers are checked, kept as responses, and join the
// data only when someone adds them; a public link answers the open form without an account.
import { resolveFormLink, withIdentity } from '@ams/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../ctx.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { readVersionData, saveDatasetRows, saveDatasetSpec } from './dataset.js';
import { createEvidence } from './evidence.js';
import {
  addResponsesToData, formByLink, formToAnswer, getDataForm, listDataResponses, newDataFormLink, removeDataFormLink, setDataFormOpen,
  submitByFormLink, submitDataResponse,
} from './forms.js';

let w: World;
const ids: Record<string, string> = {};

async function viaLink<T>(token: string, fn: (ctx: Ctx, itemId: string) => Promise<T>): Promise<T> {
  const found = await resolveFormLink(w.pool, token);
  if (!found) throw new NotFoundError('link');
  const caller = { userId: null, institutionId: found.institutionId, requestId: crypto.randomUUID(), actorType: 'system' as const };
  return withIdentity(w.pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined, store: w.store }, found.itemId));
}

beforeAll(async () => {
  w = await buildWorld('formsvc');
  ids.item = (await w.as('contrib', (c) => createEvidence(c, { title: 'Employer survey', type: 'data' }))).id;
}, 120000);
afterAll(() => w.close());

describe('forms', () => {
  it('opens only once the questions exist', async () => {
    await expect(w.as('contrib', (c) => setDataFormOpen(c, ids.item!, true))).rejects.toThrow(/define the columns first/);
    await w.as('contrib', (c) => saveDatasetSpec(c, ids.item!, { definition: 'How our graduates do at work', columns: [
      { key: 'employer', label: 'Employer', type: 'text', required: true },
      { key: 'rating', label: 'Overall rating', type: 'choice', choices: ['Good', 'Fair', 'Poor'], help: 'Your overall view' },
      { key: 'hires', label: 'Graduates hired', type: 'integer' },
    ] }));
    await w.as('contrib', (c) => saveDatasetRows(c, ids.item!, { rows: [{ employer: 'Aramco', rating: 'Good', hires: '4' }] }));
    await expect(w.as('alo', (c) => formToAnswer(c, ids.item!))).rejects.toThrow(ConflictError);
    await expect(w.as('outsider', (c) => setDataFormOpen(c, ids.item!, true))).rejects.toThrow(ForbiddenError);
    expect(await w.as('contrib', (c) => setDataFormOpen(c, ids.item!, true))).toMatchObject({ open: true, linkToken: null, pending: 0 });
    expect((await w.as('alo', (c) => formToAnswer(c, ids.item!))).columns[1]).toMatchObject({ help: 'Your overall view' });
  });

  it('a signed-in person answers; answers are checked like sheet cells', async () => {
    const err = await w.as('alo', (c) => submitDataResponse(c, ids.item!, { answers: { rating: 'Great', hires: 'some' } })).catch((e: ValidationError) => e);
    expect((err as ValidationError).issues.map((i) => i.path)).toEqual(['answers.employer', 'answers.rating', 'answers.hires']);
    await expect(w.as('alo', (c) => submitDataResponse(c, ids.item!, { answers: {} }))).rejects.toThrow(/at least one/);
    await w.as('alo', (c) => submitDataResponse(c, ids.item!, { answers: { employer: 'SABIC', rating: 'fair', hires: '2', extra: 'x' } }));
    const [r] = await w.as('contrib', (c) => listDataResponses(c, ids.item!));
    expect(r).toMatchObject({ answers: { employer: 'SABIC', rating: 'Fair', hires: 2 }, via: 'ams', submittedByName: 'alo', includedInVersionNo: null });
  });

  it('a public link answers the open form, and stops when turned off or the form closes', async () => {
    const form = await w.as('contrib', (c) => newDataFormLink(c, ids.item!));
    const token = form.linkToken!;
    expect(token.length).toBeGreaterThan(20);
    expect((await w.as('alo', (c) => getDataForm(c, ids.item!))).linkToken).toBe(token); // alo may edit evidence
    expect((await viaLink(token, (c, id) => formByLink(c, id))).institutionName).toBe('Gulf University');
    await viaLink(token, (c, id) => submitByFormLink(c, id, { answers: { employer: 'شركة الكهرباء', rating: 'Good', hires: '١٢' } }));
    await viaLink(token, (c, id) => submitByFormLink(c, id, { answers: { employer: 'NEOM' } }));
    expect((await w.as('contrib', (c) => getDataForm(c, ids.item!))).pending).toBe(3);
    await w.as('contrib', (c) => setDataFormOpen(c, ids.item!, false));
    expect(await resolveFormLink(w.pool, token)).toBeNull();
    await w.as('contrib', (c) => setDataFormOpen(c, ids.item!, true));
    await w.as('contrib', (c) => removeDataFormLink(c, ids.item!));
    expect(await resolveFormLink(w.pool, token)).toBeNull();
  });

  it('responses join the data only when added, as the next version', async () => {
    await expect(w.as('alo', (c) => readVersionData(c, 'x'))).rejects.toThrow();
    const v = await w.as('contrib', (c) => addResponsesToData(c, ids.item!));
    expect(v).toMatchObject({ versionNo: 2, rowCount: 4, notes: 'Added 3 form responses' });
    const data = await w.as('alo', (c) => readVersionData(c, v.id));
    expect(data.rows.map((r) => r.employer)).toEqual(['Aramco', 'SABIC', 'شركة الكهرباء', 'NEOM']);
    expect(data.rows[2]!.hires).toBe(12);
    expect((await w.as('contrib', (c) => listDataResponses(c, ids.item!))).every((r) => r.includedInVersionNo === 2)).toBe(true);
    await expect(w.as('contrib', (c) => addResponsesToData(c, ids.item!))).rejects.toThrow(/no new responses/);
    const { rows } = await w.db.su.query('select id from dataset_response limit 1');
    await expect(w.db.su.query(`update dataset_response set answers = '{}' where id = $1`, [rows[0].id])).rejects.toThrow(/kept as they were given/);
  });
});
