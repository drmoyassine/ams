// @vitest-environment jsdom
// F2 in the browser, against the real API and database: "Create from files" (progress, failed file and retry, nothing
// created on refusal), and the Requirements tab's split view (source page with the quote highlighted, bottom sheet on small
// screens), "Needs a look", merge and split. The model is fake; nothing touches the network.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createFakeAiModel, fixtureResponder, setAiModelForTests } from '@ams/core';
import type { JobEnvelope } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { frameworkApi, type FrameworkApi } from './lib/framework-api';
import { CreateFromFilesDialog } from './pages/create-from-files';
import { FrameworksPage } from './pages/frameworks';
import { VersionPage } from './pages/version';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const queued: JobEnvelope[] = [];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetchAs = (who: 'lead' | 'viewer') => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apiFor = (who: 'lead' | 'viewer'): FrameworkApi => frameworkApi(createApi(fetchAs(who)), fetchAs(who));
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
/** jsdom has no media queries: say whether the screen is wide enough (1280px) for the viewer beside the list. */
function screenIs(wide: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: wide && q.includes('1280'), media: q, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
const pdf = (name: string, size = 100) => new File([new Uint8Array(size)], name, { type: 'application/pdf' });
const sized = (f: File, size: number) => { Object.defineProperty(f, 'size', { value: size }); return f; };

const AR_PAGE = 'المعيار الأول\nيَجِبُ أَنْ تَكُونَ لِلْمُؤَسَّسَةِ رِسَالَةٌ مُعْلَنَةٌ وَمُعْتَمَدَةٌ.\nتُراجَعُ الرِّسَالَةُ كُلَّ سَنَةٍ.';
const EN_PAGE = 'Standard 2\nThe institution must publish its mission statement. It must also review the statement every year.';
const ARABIC_PHRASE = 'يَجِبُ أَنْ تَكُونَ لِلْمُؤَسَّسَةِ رِسَالَةٌ مُعْلَنَةٌ';

/** A draft version with one source of three pages and requirements shaped for the scenarios below; codes start with `p`. */
async function seed(p: string, edition: string) {
  const acc = ids.acc ?? (ids.acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Council', 'IC', 'institutional') returning id`, [ids.inst]));
  const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, $3, 'institution') returning id`, [ids.inst, acc, `Standards ${edition}`]);
  const v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, $3) returning id`, [ids.inst, fw, edition]);
  const doc = await one(`insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256, file_name, mime) values ($1,$2,'Handbook','standards','binding','p',$3,'handbook.pdf','application/pdf') returning id`, [ids.inst, v, 'a'.repeat(64)]);
  await db.su.query(`insert into source_page (institution_id, source_document_id, page_no, text, method) values ($1,$2,1,$3,'pdf_text'),($1,$2,2,$4,'pdf_text'),($1,$2,3,'A third page without it.','pdf_text')`, [ids.inst, doc, AR_PAGE, EN_PAGE]);
  const req = (code: string, o: { parent?: string; text?: string; page?: number; quote?: string; verified?: boolean; order?: number } = {}) => one(
    `insert into requirement (institution_id, framework_version_id, parent_id, code, level_label, title, official_text, origin, source_document_id, source_page, source_quote, quote_verified, display_order)
     values ($1,$2,$3,$4,'Standard',$5,$6,'ai',$7,$8,$9,$10,$11) returning id`,
    [ids.inst, v, o.parent ?? null, code, `Title ${code}`, o.text ?? null, o.quote ? doc : null, o.page ?? null, o.quote ?? null, o.verified ?? false, o.order ?? 0]);
  const r = {
    arabic: await req(`${p}1`, { text: 'يجب أن تكون للمؤسسة رسالة معلنة ومعتمدة.', page: 1, quote: 'يجب أن تكون للمؤسسة رسالة معلنة', verified: true }),
    english: undefined as unknown as string, lost: '', low: '', orphan: '',
  };
  r.english = await req(`${p}1.1`, { parent: r.arabic, text: 'The institution must publish its mission statement. It must also review the statement every year.', page: 2, quote: 'must publish its mission statement', verified: true });
  r.lost = await req(`${p}2`, { text: 'A sentence the page does not contain.', page: 1, quote: 'a sentence that is nowhere on the page', verified: false, order: 1 });
  r.low = await req(`${p}3`, { text: 'Uncertain wording.', order: 2 });
  r.orphan = await req(`${p}4.1`, { text: 'Placed at the top level.', order: 3 });
  const note = (req: string, text: string, authority: string, quote?: string) => one(
    `insert into requirement_note (institution_id, requirement_id, type, text, authority, origin, source_document_id, source_page, source_quote, quote_verified)
     values ($1,$2,'guidance',$3,$4,'ai',$5,$6,$7,$8) returning id`, [ids.inst, req, text, authority, quote ? doc : null, quote ? 2 : null, quote ?? null, !!quote]);
  const n1 = await note(r.english, 'Review the statement every year.', 'suggested', 'review the statement every year');
  const n2 = await note(r.english, 'Consider a student survey.', 'ai_suggested');
  const log = (kind: string, item: object) => db.su.query(`insert into extraction_item (institution_id, framework_version_id, kind, payload) values ($1,$2,$3,$4)`, [ids.inst, v, kind, JSON.stringify({ item, documentId: doc, seq: 0, window: 0 })]);
  await log('requirement', { kind: 'requirement', temp_id: 'x', code: `${p}3`, text: 'x', source: { page: 1, quote: 'q' }, confidence: 0.3, flags: [] });
  await log('requirement', { kind: 'requirement', temp_id: 'y', code: `${p}4.1`, parent_code: `${p}4`, text: 'x', source: { page: 1, quote: 'q' }, confidence: 0.9, flags: [] });
  return { v, doc, fw, ...r, n1, n2 };
}
const versionPage = (v: string, who: 'lead' | 'viewer' = 'lead') => <VersionPage versionId={v} api={apiFor(who)} onOpenVersion={() => undefined} />;
const card = async (name: string) => screen.findByRole('region', { name });
const openCard = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  const c = await card(name);
  await user.click(within(c).getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')}`) }));
  return c;
};

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('webreview');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store, queue: { send: async (_t, e) => { queued.push(e); } },
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [who, role] of [['lead', 'lead'], ['viewer', 'viewer']] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[who], role]);
  }
}, 30000);
afterEach(() => { cleanup(); setAiModelForTests(null); Reflect.deleteProperty(window, 'matchMedia'); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('Create from files', () => {
  it('is the primary button beside the manual one, for people who can write', async () => {
    render(wrap(<FrameworksPage api={apiFor('viewer')} />));
    await screen.findByText(/No standards yet/);
    expect(screen.queryByRole('button', { name: 'Create from files' })).toBeNull();
    cleanup();
    render(wrap(<FrameworksPage api={apiFor('lead')} />));
    expect(await screen.findByRole('button', { name: 'Create from files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Standard' })).toBeTruthy(); // the manual flow stays
  });

  it('lists each chosen file with its type and size, lets one be removed, explains an oversize file, and enables the button only when it can work', async () => {
    const user = userEvent.setup();
    render(wrap(<FrameworksPage api={apiFor('lead')} />));
    await user.click(await screen.findByRole('button', { name: 'Create from files' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create from files' });
    const submit = within(dialog).getByRole('button', { name: 'Create and analyse' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // No accreditors yet: the new-accreditor fields are showing.
    await user.type(within(dialog).getByLabelText('Accreditor name'), 'Gulf Council');
    await user.type(within(dialog).getByLabelText('Accreditor short name'), 'GC');
    await user.type(within(dialog).getByLabelText('Standard name'), 'Institutional Standards');
    await user.type(within(dialog).getByLabelText('Edition'), '2027');
    expect(within(dialog).getByText(/the analysis can suggest them later/)).toBeTruthy();
    expect(submit.disabled).toBe(true); // no files yet
    const input = within(dialog).getByLabelText('Choose files') as HTMLInputElement;
    expect(input.multiple).toBe(true);
    await user.upload(input, [pdf('Handbook 2027.pdf', 2 * 1048576), new File(['x'], 'دليل المعايير.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), sized(pdf('Huge.pdf'), 80 * 1048576)]);
    const rows = await within(dialog).findAllByTestId('chosen-file');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Handbook 2027.pdf'), expect.stringContaining('دليل المعايير.docx'), expect.stringContaining('Huge.pdf'),
    ]);
    expect(rows[0]!.textContent).toContain('PDF · 2.0 MB');
    expect(rows[1]!.textContent).toContain('Word · 1 B');
    expect(rows[1]!.querySelector('[dir="auto"]')?.textContent).toBe('دليل المعايير.docx');
    expect(within(rows[2]!).getByRole('alert').textContent).toMatch(/larger than 50\.0 MB/);
    expect(submit.disabled).toBe(true); // the oversize file blocks it, with the reason shown
    await user.click(within(dialog).getByRole('button', { name: 'Remove Huge.pdf' }));
    expect(within(dialog).getAllByTestId('chosen-file')).toHaveLength(2);
    expect(submit.disabled).toBe(false);
    // Dropping files works like choosing them.
    fireEvent.drop(within(dialog).getByRole('group', { name: 'Drop files here' }), { dataTransfer: { files: [pdf('criteria.pdf')] } });
    expect(await within(dialog).findAllByTestId('chosen-file')).toHaveLength(3);
  });

  it('creates the draft, saves each file, and when the analysis cannot start keeps everything and says why', async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    render(wrap(<CreateFromFilesDialog api={apiFor('lead')} onClose={() => undefined} onOpenVersion={(id) => opened.push(id)} />));
    const dialog = await screen.findByRole('dialog', { name: 'Create from files' });
    await user.type(within(dialog).getByLabelText('Accreditor name'), 'Gulf Council');
    await user.type(within(dialog).getByLabelText('Accreditor short name'), 'GC');
    await user.type(within(dialog).getByLabelText('Standard name'), 'Institutional Standards');
    await user.selectOptions(within(dialog).getByLabelText('Scope'), 'both');
    await user.type(within(dialog).getByLabelText('Edition'), '2027');
    await user.upload(within(dialog).getByLabelText('Choose files'), [pdf('Handbook.pdf'), pdf('دليل.pdf')]);
    await user.click(within(dialog).getByRole('button', { name: 'Create and analyse' }));

    const summary = await within(dialog).findByTestId('created-summary');
    expect(summary.textContent).toMatch(/Accreditor Gulf Council \(new\)/);
    expect(summary.textContent).toMatch(/Standard Institutional Standards/);
    expect(summary.textContent).toMatch(/Draft edition 2027 with 2 sources/);
    await waitFor(() => expect(within(dialog).getAllByTestId('upload-row').map((r) => r.textContent)).toEqual([expect.stringContaining('Saved'), expect.stringContaining('Saved')]));
    // No AI is set up in this institution: the creation stands, the reason is shown, and the draft can be opened.
    const alert = await within(dialog).findByText(/The analysis did not start:/);
    expect(alert.textContent).toMatch(/AI/);
    expect(within(dialog).getByText(/The draft and the 2 saved files are kept/)).toBeTruthy();
    expect(opened).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Open the draft' }));
    expect(opened).toHaveLength(1);
    // What is in the database: the standard, a draft, two sources with their files, role left to the analysis.
    const docs = (await db.su.query(`select title, file_name, role_origin, size from source_document where framework_version_id = $1 order by title`, [opened[0]])).rows;
    expect(docs.map((d) => [d.title, d.file_name, d.role_origin])).toEqual([['Handbook', 'Handbook.pdf', 'unset'], ['دليل', 'دليل.pdf', 'unset']]);
    expect((await db.su.query(`select scope from framework where name = 'Institutional Standards'`)).rows[0].scope).toBe('both');
    expect((await db.su.query(`select count(*)::int as n from analysis_run where framework_version_id = $1`, [opened[0]])).rows[0].n).toBe(0);
  });

  it('shows a file that failed with a retry, and starts the analysis and opens the draft once every file is saved (existing accreditor picked from the list)', async () => {
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
    const user = userEvent.setup();
    const real = apiFor('lead');
    let calls = 0;
    const flaky: FrameworkApi = { ...real, uploadSourceFile: async (id, f) => { if (f.name === 'second.pdf' && calls++ === 0) throw new TypeError('network down'); return real.uploadSourceFile(id, f); } };
    const opened: string[] = [];
    render(wrap(<CreateFromFilesDialog api={flaky} onClose={() => undefined} onOpenVersion={(id) => opened.push(id)} />));
    const dialog = await screen.findByRole('dialog', { name: 'Create from files' });
    // The accreditor made by the previous test is offered.
    const accreditor = await within(dialog).findByLabelText('Accreditor');
    await waitFor(() => expect((accreditor as HTMLSelectElement).options.length).toBe(2));
    expect((accreditor as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('GC · Gulf Council');
    expect(within(dialog).queryByLabelText('Accreditor name')).toBeNull();
    await user.type(within(dialog).getByLabelText('Standard name'), 'Programme Standards');
    await user.type(within(dialog).getByLabelText('Edition'), '2028');
    await user.upload(within(dialog).getByLabelText('Choose files'), [pdf('first.pdf'), pdf('second.pdf')]);
    await user.click(within(dialog).getByRole('button', { name: 'Create and analyse' }));

    const retry = await within(dialog).findByRole('button', { name: 'Retry second.pdf' });
    const rows = within(dialog).getAllByTestId('upload-row');
    expect(rows[0]!.textContent).toContain('Saved');
    expect(rows[1]!.textContent).toContain('Not saved');
    expect(rows[1]!.textContent).toMatch(/connection was lost/);
    expect(within(dialog).getByText(/1 of 2 files could not be saved/)).toBeTruthy();
    expect((await db.su.query(`select count(*)::int as n from accreditor where short_name = 'GC'`)).rows[0].n).toBe(1); // reused, not duplicated
    expect(opened).toEqual([]);

    await user.click(retry);
    await waitFor(() => expect(opened).toHaveLength(1));
    expect((await db.su.query(`select status from analysis_run where framework_version_id = $1`, [opened[0]])).rows.map((r) => r.status)).toEqual(['queued']);
    const files = (await db.su.query(`select file_name from source_document where framework_version_id = $1 order by title`, [opened[0]])).rows;
    expect(files.map((f) => f.file_name)).toEqual(['first.pdf', 'second.pdf']);
  });

  it('goes back to the form with the reason when the server refuses, and nothing was created', async () => {
    const user = userEvent.setup();
    render(wrap(<CreateFromFilesDialog api={apiFor('lead')} onClose={() => undefined} onOpenVersion={() => undefined} />));
    const dialog = await screen.findByRole('dialog', { name: 'Create from files' });
    const standards = (await db.su.query(`select count(*)::int as n from framework`)).rows[0].n;
    await within(dialog).findByLabelText('Accreditor');
    await waitFor(() => expect((within(dialog).getByLabelText('Accreditor') as HTMLSelectElement).options.length).toBe(2));
    await user.type(within(dialog).getByLabelText('Standard name'), 'programme standards'); // the accreditor has one by this name already
    await user.type(within(dialog).getByLabelText('Edition'), '2029');
    await user.upload(within(dialog).getByLabelText('Choose files'), [pdf('a.pdf')]);
    await user.click(within(dialog).getByRole('button', { name: 'Create and analyse' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toMatch(/already has a standard called/);
    expect(alert.textContent).toMatch(/Nothing was created/);
    expect(within(dialog).getByRole('button', { name: 'Create and analyse' })).toBeTruthy(); // still the form, files kept
    expect(within(dialog).getAllByTestId('chosen-file')).toHaveLength(1);
    expect((await db.su.query(`select count(*)::int as n from framework`)).rows[0].n).toBe(standards);
  });
});

describe('split view on the Requirements tab', () => {
  it('beside the list on a wide screen: selecting a requirement shows its page with the quote highlighted (Arabic with marks), and another requirement updates it', async () => {
    screenIs(true);
    const s = await seed('w', '2040');
    const user = userEvent.setup();
    render(wrap(versionPage(s.v)));
    const panel = await screen.findByTestId('source-panel');
    expect(panel.textContent).toMatch(/Select a requirement or a note/);
    await openCard(user, 'w1');
    await waitFor(() => expect(within(panel).getByTestId('source-highlight').textContent).toBe(ARABIC_PHRASE));
    expect(within(panel).getByTestId('source-document').textContent).toBe('Handbook');
    expect(within(panel).getByRole('status', { name: 'Page' }).textContent).toBe('Page 1 (1 of 3 stored)');
    expect(within(panel).getByTestId('source-page-text').getAttribute('dir')).toBe('auto');
    expect(within(panel).getByTestId('source-page-text').textContent).toBe(AR_PAGE); // the page as stored, nothing rewritten

    await openCard(user, 'w1.1');
    await waitFor(() => expect(within(panel).getByTestId('source-highlight').textContent).toBe('must publish its mission statement'));
    expect(within(panel).getByRole('status', { name: 'Page' }).textContent).toBe('Page 2 (2 of 3 stored)');
    // The list and the viewer are separate scroll areas.
    expect(screen.getByTestId('requirement-list').className).toMatch(/overflow-y-auto/);
    expect(panel.className).toMatch(/overflow-y-auto/);

    // Previous and next page: the quote is only marked on the page it is on.
    await user.click(within(panel).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(within(panel).getByRole('status', { name: 'Page' }).textContent).toMatch(/^Page 3/));
    expect(within(panel).queryByTestId('source-highlight')).toBeNull();
    expect((await within(panel).findByTestId('quote-missing')).textContent).toMatch(/not found on this page/);
    expect((within(panel).getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(panel).getByRole('button', { name: 'Back to the cited page (2)' }));
    await waitFor(() => expect(within(panel).getByTestId('source-highlight')).toBeTruthy());
  });

  it('says when the quote is not found and shows the page without a highlight; a note has its own source, and one item can cite several', async () => {
    screenIs(true);
    const s = await seed('x', '2041');
    const user = userEvent.setup();
    render(wrap(versionPage(s.v)));
    const panel = await screen.findByTestId('source-panel');
    await openCard(user, 'x2');
    const missing = await within(panel).findByTestId('quote-missing');
    expect(missing.textContent).toMatch(/The quote was not found on this page, so nothing is highlighted/);
    expect(within(panel).queryByTestId('source-highlight')).toBeNull();
    expect(within(panel).getByTestId('source-page-text').textContent).toBe(AR_PAGE);

    // x1.1 cites page 2 and has a note citing page 2 as well: a picker between the two appears.
    const c = await openCard(user, 'x1.1');
    await waitFor(() => expect(within(panel).getByRole('group', { name: 'Sources this item cites' })).toBeTruthy());
    const picks = within(within(panel).getByRole('group', { name: 'Sources this item cites' })).getAllByRole('button');
    expect(picks.map((b) => b.textContent)).toEqual([expect.stringContaining('x1.1 · Handbook, page 2'), expect.stringContaining('Review the statement every year')]);
    // Selecting the note from the card makes its quote the highlight.
    const note = (await within(c).findAllByTestId('note')).find((n) => n.textContent?.includes('Review the statement'))!;
    await user.click(within(note).getByRole('button', { name: 'Show the source of this note' }));
    await waitFor(() => expect(within(panel).getByTestId('source-highlight').textContent).toBe('review the statement every year'));
    expect(panel.textContent).toContain('(note)');
    // The note that cites nothing offers no Source button.
    const plain = (await within(c).findAllByTestId('note')).find((n) => n.textContent?.includes('student survey'))!;
    expect(within(plain).queryByRole('button', { name: 'Show the source of this note' })).toBeNull();
  });

  it('opens the page in the Sources section from the viewer', async () => {
    screenIs(true);
    const s = await seed('y', '2042');
    const user = userEvent.setup();
    render(wrap(versionPage(s.v)));
    const panel = await screen.findByTestId('source-panel');
    await openCard(user, 'y1');
    await user.click(await within(panel).findByRole('button', { name: 'Open in Sources' }));
    const sources = await screen.findByRole('region', { name: 'Sources' });
    const handbook = await within(sources).findByRole('region', { name: 'Handbook' });
    expect(await within(handbook).findByRole('tab', { name: '1', selected: true })).toBeTruthy();
  });

  it('on a small screen the source opens in a bottom sheet from the card\'s Source button, and closes with Escape', async () => {
    screenIs(false);
    const s = await seed('z', '2043');
    const user = userEvent.setup();
    render(wrap(versionPage(s.v)));
    expect(screen.queryByTestId('source-panel')).toBeNull();
    const c = await openCard(user, 'z1');
    expect(screen.queryByRole('dialog')).toBeNull(); // opening a card does not cover the screen
    await user.click(within(c).getByRole('button', { name: 'Show the source of z1' }));
    const sheet = await screen.findByRole('dialog', { name: 'Where this comes from' });
    await waitFor(() => expect(within(sheet).getByTestId('source-highlight').textContent).toBe(ARABIC_PHRASE));
    // Another requirement, another page, in the same sheet.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const c2 = await openCard(user, 'z1.1');
    await user.click(within(c2).getByRole('button', { name: 'Show the source of z1.1' }));
    const sheet2 = await screen.findByRole('dialog', { name: 'Where this comes from' });
    await waitFor(() => expect(within(sheet2).getByTestId('source-highlight').textContent).toBe('must publish its mission statement'));
    await user.click(within(sheet2).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Needs a look', () => {
  it('counts what needs a look, filters the list to each reason, and walks through the items with "Next"', async () => {
    screenIs(false);
    const s = await seed('n', '2044');
    const user = userEvent.setup();
    render(wrap(versionPage(s.v)));
    const bar = await screen.findByRole('region', { name: 'Needs a look' });
    // quote not found: n2 and the note quoting nothing is not counted; low confidence: n3; no parent: n4.1; suggested: the AI-suggested note.
    await waitFor(() => expect(within(bar).getByTestId('look-count-quoteNotFound').textContent).toBe('(1)'));
    expect(within(bar).getByTestId('look-count-lowConfidence').textContent).toBe('(1)');
    expect(within(bar).getByTestId('look-count-orphan').textContent).toBe('(1)');
    expect(within(bar).getByTestId('look-count-suggested').textContent).toBe('(1)');
    expect(screen.getAllByTestId('requirement-card')).toHaveLength(5);

    await user.click(within(bar).getByRole('button', { name: /Low confidence/ }));
    expect(screen.getAllByTestId('requirement-card').map((c) => c.getAttribute('aria-label'))).toEqual(['n3']);
    expect(within(bar).getByRole('button', { name: /Low confidence/ }).getAttribute('aria-pressed')).toBe('true');
    await user.click(within(bar).getByRole('button', { name: /No parent found/ }));
    expect(screen.getAllByTestId('requirement-card').map((c) => c.getAttribute('aria-label'))).toEqual(['n4.1']);
    expect(within(screen.getByRole('region', { name: 'n4.1' })).getByTestId('look-reason').textContent).toBe('No parent found');
    await user.click(within(bar).getByRole('button', { name: /Suggested by the analysis/ }));
    // The suggested note is inside n1.1, so n1.1 and its parent n1 stay for context.
    expect(screen.getAllByTestId('requirement-card').map((c) => c.getAttribute('aria-label'))).toEqual(['n1', 'n1.1']);
    await user.click(within(bar).getByRole('button', { name: 'Show all' }));
    expect(screen.getAllByTestId('requirement-card')).toHaveLength(5);

    // "Next" opens and focuses each item in turn, notes included, then starts again.
    const next = within(bar).getByRole('button', { name: 'Next item that needs a look' });
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      await user.click(next);
      await waitFor(() => expect(document.activeElement !== next && document.activeElement !== document.body).toBe(true));
      seen.push(document.activeElement!.closest('[data-testid="note"]')?.id ?? document.activeElement!.closest('section')?.getAttribute('aria-label') ?? '?');
    }
    expect(seen.slice(0, 4).filter((x) => x.startsWith('note-'))).toHaveLength(1); // the suggested note
    expect(new Set(seen.slice(0, 4)).size).toBe(4);
    expect(seen[4]).toBe(seen[0]); // wrapped round
    // The same from the keyboard.
    const before = document.activeElement;
    await user.keyboard('n');
    await waitFor(() => expect(document.activeElement).not.toBe(before));
  });

  it('says so when nothing needs a look, and is not shown for an empty version', async () => {
    screenIs(false);
    const acc = ids.acc!;
    const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Clean', 'institution') returning id`, [ids.inst, acc]);
    const v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2045') returning id`, [ids.inst, fw]);
    render(wrap(versionPage(v)));
    await screen.findByText('No requirements yet.');
    expect(screen.queryByRole('region', { name: 'Needs a look' })).toBeNull();
    await db.su.query(`insert into requirement (institution_id, framework_version_id, code, level_label, title, origin) values ($1,$2,'C1','Standard','Clean one','manual')`, [ids.inst, v]);
    cleanup();
    render(wrap(versionPage(v)));
    const bar = await screen.findByRole('region', { name: 'Needs a look' });
    expect(bar.textContent).toMatch(/Nothing needs a look/);
    expect((within(bar).getByRole('button', { name: 'Next item that needs a look' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Merge, split and move', () => {
  const menuOf = async (user: ReturnType<typeof userEvent.setup>, code: string, item: string) => {
    await user.click(await screen.findByRole('button', { name: `Actions for ${code}` }));
    await user.click(await screen.findByRole('menuitem', { name: item }));
  };

  it('merges a requirement into another found by code, moving its notes and items, and says what moved', async () => {
    screenIs(false);
    const s = await seed('m', '2046');
    const user = userEvent.setup();
    render(wrap(versionPage(s.v)));
    await menuOf(user, 'm1', 'Merge into another requirement');
    const dialog = await screen.findByRole('dialog', { name: 'Merge m1 into another requirement' });
    // m1 has one item (m1.1); the target cannot be m1 itself or inside it.
    await waitFor(() => expect(dialog.textContent).toMatch(/Its 0 notes and 1 item move/));
    await user.type(within(dialog).getByLabelText('Search the requirement to merge into'), 'm1');
    expect(within(dialog).queryByRole('option', { name: /m1\.1/ })).toBeNull();
    await user.clear(within(dialog).getByLabelText('Search the requirement to merge into'));
    await user.type(within(dialog).getByLabelText('Search the requirement to merge into'), 'title m2');
    const option = within(dialog).getByRole('option', { name: /m2/ });
    expect((within(dialog).getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(option).getByRole('button'));
    expect(within(dialog).getByTestId('merge-summary').textContent).toBe('Merge m1 into m2.');
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));
    const notice = await screen.findByText(/Merged m1 into m2: 0 notes and 1 item moved/);
    expect(notice).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'm1' })).toBeNull());
    const rows = (await db.su.query(`select code, parent_id, edited_by_person from requirement where framework_version_id = $1 order by code`, [s.v])).rows;
    expect(rows.find((r) => r.code === 'm1.1')).toMatchObject({ parent_id: s.lost, edited_by_person: true });
  });

  it('splits the selected part of a requirement into a new one with its own code', async () => {
    screenIs(false);
    const s = await seed('q', '2047');
    const user = userEvent.setup();
    render(wrap(versionPage(s.v)));
    await menuOf(user, 'q1.1', 'Split');
    const dialog = await screen.findByRole('dialog', { name: 'Split q1.1' });
    const text = within(dialog).getByLabelText('Description') as HTMLTextAreaElement;
    const part = 'It must also review the statement every year.';
    expect((within(dialog).getByRole('button', { name: 'Split' }) as HTMLButtonElement).disabled).toBe(true);
    // Selecting in the text box (mouse, keyboard or touch) fills the part.
    text.focus();
    text.setSelectionRange(text.value.indexOf(part), text.value.indexOf(part) + part.length);
    fireEvent.select(text);
    expect((within(dialog).getByLabelText('Part to move out') as HTMLTextAreaElement).value).toBe(part);
    await user.type(within(dialog).getByLabelText('New code'), 'q1.2');
    const preview = within(dialog).getByTestId('split-preview');
    expect(preview.textContent).toContain('The institution must publish its mission statement.');
    await user.click(within(dialog).getByRole('button', { name: 'Split' }));
    await screen.findByText(/Split q1\.1: q1\.2 was created/);
    const created = await screen.findByRole('region', { name: 'q1.2' });
    expect(created).toBeTruthy();
    const row = (await db.su.query(`select official_text, quote_verified, origin, source_page from requirement where framework_version_id = $1 and code = 'q1.2'`, [s.v])).rows[0];
    expect(row).toMatchObject({ official_text: part, origin: 'manual', source_page: 2 });
    expect(row.quote_verified).toBe(true);
    // A part that is not in the text is refused in the dialog before anything is sent.
    await menuOf(user, 'q2', 'Split');
    const again = await screen.findByRole('dialog', { name: 'Split q2' });
    await user.type(within(again).getByLabelText('Part to move out'), 'words that are not there');
    expect(within(again).getByRole('alert').textContent).toMatch(/not in the description/);
    expect((within(again).getByRole('button', { name: 'Split' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves a requirement under another one, or to the top level', async () => {
    screenIs(false);
    const s = await seed('v', '2048');
    const user = userEvent.setup();
    render(wrap(versionPage(s.v)));
    await menuOf(user, 'v1.1', 'Move to…');
    const dialog = await screen.findByRole('dialog', { name: 'Move v1.1' });
    await user.click(within(within(dialog).getByRole('option', { name: 'Top level' })).getByRole('button'));
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await db.su.query(`select parent_id from requirement where id = $1`, [s.english])).rows[0].parent_id).toBeNull();
  });

  it('offers none of these on a version nobody can edit', async () => {
    screenIs(false);
    const s = await seed('k', '2049');
    // The publish gate wants every AI-made item sourced: the ones this scenario left without a source become a person's.
    await db.su.query(`update requirement_note set origin = 'manual' where source_document_id is null and requirement_id in (select id from requirement where framework_version_id = $1)`, [s.v]);
    await db.su.query(`update requirement set origin = 'manual' where source_document_id is null and framework_version_id = $1`, [s.v]);
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [s.v]);
    await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [s.v, ids.lead]);
    const user = userEvent.setup();
    render(wrap(versionPage(s.v)));
    await user.click(await screen.findByRole('button', { name: 'Actions for k1' }));
    const items = (await screen.findAllByRole('menuitem')).map((m) => m.textContent);
    expect(items).toEqual(['Show source']);
  });
});
