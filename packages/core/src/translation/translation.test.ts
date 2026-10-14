// The generic translation job end to end with a fake model (TASK-070): batches, placeholder checks with one retry, the spend
// limit, cancel, resume, a person's edits and reviewed rows being safe, stale rows only on request, permissions, readiness.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EN_CATALOGUE, UNTRANSLATED_KEYS, placeholdersOf, type JobEnvelope, type JobType } from '@ams/shared';
import { ConflictError, ForbiddenError, ValidationError, type Ctx, type JobQueue } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createFakeAiModel, setAiModelForTests } from '../ai/index.js';
import { handlers } from '../jobs/handlers.js';
import { runJob } from '../jobs/run.js';
import { getInstitution, updateInstitution } from '../org/institution.js';
import { languageStateOf, updateMyPreferences } from '../org/preferences.js';
import {
  cancelTranslation, languagesSettings, latestTranslationRun, listUiTranslations, markUiReviewed, resumeTranslation, saveUiTranslation, startTranslation, uiBundle,
} from './index.js';

let w: World;
const sent: (JobEnvelope & { type: JobType })[] = [];
const queue: JobQueue = { send: async (type, e) => { sent.push({ ...e, type }); } };
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); } }));
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;
async function drain(max = 200) {
  let n = 0;
  while (sent.length && n++ < max) {
    const { type, ...env } = sent.shift()!;
    await runJob(w.pool, type, env, handlers, { store: w.store, queue });
  }
  return n;
}
const TOTAL = Object.keys(EN_CATALOGUE).filter((k) => !UNTRANSLATED_KEYS.includes(k)).length;

/** The items the model is asked about (the JSON list after "Items:" in the prompt) and whether it is the retry. */
function asked(options: unknown): { items: { id: string; text: string; context?: string }[]; text: string } {
  const prompt = (options as { prompt: { role: string; content: string | { type: string; text?: string }[] }[] }).prompt;
  const user = prompt.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join(''))).join('\n');
  const json = user.slice(user.indexOf('Items:\n') + 'Items:\n'.length);
  return { items: JSON.parse(json) as { id: string; text: string; context?: string }[], text: user };
}
/** A good translator: marks every text "ع:" and keeps the placeholders. */
const goodModel = (mutate?: (id: string, text: string, retry: boolean) => string) => (options: unknown) => {
  const { items } = asked(options);
  return { translations: items.map((i) => ({ id: i.id, text: mutate ? mutate(i.id, i.text, !!i.context?.includes('rejected')) : `ع: ${i.text}` })) };
};

beforeAll(async () => {
  w = await buildWorld('translation');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await w.db.su.query(`update institution set secondary_language = 'ar' where id = $1`, [w.ids.inst]);
}, 120000);
beforeEach(async () => {
  sent.length = 0;
  await q(`delete from ui_translation`);
  await q(`update translation_run set status = 'cancelled' where status in ('queued', 'running')`);
  await q(`delete from ai_setting`);
});
afterEach(() => setAiModelForTests(null));
afterAll(() => w.close());

describe('the interface translation job', () => {
  it('translates everything in batches as unreviewed AI rows, keeping every placeholder', async () => {
    const fake = createFakeAiModel([goodModel()]);
    setAiModelForTests(fake.model);
    const run = await as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }));
    expect(run).toMatchObject({ status: 'queued', kind: 'ui', language: 'ar', progress: { total: TOTAL, done: 0, flagged: 0 } });
    await drain();
    const done = await as('admin', (c) => latestTranslationRun(c, 'ui', 'ar'));
    expect(done).toMatchObject({ status: 'succeeded', progress: { total: TOTAL, done: TOTAL, flagged: 0 }, error: null });
    expect(done!.progress.batches).toBe(Math.ceil(TOTAL / 40));
    expect(fake.calls).toHaveLength(Math.ceil(TOTAL / 40));
    expect(done!.usage.calls).toBe(fake.calls.length);
    const rows = await q(`select key, text, origin, reviewed, source_hash from ui_translation order by key`);
    expect(rows).toHaveLength(TOTAL);
    expect(rows.every((r) => r.origin === 'ai' && r.reviewed === false && r.source_hash.length === 16)).toBe(true);
    for (const r of rows) expect(placeholdersOf(r.text)).toEqual(placeholdersOf(EN_CATALOGUE[r.key]!));
    // Temperature 0 and the versioned prompt; the target language is named.
    const first = fake.calls[0] as { temperature?: number };
    expect(first.temperature).toBe(0);
    expect(asked(fake.calls[0]).text).toContain('Target language: Arabic (ar), written right to left');
    expect((await q(`select prompt_versions from translation_run`))[0].prompt_versions).toEqual({ translate: 'v1' });
  });

  it('asks again once for a translation that drops a placeholder, and sets aside one that keeps failing', async () => {
    const fake = createFakeAiModel([goodModel((id, text, retry) => {
      if (id === 'nav.myRequests') return retry ? 'ع: طلباتي ({{count}})' : 'ع: طلباتي'; // fixed on the second ask
      if (id === 'json.save') return 'ع: {{التسمية}}'; // never fixed
      if (id === 'common.save') return '   '; // empty, never fixed
      return `ع: ${text}`;
    })]);
    setAiModelForTests(fake.model);
    await as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }));
    await drain();
    const run = (await as('admin', (c) => latestTranslationRun(c, 'ui', 'ar')))!;
    expect(run.status).toBe('succeeded');
    expect(run.flagged.map((f) => f.id).sort()).toEqual(['common.save', 'json.save']);
    expect(run.flagged.find((f) => f.id === 'json.save')!.reason).toMatch(/placeholder/);
    expect(run.progress).toMatchObject({ done: TOTAL - 2, flagged: 2 });
    expect((await q(`select text from ui_translation where key = 'nav.myRequests'`))[0].text).toBe('ع: طلباتي ({{count}})');
    expect(await q(`select 1 from ui_translation where key in ('json.save', 'common.save')`)).toHaveLength(0);
    // The retry went out with the reason, only for the three failed items.
    const retries = fake.calls.filter((c) => asked(c).text.includes('previous translation was rejected'));
    expect(retries.length).toBeGreaterThan(0);
    expect(retries.flatMap((r) => asked(r).items.map((i) => i.id)).sort()).toEqual(['common.save', 'json.save', 'nav.myRequests']);
  });

  it('stops at the spend limit keeping what was done, and resumes with a fresh allowance', async () => {
    await q(`insert into ai_setting (institution_id, enabled, cap_unit, max_tokens_per_run) values ($1, true, 'tokens', 7000)`, [w.ids.inst]);
    setAiModelForTests(createFakeAiModel([goodModel()], { inputTokens: 2000, outputTokens: 1000 }).model);
    await as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }));
    await drain();
    const stopped = (await as('admin', (c) => latestTranslationRun(c, 'ui', 'ar')))!;
    expect(stopped.status).toBe('stopped');
    expect(stopped.error).toMatch(/budget for this run is used up/);
    expect(stopped.progress.done).toBeGreaterThan(0);
    expect(stopped.progress.done).toBeLessThan(TOTAL);
    expect((await q(`select count(*)::int as n from ui_translation`))[0].n).toBe(stopped.progress.done);
    expect(stopped.usage.inputTokens).toBeGreaterThan(0);

    // Resume under the same cap: another allowance, more progress, stopped again; then lift the cap and finish.
    const resumed = await as('admin', (c) => resumeTranslation(c, stopped.id));
    expect(resumed).toMatchObject({ id: stopped.id, status: 'queued' });
    expect(resumed.progress.total).toBe(TOTAL);
    await drain();
    const again = (await as('admin', (c) => latestTranslationRun(c, 'ui', 'ar')))!;
    expect(again.status).toBe('stopped');
    expect(again.progress.done).toBeGreaterThan(stopped.progress.done);
    await q(`update ai_setting set max_tokens_per_run = null`);
    await as('admin', (c) => resumeTranslation(c, stopped.id));
    await drain();
    const end = (await as('admin', (c) => latestTranslationRun(c, 'ui', 'ar')))!;
    expect(end).toMatchObject({ status: 'succeeded', progress: { done: TOTAL } });
    expect(end.usage.inputTokens).toBeGreaterThan(again.usage.inputTokens);
    expect((await q(`select count(*)::int as n from ui_translation`))[0].n).toBe(TOTAL);
  });

  it('cancels: queued work does nothing, what exists stays, and a cancelled run can be resumed', async () => {
    setAiModelForTests(createFakeAiModel([goodModel()]).model);
    const run = await as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }));
    await as('admin', (c) => cancelTranslation(c, run.id));
    await drain();
    expect((await q(`select count(*)::int as n from ui_translation`))[0].n).toBe(0);
    const jobs = await q(`select result from job where type = 'translate' order by created_at desc limit 1`);
    expect(jobs[0].result).toMatchObject({ skipped: 'the run is cancelled' });
    await expect(as('admin', (c) => cancelTranslation(c, run.id))).rejects.toThrow(ConflictError);
    await as('admin', (c) => resumeTranslation(c, run.id));
    await drain();
    expect((await as('admin', (c) => latestTranslationRun(c, 'ui', 'ar')))!.status).toBe('succeeded');
    await expect(as('admin', (c) => resumeTranslation(c, run.id))).rejects.toThrow(/only a stopped, cancelled or failed/);
  });

  it("never overwrites a person's text or a reviewed row, and leaves stale ones alone unless asked", async () => {
    setAiModelForTests(createFakeAiModel([goodModel()]).model);
    await as('admin', (c) => saveUiTranslation(c, { key: 'nav.settings', text: 'الإعدادات (بقلم شخص)' }));
    await q(`insert into ui_translation (institution_id, language, key, source_hash, text, origin, reviewed) values ($1, 'ar', 'nav.evidence', 'old', 'الأدلة', 'ai', true)`, [w.ids.inst]);
    await q(`insert into ui_translation (institution_id, language, key, source_hash, text, origin, reviewed) values ($1, 'ar', 'nav.menu', 'old', 'قديم', 'ai', false)`, [w.ids.inst]);
    await as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }));
    await drain();
    const text = async (k: string) => (await q(`select text from ui_translation where key = $1`, [k]))[0].text as string;
    expect(await text('nav.settings')).toBe('الإعدادات (بقلم شخص)');
    expect(await text('nav.evidence')).toBe('الأدلة');
    expect(await text('nav.menu')).toBe('قديم'); // stale, but only re-translated on request
    // On request: the stale machine translation is redone; the reviewed one and the person's are still safe.
    await q(`update translation_run set status = 'cancelled' where status in ('queued', 'running')`);
    await as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'ar', retranslateStale: true }));
    await drain();
    expect(await text('nav.menu')).toBe('ع: Menu');
    expect(await text('nav.evidence')).toBe('الأدلة');
    expect(await text('nav.settings')).toBe('الإعدادات (بقلم شخص)');
    expect((await q(`select source_hash from ui_translation where key = 'nav.menu'`))[0].source_hash).not.toBe('old');
  });

  it('refuses without permission, without a language, when AI is off, and when nothing is pending', async () => {
    setAiModelForTests(createFakeAiModel([goodModel()]).model);
    await expect(as('alo', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }))).rejects.toThrow(ForbiddenError);
    await expect(as('contrib', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }))).rejects.toThrow(ForbiddenError);
    await expect(as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'en' }))).rejects.toThrow(ValidationError);
    await q(`insert into ai_setting (institution_id, enabled) values ($1, false)`, [w.ids.inst]);
    await expect(as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }))).rejects.toThrow(/switched off/);
    expect((await as('admin', (c) => languagesSettings(c))).readiness).toMatchObject({ ok: false });
    await q(`delete from ai_setting`);
    await as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }));
    await expect(as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }))).rejects.toThrow(/already running/);
    await drain();
    await expect(as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }))).rejects.toThrow(/nothing is waiting/);
  });

  it('fails the run (not the queue) when AI is switched off while it waits', async () => {
    setAiModelForTests(createFakeAiModel([goodModel()]).model);
    await as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }));
    await q(`insert into ai_setting (institution_id, enabled) values ($1, false)`, [w.ids.inst]);
    await drain();
    expect(await as('admin', (c) => latestTranslationRun(c, 'ui', 'ar'))).toMatchObject({ status: 'failed', error: expect.stringMatching(/switched off/) });
  });
});

describe('the catalogue, review and the language rules', () => {
  beforeEach(async () => { await q(`update institution set secondary_language = 'ar', default_locale = 'en'`); await q(`update app_user set ui_locale = null`); });

  it('reports status, filters the review table and serves a bundle with an ETag that follows changes', async () => {
    setAiModelForTests(createFakeAiModel([goodModel()]).model);
    expect(await as('admin', (c) => uiBundle(c, 'ar'))).toMatchObject({ language: 'ar', strings: {} });
    await as('admin', (c) => startTranslation(c, { kind: 'ui', language: 'ar' }));
    await drain();
    const s1 = await as('admin', (c) => languagesSettings(c));
    expect(s1.catalogue).toMatchObject({ language: 'ar', total: TOTAL, translated: TOTAL, reviewed: 0, stale: 0, byAi: TOTAL, byPerson: 0 });
    expect(s1.run?.status).toBe('succeeded');
    const bundle1 = (await as('admin', (c) => uiBundle(c, 'ar')))!;
    expect(Object.keys(bundle1.strings)).toHaveLength(TOTAL);
    expect(bundle1.strings).not.toHaveProperty('appName');
    // Only the institution's secondary language is served; any signed-in person (even without org:read) can fetch it.
    expect(await as('contrib', (c) => uiBundle(c, 'fr'))).toBeNull();
    expect(await as('contrib', (c) => uiBundle(c, 'ar'))).not.toBeNull();

    expect((await as('admin', (c) => listUiTranslations(c, { filter: 'needs_review', limit: 1000 }))).total).toBe(TOTAL);
    expect((await as('admin', (c) => listUiTranslations(c, { filter: 'reviewed' }))).total).toBe(0);
    await as('admin', (c) => saveUiTranslation(c, { key: 'common.save', text: 'حفظ' }));
    expect(await as('admin', (c) => markUiReviewed(c, ['nav.settings']))).toEqual({ marked: 1 });
    expect((await as('admin', (c) => listUiTranslations(c, { filter: 'reviewed' }))).rows.map((r) => r.key).sort()).toEqual(['common.save', 'nav.settings']);
    const row = (await as('admin', (c) => listUiTranslations(c, { q: 'common.save' }))).rows[0]!;
    expect(row).toMatchObject({ key: 'common.save', text: 'حفظ', origin: 'person', reviewed: true, stale: false });
    const bundle2 = (await as('admin', (c) => uiBundle(c, 'ar')))!;
    expect(bundle2.etag).not.toBe(bundle1.etag);
    expect(bundle2.strings['common.save']).toBe('حفظ');
    expect(await as('admin', (c) => markUiReviewed(c))).toEqual({ marked: TOTAL - 2 });
  });

  it("refuses a person's edit that breaks a placeholder, an unknown key, and non-administrators", async () => {
    await expect(as('admin', (c) => saveUiTranslation(c, { key: 'nav.myRequests', text: 'طلباتي' }))).rejects.toThrow(/placeholder/);
    await expect(as('admin', (c) => saveUiTranslation(c, { key: 'no.such.key', text: 'x' }))).rejects.toThrow(/interface text/);
    await expect(as('admin', (c) => saveUiTranslation(c, { key: 'appName', text: 'x' }))).rejects.toThrow(/interface text/);
    await expect(as('alo', (c) => saveUiTranslation(c, { key: 'common.save', text: 'حفظ' }))).rejects.toThrow(ForbiddenError);
    await expect(as('alo', (c) => markUiReviewed(c))).rejects.toThrow(ForbiddenError);
    // Everyone who can read the organization can read the review table, but not change it.
    expect((await as('alo', (c) => listUiTranslations(c))).total).toBe(TOTAL);
  });

  it('keeps the institution and person rules: registry, English never secondary, default and own language', async () => {
    await expect(as('admin', (c) => updateInstitution(c, { secondaryLanguage: 'en' }))).rejects.toThrow(/primary/);
    await expect(as('admin', (c) => updateInstitution(c, { secondaryLanguage: 'klingon' }))).rejects.toThrow(/not a language/);
    await expect(as('admin', (c) => updateInstitution(c, { defaultLocale: 'fr' }))).rejects.toThrow(/English or Arabic/);
    await expect(as('alo', (c) => updateInstitution(c, { secondaryLanguage: 'fr' }))).rejects.toThrow(ForbiddenError);

    expect(await as('contrib', (c) => languageStateOf(c))).toEqual({ secondaryLanguage: 'ar', defaultLocale: 'en', uiLocale: null, effectiveLocale: 'en' });
    expect(await as('contrib', (c) => updateMyPreferences(c, { uiLocale: 'ar' }))).toMatchObject({ uiLocale: 'ar', effectiveLocale: 'ar' });
    await expect(as('contrib', (c) => updateMyPreferences(c, { uiLocale: 'fr' }))).rejects.toThrow(/English or Arabic/);
    // Another person's choice is not touched by mine.
    expect((await as('second', (c) => languageStateOf(c))).uiLocale).toBeNull();
    // A new default applies to people who have not chosen.
    await as('admin', (c) => updateInstitution(c, { defaultLocale: 'ar' }));
    expect(await as('second', (c) => languageStateOf(c))).toMatchObject({ defaultLocale: 'ar', effectiveLocale: 'ar' });
    expect(await as('contrib', (c) => updateMyPreferences(c, { uiLocale: null }))).toMatchObject({ uiLocale: null, effectiveLocale: 'ar' });
    // Changing the secondary language sends people back to the default and resets a default that no longer fits; rows are kept.
    await as('contrib', (c) => updateMyPreferences(c, { uiLocale: 'ar' }));
    await q(`insert into ui_translation (institution_id, language, key, source_hash, text, origin) values ($1, 'ar', 'nav.menu', 'h', 'x', 'ai')`, [w.ids.inst]);
    const changed = await as('admin', (c) => updateInstitution(c, { secondaryLanguage: 'fr' }));
    expect(changed).toMatchObject({ secondaryLanguage: 'fr', defaultLocale: 'en' });
    expect(await as('contrib', (c) => languageStateOf(c))).toMatchObject({ uiLocale: null, effectiveLocale: 'en' });
    expect((await q(`select count(*)::int as n from ui_translation where language = 'ar'`))[0].n).toBe(1);
    const none = await as('admin', (c) => updateInstitution(c, { secondaryLanguage: null }));
    expect(none).toMatchObject({ secondaryLanguage: null, defaultLocale: 'en' });
    expect((await as('admin', (c) => getInstitution(c))).secondaryLanguage).toBeNull();
    await expect(as('contrib', (c) => updateMyPreferences(c, { uiLocale: 'fr' }))).rejects.toThrow(/must be English/);
    expect(await as('admin', (c) => languagesSettings(c))).toMatchObject({ secondaryLanguage: null, catalogue: null, run: null });
  });
});
