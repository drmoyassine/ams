// The evidence schema (TASK-089, DEC-031): title, type (document | dataset), definition, ONE collection method with settings per method,
// and an optional schedule whose next due date the service keeps. Nothing runs from a schedule yet (TASK-090).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ValidationError } from '../ctx.js';
import { createAcademicTerm } from '../cycles/calendar.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { saveDatasetSpec } from './dataset.js';
import { createEvidence, getEvidence, listEvidence, updateEvidence } from './evidence.js';
import { formToAnswer, setDataFormOpen } from './forms.js';

let w: World;
const ids: Record<string, string> = {};
const issues = (e: unknown) => ((e as ValidationError).issues ?? []).map((i) => i.path);

beforeAll(async () => { w = await buildWorld('evidenceschema'); }, 120000);
afterAll(() => w.close());

describe('an item: title, type, definition, owner, method, schedule', () => {
  it('has a definition (no description), a type document | dataset, and collects manually with no schedule by default', async () => {
    const item = await w.as('contrib', (c) => createEvidence(c, { title: 'Strategic plan', type: 'document', definition: 'The current approved plan' }));
    ids.doc = item.id;
    expect(item).toMatchObject({
      title: 'Strategic plan', type: 'document', definition: 'The current approved plan', method: 'manual', methodConfig: {}, schedule: null,
      nextDueAt: null, lastRunAt: null, scheduleGap: null, ownerUserId: w.ids.contrib, ownerName: 'contrib',
    });
    expect(Object.keys(item)).not.toContain('description');
    ids.dataset = (await w.as('contrib', (c) => createEvidence(c, { title: 'Retention', type: 'dataset', definition: 'First-time students still enrolled a year later' }))).id;
    expect((await w.as('alo', (c) => listEvidence(c))).find((e) => e.id === ids.dataset)).toMatchObject({ type: 'dataset', definition: 'First-time students still enrolled a year later', method: 'manual' });
    // The old names are refused.
    await expect(w.as('contrib', (c) => createEvidence(c, { title: 'x', type: 'data' as 'dataset' }))).rejects.toThrow();
    await expect(w.as('contrib', (c) => createEvidence(c, { title: 'x', type: 'document', description: 'x' } as never))).rejects.toThrow();
  });

  it('names an owner, defaulting to the person who adds it', async () => {
    const item = await w.as('contrib', (c) => createEvidence(c, { title: 'Owned elsewhere', type: 'document', ownerUserId: w.ids.alo! }));
    expect(item).toMatchObject({ ownerUserId: w.ids.alo, ownerName: 'alo' });
    expect(await w.as('contrib', (c) => updateEvidence(c, item.id, { ownerUserId: w.ids.coord! }))).toMatchObject({ ownerName: 'coord' });
    expect(await w.as('contrib', (c) => updateEvidence(c, item.id, { ownerUserId: null }))).toMatchObject({ ownerUserId: null, ownerName: null });
    // An owner of another institution is refused by the database.
    const other = (await w.db.su.query(`insert into institution (name_en) values ('Other') returning id`)).rows[0].id as string;
    const stranger = (await w.db.su.query(`insert into app_user (institution_id, full_name, email) values ($1, 'stranger', 'stranger@y.org') returning id`, [other])).rows[0].id as string;
    await expect(w.as('contrib', (c) => updateEvidence(c, item.id, { ownerUserId: stranger }))).rejects.toThrow(/same institution/);
  });

  it('merges nothing silently: an empty definition is stored as none', async () => {
    const item = await w.as('contrib', (c) => createEvidence(c, { title: 'No words', type: 'document', definition: '' }));
    expect(item.definition).toBeNull();
    expect(await w.as('contrib', (c) => updateEvidence(c, item.id, { definition: 'Some words' }))).toMatchObject({ definition: 'Some words' });
    expect(await w.as('contrib', (c) => updateEvidence(c, item.id, { definition: '' }))).toMatchObject({ definition: null });
  });

  it('a dataset\'s form shows the item\'s definition (the specification no longer has its own)', async () => {
    await w.as('contrib', (c) => saveDatasetSpec(c, ids.dataset!, { grain: 'program × year', columns: [{ key: 'n', label: 'Headcount', type: 'integer', required: true }] }));
    await w.as('contrib', (c) => setDataFormOpen(c, ids.dataset!, true));
    expect(await w.as('alo', (c) => formToAnswer(c, ids.dataset!))).toMatchObject({ title: 'Retention', definition: 'First-time students still enrolled a year later' });
    await w.as('contrib', (c) => updateEvidence(c, ids.dataset!, { definition: 'Retention after one year' }));
    expect((await w.as('alo', (c) => formToAnswer(c, ids.dataset!))).definition).toBe('Retention after one year');
  });
});

describe('the collection method and its settings', () => {
  it('manual takes instructions and an expected format, and nothing else', async () => {
    const item = await w.as('contrib', (c) => createEvidence(c, { title: 'Manual', type: 'document', method: 'manual', methodConfig: { instructions: 'Upload the signed PDF', expectedFormat: 'PDF' } }));
    expect(item).toMatchObject({ method: 'manual', methodConfig: { instructions: 'Upload the signed PDF', expectedFormat: 'PDF' } });
    await expect(w.as('contrib', (c) => createEvidence(c, { title: 'Manual', type: 'document', methodConfig: { url: 'https://x.org' } }))).rejects.toThrow();
  });

  it('form needs a dataset and takes no settings', async () => {
    const item = await w.as('contrib', (c) => createEvidence(c, { title: 'Form dataset', type: 'dataset', method: 'form' }));
    expect(item).toMatchObject({ method: 'form', methodConfig: {} });
    await expect(w.as('contrib', (c) => createEvidence(c, { title: 'Form doc', type: 'document', method: 'form' }))).rejects.toThrow(/online form collects a dataset/);
    await expect(w.as('contrib', (c) => createEvidence(c, { title: 'Form', type: 'dataset', method: 'form', methodConfig: { x: 1 } }))).rejects.toThrow();
    // The database says the same, whatever the service does.
    await expect(w.db.su.query(`update evidence_item set method = 'form' where id = $1`, [ids.doc])).rejects.toThrow(/evidence_item_form_dataset_check/);
  });

  it('request names exactly one person or one email address, a person of this institution', async () => {
    const byUser = await w.as('contrib', (c) => createEvidence(c, { title: 'By person', type: 'document', method: 'request', methodConfig: { assigneeUserId: w.ids.coord!, note: 'Every term, please' } }));
    expect(byUser.methodConfig).toEqual({ assigneeUserId: w.ids.coord, note: 'Every term, please' });
    const byMail = await w.as('contrib', (c) => createEvidence(c, { title: 'By email', type: 'document', method: 'request', methodConfig: { assigneeEmail: ' Dean@Example.ORG ' } }));
    expect(byMail.methodConfig).toEqual({ assigneeEmail: 'dean@example.org' });
    await expect(w.as('contrib', (c) => createEvidence(c, { title: 'None', type: 'document', method: 'request' }))).rejects.toThrow(/one person or one email/);
    await expect(w.as('contrib', (c) => createEvidence(c, { title: 'Both', type: 'document', method: 'request', methodConfig: { assigneeUserId: w.ids.coord!, assigneeEmail: 'a@b.org' } }))).rejects.toThrow(/one person or one email/);
    await expect(w.as('contrib', (c) => createEvidence(c, { title: 'Bad mail', type: 'document', method: 'request', methodConfig: { assigneeEmail: 'not-an-address' } }))).rejects.toThrow();
    const stranger = (await w.db.su.query(`select id from app_user where email = 'stranger@y.org'`)).rows[0].id as string;
    await expect(w.as('contrib', (c) => createEvidence(c, { title: 'Stranger', type: 'document', method: 'request', methodConfig: { assigneeUserId: stranger } }))).rejects.toThrow(ConflictError);
  });

  it('bi takes an endpoint NAME, a structured query, a period grain and a timeout; never an address or SQL', async () => {
    const good = { endpointKey: 'warehouse-1', query: { metric: 'enrollment_headcount', dimensions: ['program', 'level'], filters: [{ field: 'level', op: 'in', value: ['bachelor', 'master'] }] }, period: 'year', timeoutSeconds: 120 } as const;
    const item = await w.as('contrib', (c) => createEvidence(c, { title: 'From BI', type: 'dataset', method: 'bi', methodConfig: good }));
    expect(item).toMatchObject({ method: 'bi', methodConfig: good });
    // A BI item may also be a document (a dataset is recommended).
    expect((await w.as('contrib', (c) => createEvidence(c, { title: 'BI doc', type: 'document', method: 'bi' }))).method).toBe('bi');
    for (const bad of [
      { endpointKey: 'https://bi.example.org/api' }, { endpointKey: 'a/b' }, { endpointKey: '10.0.0.1' },
      { query: 'select * from students' }, { query: { metric: 'select * from students' } }, { query: { metric: 'x', sql: 'select 1' } },
      { query: { metric: 'x', filters: [{ field: 'level', op: 'like', value: 'a' }] } }, { period: 'decade' }, { timeoutSeconds: 0 }, { timeoutSeconds: 100000 }, { url: 'https://x' },
    ]) {
      await expect(w.as('contrib', (c) => createEvidence(c, { title: 'Bad BI', type: 'dataset', method: 'bi', methodConfig: bad })), JSON.stringify(bad)).rejects.toThrow();
    }
    await expect(w.db.su.query(`update evidence_item set method = 'bi', method_config = '{"endpointKey":"http://x"}' where id = $1`, [ids.doc])).rejects.toThrow(/evidence_item_bi_check/);
  });

  it('survey is accepted (reserved) and takes no settings', async () => {
    expect(await w.as('contrib', (c) => createEvidence(c, { title: 'Survey', type: 'document', method: 'survey' }))).toMatchObject({ method: 'survey', methodConfig: {} });
    await expect(w.as('contrib', (c) => createEvidence(c, { title: 'Survey', type: 'document', method: 'survey', methodConfig: { questions: [] } }))).rejects.toThrow();
    await expect(w.as('contrib', (c) => createEvidence(c, { title: 'Nope', type: 'document', method: 'carrier-pigeon' as 'manual' }))).rejects.toThrow();
  });

  it('changing the method clears the old settings; settings alone are checked against the current method', async () => {
    const item = await w.as('contrib', (c) => createEvidence(c, { title: 'Switching', type: 'dataset', method: 'request', methodConfig: { assigneeEmail: 'a@b.org' } }));
    const manual = await w.as('contrib', (c) => updateEvidence(c, item.id, { method: 'manual' }));
    expect(manual).toMatchObject({ method: 'manual', methodConfig: {} });
    // Back to request without saying who: refused, naming the field.
    const err = await w.as('contrib', (c) => updateEvidence(c, item.id, { method: 'request' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(issues(err)).toEqual(['methodConfig']);
    expect(await w.as('contrib', (c) => updateEvidence(c, item.id, { methodConfig: { instructions: 'Type it in' } }))).toMatchObject({ method: 'manual', methodConfig: { instructions: 'Type it in' } });
    await expect(w.as('contrib', (c) => updateEvidence(c, item.id, { methodConfig: { assigneeEmail: 'a@b.org' } }))).rejects.toThrow(ValidationError);
    expect(await w.as('contrib', (c) => updateEvidence(c, item.id, { method: 'form' }))).toMatchObject({ method: 'form', methodConfig: {} });
  });

  it('a dataset collected by its form cannot become a document until another method is chosen', async () => {
    const item = await w.as('contrib', (c) => createEvidence(c, { title: 'Form then document', type: 'dataset', method: 'form' }));
    await expect(w.as('contrib', (c) => updateEvidence(c, item.id, { type: 'document' }))).rejects.toThrow(/online form, which belongs to a dataset/);
    expect(await w.as('contrib', (c) => updateEvidence(c, item.id, { type: 'document', method: 'manual' }))).toMatchObject({ type: 'document', method: 'manual' });
  });
});

describe('the schedule', () => {
  const monthly = { every: 'month', startDate: '2026-01-15', dueAfterDays: 10, timezone: 'Asia/Dubai' } as const;

  it('is optional; setting one keeps the next due date, clearing it removes it', async () => {
    const item = await w.as('contrib', (c) => createEvidence(c, { title: 'Monthly', type: 'document', schedule: monthly }));
    expect(item.schedule).toEqual(monthly);
    expect(item.nextDueAt).not.toBeNull();
    expect(new Date(item.nextDueAt!).getTime()).toBeGreaterThan(Date.now());
    expect(item.lastRunAt).toBeNull();
    const cleared = await w.as('contrib', (c) => updateEvidence(c, item.id, { schedule: null }));
    expect(cleared).toMatchObject({ schedule: null, nextDueAt: null });
    const again = await w.as('contrib', (c) => updateEvidence(c, item.id, { schedule: { ...monthly, every: 'week' } }));
    expect(again.schedule?.every).toBe('week');
    expect(again.nextDueAt).not.toBeNull();
    // Other edits leave the schedule alone.
    expect(await w.as('contrib', (c) => updateEvidence(c, item.id, { title: 'Weekly' }))).toMatchObject({ schedule: { every: 'week' }, nextDueAt: again.nextDueAt });
  });

  it('is checked: every, start date, due after, time zone', async () => {
    for (const bad of [
      { ...monthly, every: 'fortnight' }, { ...monthly, startDate: '2026-02-30' }, { ...monthly, startDate: 'soon' }, { ...monthly, dueAfterDays: -1 },
      { ...monthly, dueAfterDays: 1.5 }, { ...monthly, dueAfterDays: 99999 }, { ...monthly, timezone: 'Mars/Olympus' }, { ...monthly, timezone: '' }, { every: 'month', startDate: '2026-01-15' },
      { ...monthly, extra: true },
    ]) {
      await expect(w.as('contrib', (c) => createEvidence(c, { title: 'Bad schedule', type: 'document', schedule: bad as never })), JSON.stringify(bad)).rejects.toThrow();
    }
    await expect(w.db.su.query(`update evidence_item set schedule = '{"every":"month","startDate":"2026-01-15","dueAfterDays":-3,"timezone":"UTC"}' where id = $1`, [ids.doc])).rejects.toThrow(/evidence_item_schedule_check/);
    await expect(w.db.su.query(`update evidence_item set schedule = '{"every":"decade","startDate":"2026-01-15","dueAfterDays":3,"timezone":"UTC"}' where id = $1`, [ids.doc])).rejects.toThrow(/evidence_item_schedule_check/);
  });

  it('a semester schedule is placed by the academic calendar; with no term it flags a gap and has no due date', async () => {
    const sem = { every: 'semester', startDate: '2026-01-01', dueAfterDays: 14, timezone: 'UTC' } as const;
    const item = await w.as('contrib', (c) => createEvidence(c, { title: 'Each semester', type: 'document', schedule: sem }));
    expect(item).toMatchObject({ nextDueAt: null, scheduleGap: 'no_term' });
    expect((await w.as('alo', (c) => listEvidence(c))).find((e) => e.id === item.id)?.scheduleGap).toBe('no_term');
    // A term in the calendar closes the gap (the list reads the calendar live); saving the item brings its due date.
    const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 150 * 86_400_000).toISOString().slice(0, 10);
    await w.as('admin', (c) => createAcademicTerm(c, { name: 'Next term', kind: 'term', startDate: future, endDate: end }));
    expect((await w.as('alo', (c) => getEvidence(c, item.id))).item.scheduleGap).toBeNull();
    const saved = await w.as('contrib', (c) => updateEvidence(c, item.id, { schedule: sem }));
    expect(saved.scheduleGap).toBeNull();
    expect(saved.nextDueAt).toBe(new Date(Date.parse(`${future}T00:00:00Z`) + 15 * 86_400_000).toISOString());
  });
});
