// The evidence item's schemas (TASK-089, DEC-031): the settings of each collection method, the schedule, and the create and update inputs.
import { describe, expect, it } from 'vitest';
import { checkMethod, CreateEvidenceSchema, EVIDENCE_METHODS, EVIDENCE_TYPES, isTimeZone, ScheduleSchema, SELECTABLE_EVIDENCE_METHODS, UpdateEvidenceSchema } from './index.js';

const UUID = '3f2b8c1e-9d4a-4b6e-8a1f-2c7d5e9b0a11';

describe('the vocabulary', () => {
  it('has the types document and dataset (not data), and five methods of which survey is reserved', () => {
    expect([...EVIDENCE_TYPES]).toEqual(['document', 'dataset']);
    expect([...EVIDENCE_METHODS]).toEqual(['manual', 'form', 'request', 'bi', 'survey']);
    expect([...SELECTABLE_EVIDENCE_METHODS]).toEqual(['manual', 'form', 'request', 'bi']);
  });
});

describe('checkMethod', () => {
  it('manual takes instructions and an expected format only', () => {
    expect(checkMethod('manual', 'document', { instructions: ' Upload it ', expectedFormat: 'PDF' })).toEqual({ config: { instructions: 'Upload it', expectedFormat: 'PDF' }, issues: [] });
    expect(checkMethod('manual', 'document', {}).issues).toEqual([]);
    expect(checkMethod('manual', 'document', undefined).issues).toEqual([]);
    expect(checkMethod('manual', 'document', { url: 'https://x.org' }).issues[0]?.path).toBe('methodConfig');
  });

  it('form needs a dataset and takes no settings', () => {
    expect(checkMethod('form', 'dataset', {}).issues).toEqual([]);
    expect(checkMethod('form', 'document', {}).issues).toEqual([expect.objectContaining({ path: 'method' })]);
    expect(checkMethod('form', 'dataset', { a: 1 }).issues).not.toEqual([]);
  });

  it('request names exactly one person or one address', () => {
    expect(checkMethod('request', 'document', { assigneeUserId: UUID }).issues).toEqual([]);
    expect(checkMethod('request', 'document', { assigneeEmail: ' Dean@Example.ORG ' }).config).toEqual({ assigneeEmail: 'dean@example.org' });
    expect(checkMethod('request', 'document', {}).issues[0]?.message).toMatch(/one person or one email/);
    expect(checkMethod('request', 'document', { assigneeUserId: UUID, assigneeEmail: 'a@b.org' }).issues[0]?.message).toMatch(/one person or one email/);
    expect(checkMethod('request', 'document', { assigneeUserId: 'not-a-uuid' }).issues).not.toEqual([]);
    expect(checkMethod('request', 'document', { assigneeEmail: 'nope' }).issues).not.toEqual([]);
  });

  it('bi takes an endpoint name, a structured query, a period and a timeout, for either type', () => {
    const ok = { endpointKey: 'warehouse-1', query: { metric: 'enrollment_headcount', dimensions: ['program'], filters: [{ field: 'level', op: 'in', value: ['bachelor', 'master'] }] }, period: 'year', timeoutSeconds: 90 };
    expect(checkMethod('bi', 'dataset', ok)).toEqual({ config: ok, issues: [] });
    expect(checkMethod('bi', 'document', {}).issues).toEqual([]);
    for (const bad of [
      { endpointKey: 'https://bi.example.org' }, { endpointKey: 'a/b' }, { endpointKey: '1abc' }, { endpointKey: 'x'.repeat(65) },
      { query: 'select 1' }, { query: { metric: 'drop table x' } }, { query: { metric: 'm', sql: 'select 1' } }, { query: { metric: 'm', filters: [{ field: 'f', op: 'like', value: 1 }] } },
      { period: 'decade' }, { timeoutSeconds: 0 }, { timeoutSeconds: 601 }, { timeoutSeconds: 1.5 }, { address: 'x' },
    ]) expect(checkMethod('bi', 'dataset', bad).issues, JSON.stringify(bad)).not.toEqual([]);
  });

  it('survey takes no settings', () => {
    expect(checkMethod('survey', 'document', {}).issues).toEqual([]);
    expect(checkMethod('survey', 'document', { questions: [] }).issues).not.toEqual([]);
  });
});

describe('ScheduleSchema', () => {
  const ok = { every: 'month', startDate: '2026-01-15', dueAfterDays: 10, timezone: 'Asia/Dubai' };
  it('accepts every kind of period and a real time zone', () => {
    for (const every of ['day', 'week', 'month', 'quarter', 'semester', 'year']) expect(ScheduleSchema.safeParse({ ...ok, every }).success, every).toBe(true);
    expect(isTimeZone('Europe/London')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
  });
  it('refuses what cannot be a schedule', () => {
    for (const bad of [
      { ...ok, every: 'fortnight' }, { ...ok, startDate: '2026-02-30' }, { ...ok, startDate: '15/01/2026' }, { ...ok, dueAfterDays: -1 }, { ...ok, dueAfterDays: 2.5 },
      { ...ok, dueAfterDays: 4000 }, { ...ok, timezone: 'Mars/Olympus' }, { ...ok, timezone: '' }, { every: 'month', startDate: '2026-01-15' }, { ...ok, extra: 1 },
    ]) expect(ScheduleSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('the create and update inputs', () => {
  it('create defaults to manual, no settings and no schedule, and has no description', () => {
    expect(CreateEvidenceSchema.parse({ title: 'Plan', type: 'document' })).toMatchObject({ method: 'manual', methodConfig: {}, confidentiality: 'internal', tags: [] });
    expect(CreateEvidenceSchema.safeParse({ title: 'Plan', type: 'document', description: 'x' }).success).toBe(false);
    expect(CreateEvidenceSchema.safeParse({ title: 'Plan', type: 'data' }).success).toBe(false);
    expect(CreateEvidenceSchema.safeParse({ title: 'Plan', type: 'dataset', definition: 'What it means', ownerUserId: UUID }).success).toBe(true);
  });
  it('create refuses a form on a document and settings that do not fit the method', () => {
    expect(CreateEvidenceSchema.safeParse({ title: 'x', type: 'document', method: 'form' }).success).toBe(false);
    expect(CreateEvidenceSchema.safeParse({ title: 'x', type: 'dataset', method: 'form' }).success).toBe(true);
    expect(CreateEvidenceSchema.safeParse({ title: 'x', type: 'document', method: 'request' }).success).toBe(false);
    expect(CreateEvidenceSchema.safeParse({ title: 'x', type: 'document', method: 'survey' }).success).toBe(true);
  });
  it('update takes the new fields; the settings are checked with the method when both are sent', () => {
    expect(UpdateEvidenceSchema.safeParse({ definition: null, schedule: null, method: 'manual', methodConfig: { instructions: 'x' } }).success).toBe(true);
    expect(UpdateEvidenceSchema.safeParse({ method: 'request', methodConfig: {} }).success).toBe(false);
    expect(UpdateEvidenceSchema.safeParse({ description: 'old' }).success).toBe(false);
    expect(UpdateEvidenceSchema.safeParse({ type: 'data' }).success).toBe(false);
  });
});
