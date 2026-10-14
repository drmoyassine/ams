// @vitest-environment jsdom
// The Docs tab, the import review and Settings -> Documents (TASK-075), against the real API and database; the worker runs with a fake
// model and an invented import target (no network, no accreditor).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import {
  createFakeAiModel, handlers, registerTestTarget, runJob, setAiModelForTests, TEST_TARGET_KIND, testUnitsResponder, unregisterTestTarget, FIXTURE_HANDBOOK,
} from '@ams/core';
import type { ImportTargetInfo, JobEnvelope, JobType } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { resetConfirmForTests } from './components/confirm-dialog';
import { DocsTab, ImportReview } from './components/docs';
import { UndoToaster } from './components/undo-toaster';
import { createApi } from './lib/api';
import { documentsApi } from './lib/documents-api';
import { frameworkApi } from './lib/framework-api';
import { resetUndoForTests } from './lib/undo';
import { DocumentsPage } from './pages/settings/documents';
import { VersionPage } from './pages/version';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const queued: (JobEnvelope & { type: JobType })[] = [];
const queue = { send: async (type: JobType, e: JobEnvelope) => { queued.push({ ...e, type }); } };
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
type Who = 'lead' | 'viewer' | 'external';
const fetchAs = (who: Who) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const docsFor = (who: Who) => documentsApi(createApi(fetchAs(who)), fetchAs(who));
const apiFor = (who: Who) => frameworkApi(createApi(fetchAs(who)), fetchAs(who));
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
async function work(types: JobType[] = ['extract_text', 'import']) {
  let n = 0;
  while (n++ < 100) {
    const i = queued.findIndex((q) => types.includes(q.type));
    if (i < 0) break;
    const [{ type, ...env }] = queued.splice(i, 1) as [JobEnvelope & { type: JobType }];
    await runJob(pool, type, env, handlers, { store, queue });
  }
}

// A tiny valid PDF with the text of each page.
function pdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((t, i) => {
    const content = t.split('\n').map((line, n) => `BT /F1 12 Tf 72 ${700 - n * 16} Td (${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET`).join('\n');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
const file = (name: string, pages: string[]) => new File([pdf(pages) as unknown as BlobPart], name, { type: 'application/pdf' });
const filler = 'This page lists units of the university and describes each one at some length.';
const TARGET: ImportTargetInfo = { kind: TEST_TARGET_KIND, label: 'Units (test)', description: 'Reads unit names from a document.', itemsLabel: 'units', scopeKinds: ['org_chart'] };
const docsTab = (who: Who = 'lead', over: Partial<React.ComponentProps<typeof DocsTab>> = {}) => (
  <><DocsTab scopeKind="org_chart" scopeId={null} targets={[TARGET]} canWrite={who === 'lead'} api={docsFor(who)} {...over} /><UndoToaster /></>
);

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  registerTestTarget();
  db = await createTestDb('webdocs');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store, queue,
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [who, role, name] of [['lead', 'lead', 'Lena Lead'], ['viewer', 'viewer', 'Vera Viewer'], ['external', 'external_reviewer', 'Eli External']] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $3) returning id`, [ids.inst, name, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id, expires_at) values ($1, $2, $3, 'institution', $1, ${role === 'external_reviewer' ? "now() + interval '1 day'" : 'null'})`, [ids.inst, ids[who], role]);
  }
  await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Council', 'IC', 'institutional') returning id`, [ids.inst]);
  const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Institutional Standards', 'institution') returning id`, [ids.inst, acc]);
  ids.v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2030') returning id`, [ids.inst, fw]);
  const a = apiFor('lead');
  const hb = await a.addDocument(ids.v, { title: FIXTURE_HANDBOOK.title, role: 'standards', authority: 'binding' });
  for (const [i, text] of FIXTURE_HANDBOOK.pages.entries()) await a.setPage(hb.id, i + 1, text);
  ids.hb = hb.id;
}, 60000);
beforeEach(() => { resetUndoForTests(); resetConfirmForTests(); });
afterEach(() => { cleanup(); setAiModelForTests(null); });
afterAll(async () => { unregisterTestTarget(); await pool.end(); await db.close(); });

describe('the Docs tab', () => {
  it('starts empty, uploads many files at once with a state each, refuses what it cannot read with a Retry, and shows who and when', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(wrap(docsTab()));
    const tab = await screen.findByRole('region', { name: 'Docs' });
    expect(await within(tab).findByText(/No documents yet/)).toBeTruthy();

    const good1 = file('units-one.pdf', [`Unit: College of Arts (college)\n${filler}`]);
    const good2 = file('units-two.pdf', [`Unit: School of Law (school)\n${filler}`]);
    const bad = new File(['plain text, not a document'], 'notes.txt', { type: 'text/plain' });
    await user.upload(within(tab).getByLabelText('Files to upload'), [good1, good2, bad]);
    const uploads = await within(tab).findByRole('list', { name: 'Uploads' });
    await waitFor(() => expect(within(uploads).getAllByTestId('upload-item').map((i) => i.getAttribute('data-state')).sort()).toEqual(['done', 'done', 'failed']));
    const failed = within(uploads).getAllByTestId('upload-item').find((i) => i.getAttribute('data-state') === 'failed')!;
    expect(failed.textContent).toContain('notes.txt');
    expect(within(failed).getByRole('alert').textContent).toMatch(/cannot be read/);
    expect(within(failed).getByRole('button', { name: 'Retry notes.txt' })).toBeTruthy();
    await user.click(within(failed).getByRole('button', { name: 'Remove notes.txt from the list' }));
    expect(within(uploads).queryByText('notes.txt')).toBeNull();

    // Both stored files are listed, waiting to be read, with who uploaded them and when.
    const list = await within(tab).findByRole('list', { name: 'Documents' });
    const rows = await within(list).findAllByTestId('doc-row');
    expect(rows).toHaveLength(2);
    const row = within(list).getByRole('article', { name: 'units-one.pdf' });
    expect(row.textContent).toContain('PDF');
    expect(within(row).getByTestId('uploaded-by').textContent).toMatch(/^Uploaded by Lena Lead on \d{1,2} \w{3} \d{4}$/);
    expect(within(row).getByRole('status', { name: /Reading status of units-one.pdf/ }).textContent).toBe('Waiting');
    // The parser reads them: the list follows.
    await work(['extract_text']);
    await waitFor(() => expect(within(list).getByRole('status', { name: /Reading status of units-one.pdf: Read: 1 page/ }).textContent).toBe('Read'));
    expect(within(row).getByRole('link', { name: 'units-one.pdf' }).getAttribute('href')).toMatch(/^\/api\/documents\/[\w-]+\/file$/);

    // The same file again is refused and says where it is.
    await user.upload(within(tab).getByLabelText('Files to upload'), file('again.pdf', [`Unit: College of Arts (college)\n${filler}`]));
    expect((await within(tab).findByText(/already here as "units-one.pdf"/)).closest('[data-testid="upload-item"]')).toBeTruthy();
  }, 60000);

  it('shows a file that could not be read as Failed with the reason, and one with scanned pages as Needs OCR', async () => {
    await db.su.query(`insert into import_document (institution_id, scope_kind, file_name, mime, size, sha256, file_path, read_status, read_error, created_by) values ($1, 'org_chart', 'broken.pdf', 'application/pdf', 20, $2, 'k/b', 'failed', 'the file is damaged', $3)`, [ids.inst, 'b'.repeat(64), ids.lead]);
    const scan = await one(`insert into import_document (institution_id, scope_kind, file_name, mime, size, sha256, file_path, read_status, page_count, created_by) values ($1, 'org_chart', 'scan.pdf', 'application/pdf', 20, $2, 'k/s', 'needs_ocr', 3, $3) returning id`, [ids.inst, 'c'.repeat(64), ids.lead]);
    await db.su.query(`insert into import_page (institution_id, import_document_id, page_no, text, method, needs_ocr) values ($1, $2, 1, 'x', 'pdf_text', true), ($1, $2, 2, 'y', 'pdf_text', true), ($1, $2, 3, 'z', 'pdf_text', false)`, [ids.inst, scan]);
    await db.su.query(`insert into import_document (institution_id, scope_kind, file_name, mime, size, sha256, file_path, read_status, created_by) values ($1, 'org_chart', 'busy.pdf', 'application/pdf', 20, $2, 'k/y', 'reading', $3)`, [ids.inst, 'd'.repeat(64), ids.lead]);
    render(wrap(docsTab()));
    const broken = await screen.findByRole('article', { name: 'broken.pdf' });
    expect(within(broken).getByRole('status', { name: /Failed|Could not be read/ }).textContent).toBe('Failed');
    expect(broken.textContent).toContain('the file is damaged');
    const sc = screen.getByRole('article', { name: 'scan.pdf' });
    expect(within(sc).getByRole('status').textContent).toBe('Needs OCR');
    expect(sc.textContent).toMatch(/2 pages have no readable text/);
    expect(within(screen.getByRole('article', { name: 'busy.pdf' })).getByRole('status').textContent).toBe('Reading');
    expect((within(screen.getByRole('article', { name: 'busy.pdf' })).getByRole('button', { name: 'Read busy.pdf again' }) as HTMLButtonElement).disabled).toBe(true);
    await db.su.query(`delete from import_page where import_document_id = $1`, [scan]);
    await db.su.query(`delete from import_document where file_name in ('broken.pdf', 'scan.pdf', 'busy.pdf')`);
  });

  it('reads again and deletes with an in-app question; the file goes to the Trash and Undo brings it back', async () => {
    const user = userEvent.setup();
    render(wrap(docsTab()));
    const row = await screen.findByRole('article', { name: 'units-two.pdf' });
    await user.click(within(row).getByRole('button', { name: 'Read units-two.pdf again' }));
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'units-two.pdf' })).getByRole('status').textContent).toBe('Waiting'));
    await work(['extract_text']);
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'units-two.pdf' })).getByRole('status').textContent).toBe('Read'));

    await user.click(within(screen.getByRole('article', { name: 'units-two.pdf' })).getByRole('button', { name: 'Delete units-two.pdf' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/units-two.pdf and its 1 page will be deleted\. You can restore it, with its file, from the Trash for 30 days/);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'units-two.pdf' })).toBeNull());
    expect(await db.su.query(`select count(*)::int n from trash_item where kind = 'import_document' and label = 'units-two.pdf'`).then((r) => r.rows[0].n)).toBe(1);
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toMatch(/^Deleted units-two\.pdf and its 1 pageUndo/);
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('article', { name: 'units-two.pdf' })).toBeTruthy();
  }, 60000);

  it('shows a person who cannot write the list and the status, but no upload, no actions and no Import', async () => {
    render(wrap(docsTab('viewer')));
    const tab = await screen.findByRole('region', { name: 'Docs' });
    await within(tab).findByRole('article', { name: 'units-one.pdf' });
    expect(within(tab).queryByRole('group', { name: 'Upload documents' })).toBeNull();
    expect(within(tab).queryByRole('button', { name: /Delete units-one/ })).toBeNull();
    expect(within(tab).queryByRole('button', { name: /Import units/ })).toBeNull();
    expect(within(tab).getByRole('link', { name: 'Open units-one.pdf' })).toBeTruthy();
  });

  it('says a fixed place cannot change, and keeps the list readable', async () => {
    render(wrap(docsTab('lead', { editable: false, fixedNote: 'The documents of a published version are fixed with it.' })));
    const tab = await screen.findByRole('region', { name: 'Docs' });
    expect(await within(tab).findByText(/fixed with it/)).toBeTruthy();
    await within(tab).findByRole('article', { name: 'units-one.pdf' });
    expect(within(tab).queryByRole('group', { name: 'Upload documents' })).toBeNull();
    expect(within(tab).queryByRole('button', { name: /Import units/ })).toBeNull();
  });
});

describe('importing', () => {
  it('says why an import cannot start before anyone clicks Start, with where to fix it', async () => {
    const user = userEvent.setup();
    render(wrap(docsTab()));
    await user.click(await screen.findByRole('button', { name: 'Import units (test)' }));
    const dialog = await screen.findByRole('dialog');
    const checks = await within(dialog).findByRole('list', { name: 'Before you start' });
    await waitFor(() => expect(within(checks).getAllByTestId('preflight-check').some((c) => c.textContent?.startsWith('Fix'))).toBe(true));
    expect(within(dialog).getAllByRole('link', { name: 'Open Settings -> AI' }).length).toBeGreaterThan(0);
    expect((within(dialog).getByRole('button', { name: 'Start import' }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('runs an import with live progress, keeps a history, and opens the review: edit, accept, skip, bulk, Apply, Undo and Redo', async () => {
    const user = userEvent.setup();
    setAiModelForTests(createFakeAiModel([testUnitsResponder()]).model);
    render(wrap(docsTab()));
    // A third document with a unit the model will cite wrongly and one it is unsure of.
    const tab = await screen.findByRole('region', { name: 'Docs' });
    await user.upload(within(tab).getByLabelText('Files to upload'), file('extra.pdf', [`Unit: Phantom Faculty (other)\nUnit: Unsure Centre (other)\n${filler}`, `Unit: Library (admin_unit)\n${filler}`]));
    await screen.findByRole('article', { name: 'extra.pdf' });
    await work(['extract_text']);
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'extra.pdf' })).getByRole('status').textContent).toBe('Read'));

    await user.click(screen.getByRole('button', { name: 'Import units (test)' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('list', { name: 'Before you start' });
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Start import' }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(3);
    await user.click(within(dialog).getByRole('button', { name: 'Start import' }));

    // The strip follows the run while the worker steps through it.
    const strip = await screen.findByRole('status', { name: 'Import progress' });
    expect(strip.textContent).toMatch(/Units \(test\): Waiting for the worker/);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    await work(['import']);
    const history = await screen.findByRole('list', { name: 'Import history' });
    await waitFor(() => expect(within(history).getByTestId('import-run').textContent).toContain('Finished'));
    const entry = within(history).getByTestId('import-run');
    expect(entry.textContent).toMatch(/by Lena Lead/);
    expect(entry.textContent).toMatch(/\d+ found, .*\d+ to look at/);
    expect(screen.queryByRole('status', { name: 'Import progress' })).toBeNull();

    // The report: counts, no score.
    await user.click(within(entry).getByRole('button', { name: /Report of the Units \(test\) import/ }));
    const report = await screen.findByRole('region', { name: 'Import report' });
    expect(await within(report).findByTestId('report-counts')).toBeTruthy();
    expect(report.textContent).not.toMatch(/compliant|\bscore\b|readiness/i);
    expect(within(report).getByRole('region', { name: 'Rows to look at' }).textContent).toMatch(/Phantom Faculty[\s\S]*quote was not found/);
    await user.click(within(report).getByRole('button', { name: 'Review the proposals' }));

    // The review: a table beside the page the row came from.
    const review = await screen.findByRole('region', { name: 'Review proposals' });
    const table = await within(review).findByRole('table', { name: 'Proposals' });
    const rows = within(table).getAllByTestId('proposal');
    const names = rows.map((r) => (within(r).getByLabelText(/^Name of /) as HTMLInputElement).value);
    expect(names).toEqual(expect.arrayContaining(['College of Arts', 'School of Law', 'Phantom Faculty', 'Unsure Centre', 'Library']));
    expect((await within(review).findByTestId('source-page-text')).textContent).toContain('Unit:');
    // The row with a quote that is not on the page says so.
    const rowOf = (name: string) => screen.getAllByTestId('proposal').find((r) => within(r).queryByLabelText(`Name of ${name}`))!;
    const phantom = rowOf('Phantom Faculty');
    expect(within(phantom).getByRole('list', { name: 'To look at for Phantom Faculty' }).textContent).toMatch(/quote was not found/);
    await user.click(within(phantom).getByRole('button', { name: 'Show the source of Phantom Faculty' }));
    expect(await within(review).findByTestId('quote-missing')).toBeTruthy();

    // Edit a value in place (it keeps its direction), accept some, skip one, then Apply the rest.
    const law = rowOf('School of Law');
    const cell = within(law).getByLabelText('Name of School of Law') as HTMLInputElement;
    expect(cell.getAttribute('dir')).toBe('auto');
    await user.clear(cell);
    await user.type(cell, 'School of Law and Policy');
    await user.tab();
    await waitFor(() => expect(within(rowOf('School of Law and Policy')).getByText('Edited')).toBeTruthy());
    await user.click(within(phantom).getByRole('button', { name: 'Skip Phantom Faculty' }));
    await waitFor(() => expect(within(rowOf('Phantom Faculty')).getByText('Skipped')).toBeTruthy());
    await user.click(within(review).getByRole('button', { name: /^Accept all without a flag/ }));
    await waitFor(() => expect(screen.getAllByText('Accepted').length).toBeGreaterThan(0));
    // Select the one that is unsure and accept it on purpose.
    await user.click(screen.getByLabelText('Select Unsure Centre'));
    await user.click(within(review).getByRole('button', { name: 'Accept selected' }));
    await waitFor(() => expect(screen.getAllByTestId('proposal').every((r) => !r.textContent?.includes('Waiting'))).toBe(true));

    // Someone adds "Unsure Centre" to the org chart themselves meanwhile: Apply must leave their record alone and say so.
    await db.su.query(`insert into org_unit (institution_id, type, name_en, created_by) values ($1, 'other', 'Unsure Centre', $2)`, [ids.inst, ids.viewer]);
    const applyButton = within(review).getByRole('button', { name: /^Apply \d+$/ });
    const n = Number(applyButton.textContent!.replace('Apply ', ''));
    expect(n).toBeGreaterThanOrEqual(4);
    await user.click(applyButton);
    const confirmation = await screen.findByRole('dialog');
    expect(confirmation.textContent).toContain(`Apply ${n}`);
    expect(confirmation.textContent).toMatch(/You can undo it afterwards/);
    await user.click(within(confirmation).getByRole('button', { name: `Apply ${n}` }));
    const result = await within(review).findByTestId('apply-result');
    expect(result.textContent).toMatch(/Applied \d+ units to Org chart/);
    expect(within(result).getByRole('list', { name: 'Left alone' }).textContent).toMatch(/Unsure Centre: a unit with this name is already in the org chart/);
    const units = (await db.su.query(`select name_en, active, created_by from org_unit order by name_en`)).rows;
    expect(units.map((u) => u.name_en)).toEqual(expect.arrayContaining(['College of Arts', 'School of Law and Policy', 'Library']));
    expect(units.find((u) => u.name_en === 'Library')!.created_by).toBe(ids.lead);

    // Undo from the result, then Redo.
    await user.click(within(result).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByTestId('apply-result').textContent).toMatch(/^Undone: Applied/));
    expect((await db.su.query(`select active from org_unit where name_en = 'Library'`)).rows[0].active).toBe(false);
    await user.click(within(screen.getByTestId('apply-result')).getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(screen.getByTestId('apply-result').textContent).not.toMatch(/Undone/));
    expect((await db.su.query(`select active from org_unit where name_en = 'Library'`)).rows[0].active).toBe(true);
  }, 120000);

  it('lets a person who cannot write look at the proposals, with no way to change or apply them', async () => {
    const [run] = (await db.su.query(`select id from import_run order by created_at desc limit 1`)).rows;
    render(wrap(<ImportReview api={docsFor('viewer')} runId={run.id} canWrite={false} />));
    const review = await screen.findByRole('region', { name: 'Review proposals' });
    const table = await within(review).findByRole('table', { name: 'Proposals' });
    expect(within(table).getAllByTestId('proposal').length).toBeGreaterThan(0);
    expect(within(review).queryByRole('button', { name: /^Apply/ })).toBeNull();
    expect(within(table).queryByRole('button', { name: /^Accept / })).toBeNull();
    expect((within(table).getAllByRole('textbox')[0] as HTMLInputElement).disabled).toBe(true);
  });
});

describe('Settings -> Documents', () => {
  it('lists everything the person may see with who, when and where it is used, and filters it', async () => {
    const user = userEvent.setup();
    render(wrap(<DocumentsPage api={docsFor('lead')} />));
    const page = await screen.findByRole('region', { name: 'Documents' });
    const list = await within(page).findByRole('list', { name: 'All documents' });
    const rows = await within(list).findAllByTestId('library-row');
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const handbook = rows.find((r) => r.textContent?.includes(FIXTURE_HANDBOOK.title))!;
    const link = within(handbook).getByRole('link', { name: /is used in .* Open it/ });
    expect(link.getAttribute('href')).toBe(`/settings/versions/${ids.v}?tab=docs`);
    expect(rows.find((r) => r.textContent?.includes('units-one.pdf'))!.textContent).toMatch(/Used in Org chart/);
    expect(within(rows.find((r) => r.textContent?.includes('units-one.pdf'))!).getByTestId('uploaded-by').textContent).toContain('Lena Lead');
    expect(page.textContent).toMatch(/Evidence files are not listed here/);

    // By place.
    await user.selectOptions(within(page).getByLabelText('Place'), 'framework_version:' + ids.v);
    await waitFor(() => expect(within(page).getAllByTestId('library-row')).toHaveLength(1));
    expect(within(page).getByTestId('library-row').textContent).toContain(FIXTURE_HANDBOOK.title);
    await user.click(within(page).getByRole('button', { name: 'Clear the filters' }));
    await waitFor(() => expect(within(page).getAllByTestId('library-row').length).toBeGreaterThanOrEqual(4));
    // By name (Arabic or English file names keep their direction), by status and by type.
    await user.type(within(page).getByLabelText('Search by name'), 'units-one');
    await waitFor(() => expect(within(page).getAllByTestId('library-row')).toHaveLength(1));
    await user.clear(within(page).getByLabelText('Search by name'));
    await user.selectOptions(within(page).getByLabelText('Status'), 'read');
    await waitFor(() => expect(within(page).getAllByTestId('library-row').every((r) => r.querySelector('[data-status="read"]'))).toBe(true));
    await user.selectOptions(within(page).getByLabelText('Type'), 'PDF');
    await waitFor(() => expect(within(page).getAllByTestId('library-row').length).toBeGreaterThan(0));
    await user.type(within(page).getByLabelText('Search by name'), 'zzz-nothing');
    await waitFor(() => expect(within(page).queryAllByTestId('library-row')).toHaveLength(0));
    expect(within(page).getByText('No document matches these filters.')).toBeTruthy();
    // By uploader and date.
    await user.click(within(page).getByRole('button', { name: 'Clear the filters' }));
    const uploader = within(page).getByLabelText('Uploaded by');
    expect(within(uploader).getAllByRole('option').map((o) => o.textContent)).toEqual(['Anyone', 'Lena Lead']); // only people who uploaded something
    await user.selectOptions(uploader, ids.lead!);
    await waitFor(() => expect(within(page).getAllByTestId('library-row').length).toBeGreaterThan(0));
    await user.type(within(page).getByLabelText('Uploaded from'), '2000-01-01');
    await user.type(within(page).getByLabelText('Uploaded until'), '2000-12-31');
    await waitFor(() => expect(within(page).queryAllByTestId('library-row')).toHaveLength(0));
  }, 60000);

  it('shows an external reviewer nothing and a viewer the same list without any action but the links', async () => {
    render(wrap(<DocumentsPage api={docsFor('external')} />));
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    render(wrap(<DocumentsPage api={docsFor('viewer')} />));
    const list = await screen.findByRole('list', { name: 'All documents' });
    await within(list).findAllByTestId('library-row');
    expect(screen.queryByRole('button', { name: /Delete|Upload|Import/ })).toBeNull();
  });
});

describe('the version page', () => {
  it('has a Docs tab between Report and Settings, which holds what Sources held, and Settings no longer has Sources', async () => {
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Requirements', 'Mappings', 'Report', 'Docs', 'Settings']);
    await user.click(screen.getByRole('tab', { name: 'Docs' }));
    const docs = await screen.findByRole('region', { name: 'Docs' });
    expect(await within(docs).findByRole('region', { name: 'Analysis' })).toBeTruthy();
    const card = await within(docs).findByRole('region', { name: FIXTURE_HANDBOOK.title });
    expect(within(card).getByRole('button', { name: /^Standards/ })).toBeTruthy();
    expect(within(docs).getByRole('group', { name: 'Upload documents' })).toBeTruthy();
    expect(within(docs).getByRole('button', { name: '+ Source' })).toBeTruthy();
    // Who uploaded it and when is on the card.
    await user.click(within(card).getByRole('button', { name: /^Standards/ }));
    expect(within(card).getByTestId('uploaded-by').textContent).toContain('Lena Lead');
    // Settings keeps the rest, without Sources.
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    const nav = await screen.findByRole('navigation', { name: 'Standard settings' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Details', 'Lifecycle and vocabularies', 'Report templates', 'Terminology']);
  });

  it('opens the Docs tab on a source page from a deep link, and treats the old Sources address as the Docs tab', async () => {
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('viewer')} initialFocusPage={{ documentId: ids.hb!, page: 3 }} onOpenVersion={() => undefined} />));
    expect(await screen.findByRole('tab', { name: 'Docs', selected: true })).toBeTruthy();
    const card = await screen.findByRole('region', { name: FIXTURE_HANDBOOK.title });
    expect(await within(card).findByRole('tab', { name: '3', selected: true })).toBeTruthy();
    cleanup();
    render(wrap(<VersionPage versionId={ids.v!} api={apiFor('viewer')} initialTab="settings" initialSection="sources" onOpenVersion={() => undefined} />));
    expect(await screen.findByRole('tab', { name: 'Docs', selected: true })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Docs' })).toBeTruthy();
  });
});
