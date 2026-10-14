// @vitest-environment jsdom
// The IQF and external standards in the secondary language on the version page (TASK-071), against the real API and database:
// the content switcher (English | Arabic) with English as the fallback, the "Unofficial translation" label on a standard, the
// review dialog (filters, edit, mark reviewed, mark all), the Translate action with progress, cancel and resume, Arabic text
// with dir="auto", and what a person without write permission sees. No model is called: runs are only started, not executed.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@ams/api';
import { MemoryStore, createFakeAiModel, setAiModelForTests, sourceHash } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { resetContentLanguageForTests } from './lib/content-language';
import { frameworkApi } from './lib/framework-api';
import { activateLocale } from './lib/language';
import { VersionPage } from './pages/version';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const q = (sql: string, p: unknown[] = []) => db.su.query(sql, p);
const apiFor = (who: string) => frameworkApi(createApi(((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch));
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const TITLE_AR = 'الحوكمة والإدارة';
const STATEMENT_AR = 'تُدار المؤسسة وفق ميثاق معتمد.';

async function seed() {
  await q(`delete from content_translation`);
  await q(`delete from translation_run`);
  const ins = (kind: string, version: string, entity: string, field: string, text: string, origin: string, reviewed: boolean, hash = 'stale-hash') =>
    q(`insert into content_translation (institution_id, kind, framework_version_id, entity_id, field, language, source_hash, text, origin, reviewed) values ($1, $2, $3, $4, $5, 'ar', $6, $7, $8, $9)`, [ids.inst, kind, version, entity, field, hash, text, origin, reviewed]);
  await ins('standard', ids.std!, ids.stdReq!, 'title', TITLE_AR, 'ai', false);
  await ins('standard', ids.std!, ids.stdReq!, 'statement', STATEMENT_AR, 'person', true, sourceHash('The institution is governed under an approved charter.'));
  await ins('iqf', ids.iqf!, ids.iqfReq!, 'title', 'جودة التدريس', 'ai', false);
}

beforeAll(async () => {
  db = await createTestDb('webcontenttr');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en, secondary_language, default_locale) values ('Gulf University', 'ar', 'en') returning id`);
  for (const n of ['admin', 'lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']]) {
    await q(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Gulf Accreditation Council', 'GAC', 'institutional') returning id`, [ids.inst]);
  const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'GAC Standards', 'institution') returning id`, [ids.inst, acc]);
  const iqfFw = await one(`insert into framework (institution_id, accreditor_id, name, scope, internal) values ($1, $2, 'Internal Quality Framework', 'institution', true) returning id`, [ids.inst, acc]);
  ids.std = await one(`insert into framework_version (institution_id, framework_id, edition, level_labels) values ($1, $2, '2027', '["Standard"]') returning id`, [ids.inst, fw]);
  ids.iqf = await one(`insert into framework_version (institution_id, framework_id, edition, level_labels) values ($1, $2, '1', '["Standard", "Sub-standard"]') returning id`, [ids.inst, iqfFw]);
  ids.stdReq = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, official_text, review_status) values ($1, $2, 'S1', 'Standard', 'Governance and administration', 'The institution is governed under an approved charter.', 'approved') returning id`, [ids.inst, ids.std]);
  ids.stdNote = await one(`insert into requirement_note (institution_id, requirement_id, type, text, authority, review_status) values ($1, $2, 'guidance', 'Provide the charter and the board minutes.', 'example', 'approved') returning id`, [ids.inst, ids.stdReq]);
  ids.iqfReq = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, official_text, review_status) values ($1, $2, '1', 'Standard', 'Teaching quality', 'Teaching is reviewed every year.', 'approved') returning id`, [ids.inst, ids.iqf]);
  await q(`update framework_version set status = 'in_review' where id = $1`, [ids.std]);
  await q(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [ids.std, ids.admin]);
  vi.spyOn(console, 'error').mockImplementation(() => undefined); // "No job queue configured": the runs here are only started
}, 60000);
beforeEach(async () => {
  await seed();
  await q(`delete from ai_setting`);
  setAiModelForTests(createFakeAiModel([() => ({ translations: [] })]).model);
  activateLocale('en');
  resetContentLanguageForTests();
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => { cleanup(); setAiModelForTests(null); });
afterAll(async () => { await pool.end(); await db.close(); });

const openCard = async (user: ReturnType<typeof userEvent.setup>) => {
  const card = await screen.findByTestId('requirement-card');
  await user.click(within(card).getAllByRole('button')[0]!);
  return card;
};

describe('the content switcher on an external standard', () => {
  it('shows English until the secondary language is chosen, then the translation labelled unofficial, with English as the fallback', async () => {
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={ids.std!} api={apiFor('viewer')} />));
    const bar = await screen.findByTestId('translation-bar');
    const sw = within(bar).getByRole('group', { name: 'Content language' });
    expect(within(sw).getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(sw).getAllByRole('button').map((b) => b.textContent)).toEqual(['English', 'العربية']);
    await waitFor(() => expect(screen.getByTestId('content-counts').textContent).toMatch(/2 of 3 texts translated, 1 reviewed/));
    expect(screen.getByTestId('content-counts').textContent).toMatch(/1 out of date/); // the seeded hash is not the English's
    // English view: the English only, no translation anywhere.
    let card = await openCard(user);
    expect(within(card).getByText('The institution is governed under an approved charter.')).toBeTruthy();
    expect(screen.queryByTestId('content-translation')).toBeNull();
    expect(screen.queryByTestId('content-note')).toBeNull();

    await user.click(within(sw).getByRole('button', { name: 'العربية' }));
    expect(within(sw).getByRole('button', { name: 'العربية' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('content-note').textContent).toMatch(/unofficial translations.*English text is the official one/);
    card = await screen.findByTestId('requirement-card');
    // The card's title is the translation; the English description is still there beside the translated blocks.
    await waitFor(() => expect(within(card).getAllByText(TITLE_AR).length).toBeGreaterThan(0));
    expect(within(card).getByText('The institution is governed under an approved charter.')).toBeTruthy();
    const blocks = within(card).getAllByTestId('content-translation');
    expect(blocks.map((b) => within(b).getByTestId('unofficial-label').textContent)).toEqual(['Unofficial translation', 'Unofficial translation']);
    expect(blocks[0]!.textContent).toContain('AI translation, not reviewed');
    expect(blocks[1]!.textContent).toContain('Translation written by a person');
    const text = within(blocks[1]!).getByText(STATEMENT_AR);
    expect(text.getAttribute('dir')).toBe('auto');
    expect(text.getAttribute('lang')).toBe('ar');
    // The title's translation is out of date (its stored hash is not the English's): said so.
    expect(blocks[0]!.textContent).toContain('Out of date');
    // A note with no translation: its English with the fallback sentence under it.
    const note = await within(card).findByTestId('note');
    expect(within(note).getByText('Provide the charter and the board minutes.')).toBeTruthy();
    expect(within(note).getByTestId('translation-missing').textContent).toBe('Not translated yet: shown in English.');

    await user.click(within(sw).getByRole('button', { name: 'English' }));
    await waitFor(() => expect(screen.queryByTestId('content-translation')).toBeNull());
    expect(within(await screen.findByTestId('requirement-card')).queryByText(TITLE_AR)).toBeNull();
  });

  it('has no switcher or panel when the institution has no secondary language', async () => {
    await q(`update institution set secondary_language = null, default_locale = 'en'`);
    try {
      render(wrap(<VersionPage versionId={ids.std!} api={apiFor('viewer')} />));
      await screen.findByTestId('requirement-card');
      expect(screen.queryByTestId('translation-bar')).toBeNull();
      expect(screen.queryByRole('group', { name: 'Content language' })).toBeNull();
    } finally {
      await q(`update institution set secondary_language = 'ar'`);
    }
  });
});

describe('the IQF', () => {
  it('shows a list title and the detail translations without the "unofficial" label, which belongs to external standards', async () => {
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={ids.iqf!} api={apiFor('lead')} />));
    const tree = await screen.findByRole('tree', { name: 'Requirements' });
    expect(await within(tree).findByRole('button', { name: /Teaching quality/ })).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'العربية' }));
    expect(screen.getByTestId('content-note').textContent).toMatch(/quality framework/);
    const row = await within(tree).findByRole('button', { name: /جودة التدريس/ });
    await user.click(row);
    const detail = await screen.findByTestId('requirement-detail');
    const block = within(detail).getAllByTestId('content-translation')[0]!;
    expect(block.textContent).toContain('جودة التدريس');
    expect(block.textContent).toContain('AI translation, not reviewed');
    expect(within(block).queryByTestId('unofficial-label')).toBeNull();
    // The statement has no translation yet, so the fallback shows; the English field stays editable in the form.
    expect(within(detail).getByTestId('translation-missing')).toBeTruthy();
    expect((within(detail).getByLabelText(/Title/) as HTMLInputElement).value).toBe('Teaching quality');
  });
});

describe('the review dialog', () => {
  it('lists each English text beside its translation with filters, takes an edit, marks reviewed and all reviewed', async () => {
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={ids.std!} api={apiFor('lead')} />));
    await user.click(await screen.findByRole('button', { name: 'Review translations' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(3));
    expect(dialog.textContent).toContain('Unofficial translation');
    const rows = () => within(dialog).getAllByTestId('review-row');
    expect(rows()[0]!.textContent).toContain('Governance and administration');
    expect(within(rows()[0]!).getByText(TITLE_AR).closest('td')!.getAttribute('dir')).toBe('rtl');

    const filter = within(dialog).getByRole('combobox', { name: 'Show' });
    const shows = (text: string) => waitFor(() => { expect(rows()).toHaveLength(1); expect(rows()[0]!.textContent).toContain(text); });
    await user.selectOptions(filter, 'missing');
    await shows('Provide the charter');
    await user.selectOptions(filter, 'stale');
    await shows(TITLE_AR);
    await user.selectOptions(filter, 'needs_review');
    await shows(TITLE_AR);

    // Edit the missing note's translation: it becomes a person's and reviewed.
    await user.selectOptions(filter, 'missing');
    await shows('Provide the charter');
    await user.click(within(rows()[0]!).getByRole('button', { name: 'Edit' }));
    const box = within(dialog).getByRole('textbox', { name: /Translation of S1 \(Note\)/ });
    expect(box.getAttribute('dir')).toBe('rtl');
    await user.clear(box);
    await user.type(box, 'قدّم الميثاق ومحاضر المجلس.');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await q(`select text, origin, reviewed from content_translation where entity_id = $1 and field = 'note'`, [ids.stdNote])).rows[0]).toEqual({ text: 'قدّم الميثاق ومحاضر المجلس.', origin: 'person', reviewed: true }));
    // Mark the one machine translation reviewed, from the "needs review" view.
    await user.selectOptions(filter, 'needs_review');
    await shows(TITLE_AR);
    await user.click(within(rows()[0]!).getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(async () => expect((await q(`select reviewed from content_translation where entity_id = $1 and field = 'title'`, [ids.stdReq])).rows[0].reviewed).toBe(true));
    await waitFor(() => expect(within(dialog).getByText('Nothing to show for this filter.')).toBeTruthy());
    // "Mark all as reviewed" is there for what remains (nothing machine-made is left, so it changes nothing and stays quiet).
    await user.click(within(dialog).getByRole('button', { name: 'Mark all as reviewed' }));
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('content-counts').textContent).toMatch(/3 of 3 texts translated, 3 reviewed/));
  });

  it('is read-only for someone who cannot write the framework', async () => {
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={ids.std!} api={apiFor('viewer')} />));
    await user.click(await screen.findByRole('button', { name: 'Review translations' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getAllByTestId('review-row')).toHaveLength(3));
    expect(within(dialog).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Mark all as reviewed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Translate' })).toBeNull();
  });
});

describe('the Translate action', () => {
  it('starts a run for the version with progress, can be cancelled and resumed, and shows why it cannot start', async () => {
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={ids.std!} api={apiFor('lead')} />));
    const translate = await screen.findByRole('button', { name: 'Translate' });
    await waitFor(() => expect((translate as HTMLButtonElement).disabled).toBe(false));
    await user.click(translate);
    const run = await screen.findByTestId('translation-run');
    expect(within(run).getByTestId('run-status').textContent).toBe('Waiting to start');
    expect(run.textContent).toMatch(/0 of 1 translated, 0 set aside/); // only the note is still missing
    expect(within(run).getByRole('progressbar')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Translate' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(run).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toBe('Cancelled'));
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toBe('Waiting to start'));
    expect((await q(`select kind, scope_id, status from translation_run`)).rows).toEqual([{ kind: 'standard', scope_id: ids.std, status: 'queued' }]);
  });

  it('says why it cannot start when AI is switched off', async () => {
    await q(`insert into ai_setting (institution_id, enabled) values ($1, false)`, [ids.inst]);
    render(wrap(<VersionPage versionId={ids.iqf!} api={apiFor('lead')} />));
    const translate = await screen.findByRole('button', { name: 'Translate' });
    await waitFor(() => expect((translate as HTMLButtonElement).disabled).toBe(true));
    expect((await screen.findByRole('status')).textContent).toMatch(/Translation cannot start yet.*switched off/);
  });
});
