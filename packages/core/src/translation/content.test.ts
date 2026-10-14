// The IQF and external standards in the secondary language end to end with a fake model (TASK-071): the job for both kinds, stale
// detection by source hash, a person's text and reviewed rows being safe, unofficial standards, published (frozen) versions
// still accepting translations without changing the English, the review table, permissions. No network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentTranslationKey, type JobEnvelope, type JobType } from '@ams/shared';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Ctx, type JobQueue } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createFakeAiModel, setAiModelForTests } from '../ai/index.js';
import { addNote } from '../framework/notes.js';
import { addQualityItem, editQualityItem, setUpQualityFramework } from '../framework/internal.js';
import { handlers } from '../jobs/handlers.js';
import { runJob } from '../jobs/run.js';
import {
  cancelContentTranslation, contentTranslationMap, contentTranslationStatus, listContentTranslations, markContentReviewed, resumeContentTranslation, saveContentTranslation,
  startContentTranslation, startTranslation,
} from './index.js';

let w: World;
let iqf: string;
let iqfItems: { std: string; sub: string };
const sent: (JobEnvelope & { type: JobType })[] = [];
const queue: JobQueue = { send: async (type, e) => { sent.push({ ...e, type }); } };
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); } }));
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;
async function drain(max = 300) {
  let n = 0;
  while (sent.length && n++ < max) {
    const { type, ...env } = sent.shift()!;
    await runJob(w.pool, type, env, handlers, { store: w.store, queue });
  }
}
function asked(options: unknown): { items: { id: string; text: string; context?: string }[]; text: string } {
  const prompt = (options as { prompt: { role: string; content: string | { type: string; text?: string }[] }[] }).prompt;
  const user = prompt.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join(''))).join('\n');
  return { items: JSON.parse(user.slice(user.indexOf('Items:\n') + 'Items:\n'.length)) as { id: string; text: string; context?: string }[], text: user };
}
const goodModel = (mutate?: (id: string, text: string) => string) => (options: unknown) => ({
  translations: asked(options).items.map((i) => ({ id: i.id, text: mutate ? mutate(i.id, i.text) : `ع: ${i.text}` })),
});

beforeAll(async () => {
  w = await buildWorld('contenttranslation');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await q(`update institution set secondary_language = 'ar' where id = $1`, [w.ids.inst]);
  const set = await as('alo', (c) => setUpQualityFramework(c));
  iqf = set.versions[0]!.id;
  const std = await as('alo', (c) => addQualityItem(c, iqf, { code: '1', title: 'Teaching quality', description: 'The institution reviews teaching every year.' }));
  const sub = await as('alo', (c) => addQualityItem(c, iqf, { code: '1.1', title: 'Course review' }));
  await as('alo', (c) => addNote(c, { requirementId: sub.id, type: 'guidance', text: 'Keep the minutes of the review meeting.', authority: 'suggested' }));
  iqfItems = { std: std.id, sub: sub.id };
}, 120000);
beforeEach(async () => {
  sent.length = 0;
  await q(`delete from content_translation`);
  await q(`update translation_run set status = 'cancelled' where status in ('queued', 'running')`);
  await q(`delete from ai_setting`);
});
afterEach(() => setAiModelForTests(null));
afterAll(() => w.close());

// iqf: std title + statement, sub title, sub note.
const IQF_TEXTS = 4;

describe('translating the IQF', () => {
  it('translates titles, statements and notes as unreviewed AI rows beside the English, which is not touched', async () => {
    const fake = createFakeAiModel([goodModel()]);
    setAiModelForTests(fake.model);
    const before = await q(`select id, title, official_text from requirement where framework_version_id = $1 order by code`, [iqf]);
    const run = await as('alo', (c) => startContentTranslation(c, iqf));
    expect(run).toMatchObject({ kind: 'iqf', language: 'ar', scopeId: iqf, status: 'queued', progress: { total: IQF_TEXTS, done: 0 } });
    await drain();
    const rows = await q(`select kind, framework_version_id, entity_id, field, text, origin, reviewed, source_hash, run_id from content_translation order by field, text`);
    expect(rows).toHaveLength(IQF_TEXTS);
    expect(rows.every((r) => r.kind === 'iqf' && r.framework_version_id === iqf && r.origin === 'ai' && r.reviewed === false && r.source_hash.length === 16 && r.run_id === run.id)).toBe(true);
    expect(rows.map((r) => r.field).sort()).toEqual(['note', 'statement', 'title', 'title']);
    expect(rows.find((r) => r.field === 'statement')!.text).toBe('ع: The institution reviews teaching every year.');
    // The English is exactly as it was.
    expect(await q(`select id, title, official_text from requirement where framework_version_id = $1 order by code`, [iqf])).toEqual(before);
    // The model is told where each text is used, at temperature 0, and the target language.
    expect((fake.calls[0] as { temperature?: number }).temperature).toBe(0);
    expect(asked(fake.calls[0]).text).toContain('Target language: Arabic (ar), written right to left');
    expect(asked(fake.calls[0]).items.map((i) => i.context).join('|')).toMatch(/title of requirement 1\.1.*note of requirement 1\.1/s);

    const status = await as('alo', (c) => contentTranslationStatus(c, iqf));
    expect(status).toMatchObject({ kind: 'iqf', secondaryLanguage: 'ar', total: IQF_TEXTS, translated: IQF_TEXTS, reviewed: 0, stale: 0, byAi: IQF_TEXTS, byPerson: 0, run: { status: 'succeeded' } });
    const map = await as('contrib', (c) => contentTranslationMap(c, iqf));
    expect(map).toMatchObject({ kind: 'iqf', language: 'ar' });
    expect(map.entries.find((e) => e.entityId === iqfItems.std && e.field === 'title')).toMatchObject({ text: 'ع: Teaching quality', origin: 'ai', reviewed: false, stale: false });
    expect(contentTranslationKey(iqfItems.std, 'title')).toBe(`${iqfItems.std}:title`);
  });

  it('stores Arabic in NFC however the model wrote it', async () => {
    const decomposed = 'آ'.normalize('NFD'); // alef + madda above
    expect(decomposed).not.toBe('آ');
    setAiModelForTests(createFakeAiModel([goodModel((_id, text) => `${decomposed} ${text}`)]).model);
    await as('alo', (c) => startContentTranslation(c, iqf));
    await drain();
    for (const r of await q(`select text from content_translation`)) expect(r.text).toBe(r.text.normalize('NFC'));
    expect((await q(`select text from content_translation where field = 'title' order by text limit 1`))[0].text.startsWith('آ ')).toBe(true);
    const person = await as('alo', (c) => saveContentTranslation(c, iqf, { entityId: iqfItems.sub, field: 'title', text: `${decomposed} مراجعة المقرر` }));
    expect(person.text).toBe(`آ مراجعة المقرر`);
  });

  it('marks a translation out of date when the English changes, and re-translates it only on request and only if nobody wrote or reviewed it', async () => {
    setAiModelForTests(createFakeAiModel([goodModel()]).model);
    await as('alo', (c) => startContentTranslation(c, iqf));
    await drain();
    // A person writes the title of 1.1; the title and statement of 1 stay machine translations; 1's statement is reviewed.
    await as('alo', (c) => saveContentTranslation(c, iqf, { entityId: iqfItems.sub, field: 'title', text: 'مراجعة المقرر' }));
    await as('alo', (c) => markContentReviewed(c, iqf, [{ entityId: iqfItems.std, field: 'statement' }]));
    // The English of all three changes.
    await as('alo', (c) => editQualityItem(c, iqfItems.std, { code: '1', title: 'Quality of teaching', description: 'Teaching is reviewed every year by a committee.' }));
    await as('alo', (c) => editQualityItem(c, iqfItems.sub, { code: '1.1', title: 'Course reviews' }));
    const status = await as('alo', (c) => contentTranslationStatus(c, iqf));
    expect(status).toMatchObject({ total: IQF_TEXTS, translated: IQF_TEXTS, stale: 3, byPerson: 1 });
    const stale = (await as('alo', (c) => listContentTranslations(c, iqf, { filter: 'stale' }))).rows;
    expect(stale.map((r) => `${r.code}:${r.field}`).sort()).toEqual(['1.1:title', '1:statement', '1:title']);
    const map = await as('alo', (c) => contentTranslationMap(c, iqf));
    expect(map.entries.filter((e) => e.stale)).toHaveLength(3);

    // Nothing is waiting without the request: stale rows are not "missing".
    await expect(as('alo', (c) => startContentTranslation(c, iqf))).rejects.toThrow(/nothing is waiting/);
    // On request: only the unreviewed machine translation (1's title) is redone.
    await as('alo', (c) => startContentTranslation(c, iqf, { retranslateStale: true }));
    await drain();
    const text = async (id: string, f: string) => (await q(`select text, source_hash from content_translation where entity_id = $1 and field = $2`, [id, f]))[0];
    expect((await text(iqfItems.std, 'title')).text).toBe('ع: Quality of teaching');
    expect((await text(iqfItems.sub, 'title')).text).toBe('مراجعة المقرر'); // a person's
    expect((await text(iqfItems.std, 'statement')).text).toBe('ع: The institution reviews teaching every year.'); // reviewed
    const after = await as('alo', (c) => contentTranslationStatus(c, iqf));
    expect(after.stale).toBe(2);
    // A person's text can be corrected against the new English: it stops being out of date.
    await as('alo', (c) => saveContentTranslation(c, iqf, { entityId: iqfItems.sub, field: 'title', text: 'مراجعات المقرر' }));
    expect((await as('alo', (c) => contentTranslationStatus(c, iqf))).stale).toBe(1);
  });
});

describe('translating an external standard', () => {
  it('works on a published version (frozen English untouched), keeps scope and kind, and the table is the only thing written', async () => {
    const fake = createFakeAiModel([goodModel()]);
    setAiModelForTests(fake.model);
    const version = w.ids.abet!;
    expect((await q(`select status from framework_version where id = $1`, [version]))[0].status).toBe('published');
    const reqs = await q(`select id, title, official_text, updated_at from requirement where framework_version_id = $1 order by code`, [version]);
    const notes = await q(`select n.id, n.text, n.updated_at from requirement_note n join requirement r on r.id = n.requirement_id where r.framework_version_id = $1`, [version]);
    const run = await as('alo', (c) => startContentTranslation(c, version));
    expect(run).toMatchObject({ kind: 'standard', scopeId: version });
    expect(run.progress.total).toBeGreaterThan(0);
    await drain();
    const done = (await as('alo', (c) => contentTranslationStatus(c, version)));
    expect(done).toMatchObject({ kind: 'standard', translated: run.progress.total, total: run.progress.total, run: { status: 'succeeded' } });
    expect((await q(`select count(*)::int as n from content_translation where kind = 'standard' and framework_version_id = $1`, [version]))[0].n).toBe(run.progress.total);
    // Nothing about another version, and nothing in the English tables.
    expect((await q(`select count(*)::int as n from content_translation where framework_version_id <> $1`, [version]))[0].n).toBe(0);
    expect(await q(`select id, title, official_text, updated_at from requirement where framework_version_id = $1 order by code`, [version])).toEqual(reqs);
    expect(await q(`select n.id, n.text, n.updated_at from requirement_note n join requirement r on r.id = n.requirement_id where r.framework_version_id = $1`, [version])).toEqual(notes);
    // Batches of at most 40 items.
    expect(Math.max(...fake.calls.map((c) => asked(c).items.length))).toBeLessThanOrEqual(40);
    // Edits of a published version's translation work too, and the English still cannot change.
    const first = (await as('alo', (c) => listContentTranslations(c, version, { limit: 1 }))).rows[0]!;
    const saved = await as('alo', (c) => saveContentTranslation(c, version, { entityId: first.entityId, field: first.field, text: 'نص بشري' }));
    expect(saved).toMatchObject({ origin: 'person', reviewed: true, stale: false });
    await expect(q(`update requirement set title = 'x' where id = $1`, [reqs[0].id])).rejects.toThrow(/immutable/);
  });

  it('refuses the wrong kind for a version, a version of another kind in the run routes, and an unknown version', async () => {
    setAiModelForTests(createFakeAiModel([goodModel()]).model);
    await expect(as('alo', (c) => startTranslation(c, { kind: 'iqf', language: 'ar', scopeId: w.ids.puc! }))).rejects.toThrow(ValidationError);
    await expect(as('alo', (c) => startTranslation(c, { kind: 'standard', language: 'ar', scopeId: iqf }))).rejects.toThrow(ValidationError);
    await expect(as('alo', (c) => startTranslation(c, { kind: 'standard', language: 'ar' }))).rejects.toThrow(ValidationError);
    await expect(as('alo', (c) => startContentTranslation(c, crypto.randomUUID()))).rejects.toThrow(NotFoundError);
    // Another version's run is not this version's run.
    const run = await as('alo', (c) => startContentTranslation(c, w.ids.wscuc!));
    await expect(as('alo', (c) => cancelContentTranslation(c, w.ids.abet!, run.id))).rejects.toThrow(NotFoundError);
    await expect(as('alo', (c) => cancelContentTranslation(c, iqf, run.id))).rejects.toThrow(NotFoundError);
  });

  it('runs one version at a time per scope, cancels and resumes from the run row, and different versions may run side by side', async () => {
    setAiModelForTests(createFakeAiModel([goodModel()]).model);
    const run = await as('alo', (c) => startContentTranslation(c, w.ids.abet!));
    await expect(as('alo', (c) => startContentTranslation(c, w.ids.abet!))).rejects.toThrow(/already running/);
    const other = await as('alo', (c) => startContentTranslation(c, iqf));
    expect(other.id).not.toBe(run.id);
    const cancelled = await as('alo', (c) => cancelContentTranslation(c, w.ids.abet!, run.id));
    expect(cancelled.status).toBe('cancelled');
    await drain();
    expect((await q(`select count(*)::int as n from content_translation where framework_version_id = $1`, [w.ids.abet]))[0].n).toBe(0);
    expect((await q(`select count(*)::int as n from content_translation where framework_version_id = $1`, [iqf]))[0].n).toBe(IQF_TEXTS);
    const resumed = await as('alo', (c) => resumeContentTranslation(c, w.ids.abet!, run.id));
    expect(resumed).toMatchObject({ id: run.id, status: 'queued' });
    await drain();
    const end = await as('alo', (c) => contentTranslationStatus(c, w.ids.abet!));
    expect(end.run).toMatchObject({ id: run.id, status: 'succeeded' });
    expect(end.translated).toBe(end.total);
  });

  it('stops at the spend limit and keeps what was done', async () => {
    await q(`insert into ai_setting (institution_id, enabled, cap_unit, max_tokens_per_run) values ($1, true, 'tokens', 7000)`, [w.ids.inst]);
    setAiModelForTests(createFakeAiModel([goodModel()], { inputTokens: 2000, outputTokens: 1000 }).model);
    await as('alo', (c) => startContentTranslation(c, w.ids.wscuc!, { batchItems: 5 }));
    await drain();
    const status = await as('alo', (c) => contentTranslationStatus(c, w.ids.wscuc!));
    expect(status.run?.status).toBe('stopped');
    expect(status.translated).toBeGreaterThan(0);
    expect(status.translated).toBeLessThan(status.total);
    expect(status.run?.error).toMatch(/budget for this run is used up/);
  });
});

describe('review, edits and permissions', () => {
  it('filters the review table, takes a person\'s edit, marks selected or all reviewed', async () => {
    setAiModelForTests(createFakeAiModel([goodModel()]).model);
    await as('alo', (c) => startContentTranslation(c, iqf));
    await drain();
    const list = (filter?: 'missing' | 'needs_review' | 'reviewed' | 'stale', extra: { q?: string } = {}) => as('contrib', (c) => listContentTranslations(c, iqf, { ...(filter ? { filter } : {}), ...extra }));
    expect((await list()).total).toBe(IQF_TEXTS);
    expect((await list('needs_review')).total).toBe(IQF_TEXTS);
    expect((await list('missing')).total).toBe(0);
    expect((await list(undefined, { q: 'minutes' })).rows).toMatchObject([{ code: '1.1', field: 'note', english: 'Keep the minutes of the review meeting.' }]);
    await q(`delete from content_translation where field = 'note'`);
    expect((await list('missing')).rows.map((r) => r.field)).toEqual(['note']);

    await as('alo', (c) => saveContentTranslation(c, iqf, { entityId: iqfItems.std, field: 'title', text: 'جودة التدريس' }));
    expect(await as('alo', (c) => markContentReviewed(c, iqf, [{ entityId: iqfItems.sub, field: 'title' }]))).toEqual({ marked: 1 });
    expect((await list('reviewed')).rows.map((r) => `${r.code}:${r.field}`).sort()).toEqual(['1.1:title', '1:title']);
    expect(await as('alo', (c) => markContentReviewed(c, iqf, []))).toEqual({ marked: 0 });
    expect(await as('alo', (c) => markContentReviewed(c, iqf))).toEqual({ marked: 1 }); // 1's statement
    expect((await list('needs_review')).total).toBe(0);
  });

  it('refuses edits of something that is not translatable here, and anyone who may not write the framework', async () => {
    await expect(as('alo', (c) => saveContentTranslation(c, iqf, { entityId: crypto.randomUUID(), field: 'title', text: 'x' }))).rejects.toThrow(NotFoundError);
    // 1.1 has no statement, so there is nothing to translate for that field.
    await expect(as('alo', (c) => saveContentTranslation(c, iqf, { entityId: iqfItems.sub, field: 'statement', text: 'x' }))).rejects.toThrow(NotFoundError);
    // Contributors read but cannot translate, edit or review; nothing is written.
    await expect(as('contrib', (c) => startContentTranslation(c, iqf))).rejects.toThrow(ForbiddenError);
    await expect(as('contrib', (c) => saveContentTranslation(c, iqf, { entityId: iqfItems.std, field: 'title', text: 'x' }))).rejects.toThrow(ForbiddenError);
    await expect(as('contrib', (c) => markContentReviewed(c, iqf))).rejects.toThrow(ForbiddenError);
    expect((await as('contrib', (c) => contentTranslationStatus(c, iqf))).readiness).toBeNull();
    expect((await q(`select count(*)::int as n from content_translation`))[0].n).toBe(0);
    // A person from outside the institution's roles reads nothing.
    await expect(as('outsider', (c) => contentTranslationMap(c, iqf))).rejects.toThrow(ForbiddenError);
  });

  it('needs a secondary language and AI that is ready, and has nothing to show without a language', async () => {
    setAiModelForTests(createFakeAiModel([goodModel()]).model);
    await q(`insert into ai_setting (institution_id, enabled) values ($1, false)`, [w.ids.inst]);
    await expect(as('alo', (c) => startContentTranslation(c, iqf))).rejects.toThrow(/switched off/);
    expect((await as('alo', (c) => contentTranslationStatus(c, iqf))).readiness).toMatchObject({ ok: false });
    await q(`delete from ai_setting`);
    expect((await as('alo', (c) => contentTranslationStatus(c, iqf))).readiness).toMatchObject({ ok: true });
    await q(`update institution set secondary_language = null, default_locale = 'en'`);
    try {
      await expect(as('alo', (c) => startContentTranslation(c, iqf))).rejects.toThrow(ConflictError);
      expect(await as('alo', (c) => contentTranslationStatus(c, iqf))).toMatchObject({ secondaryLanguage: null, total: 0, run: null });
      expect(await as('alo', (c) => contentTranslationMap(c, iqf))).toMatchObject({ language: null, entries: [] });
      expect(await as('alo', (c) => listContentTranslations(c, iqf))).toEqual({ total: 0, rows: [] });
    } finally {
      await q(`update institution set secondary_language = 'ar'`);
    }
  });

  it('sets a text aside when the model keeps breaking the rules, and keeps the rest', async () => {
    setAiModelForTests(createFakeAiModel([goodModel((id, text) => (id.endsWith(':note') ? '   ' : `ع: ${text}`))]).model);
    await as('alo', (c) => startContentTranslation(c, iqf));
    await drain();
    const status = await as('alo', (c) => contentTranslationStatus(c, iqf));
    expect(status.run).toMatchObject({ status: 'succeeded', progress: { done: IQF_TEXTS - 1, flagged: 1 } });
    expect(status.translated).toBe(IQF_TEXTS - 1);
    expect((await q(`select 1 from content_translation where field = 'note'`))).toHaveLength(0);
  });
});
