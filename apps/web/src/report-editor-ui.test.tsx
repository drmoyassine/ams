// @vitest-environment jsdom
// The report editor (TASK-092): the section tree, the narrative with its word count, limit and citations, the data
// table, the attestation with its uploaded letter, the appendix, and who may do what. Runs against the real API and
// database, like the other screens' tests.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import type { EngagementDetail } from '@ams/shared';
import './i18n';
import { createApi } from './lib/api';
import { evidenceApi } from './lib/evidence-api';
import { frameworkApi } from './lib/framework-api';
import { reportApi } from './lib/report-api';
import { ReportPage } from './pages/reports/report-page';
import { ReportsTab } from './pages/engagement/reports-tab';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
type Who = 'lead' | 'viewer';
const fetchAs = (who: Who) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
/** The page talks to api clients built on this fetcher; the tests hand them to the page as props. */
const clientFor = (who: Who) => {
  const f = fetchAs(who);
  const a = createApi(f);
  return { report: reportApi(a, f), evidence: evidenceApi(a, f), fw: frameworkApi(a) };
};

function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}

const STRUCTURE = {
  sections: [
    { key: 'intro', title: 'Introduction', block_type: 'narrative', requirement_codes: ['1.1'], word_limit: 5, prompt: 'Say what the institution is.' },
    { key: 'data', title: 'Data', block_type: 'data_table', columns: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'count', label: 'Count', type: 'number' }] },
    { key: 'attest', title: 'Attestation', block_type: 'attestation' },
    { key: 'docs', title: 'Documents', block_type: 'appendix' },
  ],
};

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // ProseMirror measures the selection to scroll it into view; jsdom has no layout, so the rects are empty boxes.
  const zeroRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as unknown as DOMRect;
  Range.prototype.getClientRects = () => [zeroRect()] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = zeroRect;
  window.scrollTo = () => undefined;
  db = await createTestDb('reporteditor');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store, queue: { send: async () => undefined },
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [who, role] of [['lead', 'lead'], ['viewer', 'viewer']] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[who], role]);
  }
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'IC', 'IC', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Standards', 'institution') returning id`, [ids.inst, acc]);
  ids.v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2030') returning id`, [ids.inst, ids.fw]);
  ids.req = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, '1.1', 'Standard', 'Mission') returning id`, [ids.inst, ids.v]);
  await db.su.query(`insert into report_template (institution_id, framework_version_id, key, name, kind, structure, review_status) values ($1, $2, 'self_study', 'Self-Study', 'self_study', $3, 'approved')`, [ids.inst, ids.v, JSON.stringify(STRUCTURE)]);
  await db.su.query(`insert into report_template (institution_id, framework_version_id, key, name, kind, structure, review_status) values ($1, $2, 'other', 'Other Report', 'other', $3, 'approved')`, [ids.inst, ids.v, JSON.stringify({ sections: [{ key: 'note', title: 'Note', block_type: 'narrative' }] })]);
  await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ids.v]);
  await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [ids.v, ids.lead]);
  await db.su.query(
    `with e as (insert into engagement (institution_id, framework_version_id, subject_type, subject_id, kind, title, review_year, lead_user_id) values ($1, $2, 'institution', $1, 'initial', 'Initial 2030', 2030, $3) returning id, institution_id, lead_user_id)
     insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) select institution_id, lead_user_id, 'engagement_lead', 'engagement', id from e`,
    [ids.inst, ids.v, ids.lead]);
  ids.eng = await one(`select id from engagement where title = 'Initial 2030'`);
  await db.su.query(`insert into engagement_requirement (institution_id, engagement_id, requirement_id, owner_id) values ($1, $2, $3, $4)`, [ids.inst, ids.eng, ids.req, ids.lead]);
  const res = await app.request('/api/reports', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': `${ids.lead}:${ids.inst}` }, body: JSON.stringify({ frameworkVersionId: ids.v, templateKey: 'self_study', engagementId: ids.eng }) });
  ids.report = ((await res.json()) as { id: string }).id;
  // Approved evidence linked to 1.1, with one stored version to cite.
  ids.item = await one(`insert into evidence_item (institution_id, title, type, method) values ($1, 'Mission statement', 'document', 'manual') returning id`, [ids.inst]);
  ids.version = await one(`insert into evidence_version (institution_id, evidence_item_id, version_no, file_name, file_path, sha256, mime, size) values ($1, $2, 1, 'mission.pdf', 'k/mission.pdf', 'seeded', 'application/pdf', 12) returning id`, [ids.inst, ids.item]);
  await db.su.query(`insert into evidence_link (institution_id, evidence_version_id, internal_framework_id, internal_code, rationale, review_status, reviewed_by, reviewed_at) values ($1, $2, $3, '1.1', 'it is the mission', 'approved', $4, now())`, [ids.inst, ids.version, ids.fw, ids.lead]);
}, 60000);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => undefined); });
afterAll(async () => { await pool.end(); await db.close(); });

/** A save is done when its button greys out and reads Save again (the click disables it while the PATCH is in flight). */
const saved = async (section: string, button: string) =>
  await waitFor(() => {
    const b = within(screen.getByTestId(section)).getByTestId(button) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.textContent).toBe('Save');
  });

const open = async (who: Who) => {
  const c = clientFor(who);
  render(wrap(<ReportPage id={ids.report!} api={c.report} evidence={c.evidence} framework={c.fw} onBack={() => undefined} />));
  await screen.findByTestId('report-page');
};

describe('the report editor', () => {
  it('shows the report, its sections in template order, the linked standard and the owner', async () => {
    await open('viewer');
    expect(screen.getByTestId('report-title').textContent).toBe('Self-Study · Initial 2030');
    expect(screen.getByTestId('report-status').textContent).toBe('Draft');
    for (const key of ['intro', 'data', 'attest', 'docs']) expect(screen.getByTestId(`section-${key}`)).toBeTruthy();
    expect(screen.getByTestId('section-intro').textContent).toContain('1.1');
    expect(within(screen.getByTestId('section-intro')).getByTestId('section-status-intro').textContent).toBe('Draft');
    // The owner came from the engagement requirement.
    expect(within(screen.getByTestId('section-intro')).getByTestId('section-status-intro').parentElement!.textContent).toContain('lead@x.org');
    expect(screen.getByTestId('total-words').textContent).toBe('0');
    expect(within(screen.getByTestId('section-intro')).getByTestId('section-prompt').textContent).toBe('Say what the institution is.');
  }, 60000);

  it('saves a narrative; the database recounts the words and the limit warns', async () => {
    const user = userEvent.setup();
    await open('lead');
    const surface = within(screen.getByTestId('section-intro')).getByTestId('narrative-surface');
    // jsdom cannot type into contenteditable; ProseMirror reads a pasted clipboard itself.
    fireEvent.paste(surface.querySelector('.ProseMirror')!, { clipboardData: { getData: (k: string) => (k === 'text/plain' ? 'One two three four five six' : '') } });
    expect(screen.getByTestId('word-count').textContent).toContain('6 words');
    expect(screen.getByTestId('word-warning')).toBeTruthy();
    await user.click(within(screen.getByTestId('section-intro')).getByTestId('save-narrative'));
    await saved('section-intro', 'save-narrative');
    // Read back from the API: the plain text is stored and the count is the database's.
    const res = await fetchAs('viewer')(`/api/reports/${ids.report}`);
    const detail = await res.json() as { wordCount: number; sections: { key: string; wordCount: number; content: { text?: string } }[] };
    const intro = detail.sections.find((s) => s.key === 'intro')!;
    expect(intro.content.text).toBe('One two three four five six');
    expect(intro.wordCount).toBe(6);
    expect(detail.wordCount).toBe(6);
  }, 60000);

  it('cites approved evidence of the linked requirement as a token the text keeps', async () => {
    const user = userEvent.setup();
    await open('lead');
    await user.click(within(screen.getByTestId('section-intro')).getByTestId('open-evidence'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'Evidence for this section' })).toBeTruthy();
    await waitFor(() => expect(within(sheet).getAllByTestId('citable-evidence')[0]!.textContent).toContain('Mission statement'));
    await user.click(within(sheet).getByTestId(`cite-${ids.version}`));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const text = within(screen.getByTestId('section-intro')).getByTestId('narrative-surface').textContent!;
    expect(text).toContain(`[E:${ids.version}]`);
    await user.click(within(screen.getByTestId('section-intro')).getByTestId('save-narrative'));
    await saved('section-intro', 'save-narrative');
    const res = await fetchAs('viewer')(`/api/reports/${ids.report}`);
    const detail = await res.json() as { sections: { key: string; content: { text?: string } }[] };
    expect(detail.sections.find((s) => s.key === 'intro')!.content.text).toContain(`[E:${ids.version}]`);
  }, 60000);

  it('fills a data table by hand and read-only for a viewer', async () => {
    const user = userEvent.setup();
    await open('lead');
    const nameCell = within(screen.getByTestId('section-data')).getByRole('textbox', { name: 'Name, row 1' });
    await user.type(nameCell, 'Libraries');
    await user.type(within(screen.getByTestId('section-data')).getByRole('textbox', { name: 'Count, row 1' }), '12');
    await user.click(within(screen.getByTestId('section-data')).getByTestId('save-table'));
    await saved('section-data', 'save-table');
    const res = await fetchAs('viewer')(`/api/reports/${ids.report}`);
    const detail = await res.json() as { sections: { key: string; content: { rows?: Record<string, unknown>[] } }[] };
    expect(detail.sections.find((s) => s.key === 'data')!.content.rows).toEqual([{ name: 'Libraries', count: 12 }]);
    // A viewer sees the row as plain cells and no way to change it.
    cleanup();
    await open('viewer');
    expect(within(screen.getByTestId('section-data')).getByRole('cell', { name: 'Libraries' })).toBeTruthy();
    expect(within(screen.getByTestId('section-data')).queryByTestId('save-table')).toBeNull();
  }, 60000);

  it('uploads the signed letter whole and serves it back', async () => {
    const user = userEvent.setup();
    await open('lead');
    const section = screen.getByTestId('section-attest');
    await user.type(within(section).getByTestId('signatory-name'), 'President Layla');
    await user.type(within(section).getByTestId('statement'), 'I attest this report is true.');
    await user.click(within(section).getByTestId('save-attestation'));
    await saved('section-attest', 'save-attestation');
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'signed.pdf', { type: 'application/pdf' });
    await user.upload(within(section).getByLabelText('Upload the signed letter'), file);
    const link = await within(section).findByTestId('stored-letter');
    expect(link.textContent).toContain('signed.pdf');
    // The letter comes back as it went in.
    const res = await fetchAs('viewer')(`/api/reports/${ids.report}/sections/${(link.closest(`[id^="section-"]`) as HTMLElement).id.slice('section-'.length)}/letter`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    // And the section carries it whole.
    const detail = await (await fetchAs('viewer')(`/api/reports/${ids.report}`)).json() as { sections: { key: string; content: Record<string, unknown> }[] };
    const attest = detail.sections.find((s) => s.key === 'attest')!.content;
    expect(attest.fileKey).toBeTruthy();
    expect(attest.fileName).toBe('signed.pdf');
    expect(attest.fileMime).toBe('application/pdf');
    expect(attest.fileSize).toBe(4);
    expect(attest.signatoryName).toBe('President Layla');
  }, 60000);

  it('attaches evidence to the appendix and refuses what belongs to another institution', async () => {
    const user = userEvent.setup();
    await open('lead');
    await user.click(within(screen.getByTestId('section-docs')).getByTestId('add-appendix'));
    const sheet = await screen.findByRole('dialog');
    await user.click(await within(sheet).findByTestId(`pick-${ids.item}`));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((within(screen.getByTestId('section-docs')).getAllByTestId('appendix-item')[0]!.querySelector('input') as HTMLInputElement).value).toBe('Mission statement');
    await user.click(within(screen.getByTestId('section-docs')).getByTestId('save-appendix'));
    await saved('section-docs', 'save-appendix');
    // A version of another institution is refused by the service.
    const inst2 = await one(`insert into institution (name_en) values ('Other') returning id`);
    const foreign = await one(`insert into evidence_version (institution_id, evidence_item_id, version_no, file_name, file_path, sha256, mime, size)
      select $2, id, 2, 'x.pdf', 'k/x.pdf', 'seeded', 'application/pdf', 1 from evidence_item where id = $1 returning id`, [ids.item, inst2]);
    const res = await fetchAs('lead')(`/api/reports/${ids.report}/sections/${(await (await fetchAs('viewer')(`/api/reports/${ids.report}`)).json() as { sections: { key: string; id: string }[] }).sections.find((s) => s.key === 'docs')!.id}/content`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appendix: { items: [{ evidenceVersionId: foreign, label: 'X' }] } }),
    });
    expect(res.status).toBe(400);
  }, 60000);

  it('gives a viewer the narrative read-only and no report actions', async () => {
    await open('viewer');
    expect(within(screen.getByTestId('section-intro')).queryByTestId('save-narrative')).toBeNull();
    expect(within(screen.getByTestId('section-intro')).queryByTestId('open-evidence')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(screen.queryByTestId('section-progress')).toBeTruthy();
  }, 60000);

  it('lists the engagement reports and creates one from the reviewed template', async () => {
    const user = userEvent.setup();
    const c = clientFor('lead');
    const detail = { engagement: { id: ids.eng!, frameworkVersionId: ids.v! } } as unknown as EngagementDetail;
    render(wrap(<ReportsTab detail={detail} canManage api={c.report} framework={c.fw} />));
    await screen.findByTestId('reports-tab');
    expect((await screen.findByTestId('report-link')).textContent).toBe('Self-Study · Initial 2030');
    await user.click(screen.getByTestId('add-report'));
    await waitFor(() => expect(within(screen.getByTestId('create-report')).getByRole('option', { name: 'Self-Study' })).toBeTruthy());
    await user.selectOptions(screen.getByTestId('template-select'), 'other');
    await user.type(screen.getByTestId('create-title'), 'Mid-term review');
    await user.click(screen.getByTestId('create-go'));
    await waitFor(() => expect(screen.getAllByTestId('report-card')).toHaveLength(2));
    expect(screen.getByText('Mid-term review')).toBeTruthy();
  }, 60000);

  it('renames a draft and deletes it to the trash', async () => {
    const user = userEvent.setup();
    const res = await fetchAs('lead')('/api/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ frameworkVersionId: ids.v, templateKey: 'self_study', subjectKind: 'institution', subjectId: ids.inst, title: 'Throwaway' }) });
    const draft = ((await res.json()) as { id: string }).id;
    const c = clientFor('lead');
    render(wrap(<ReportPage id={draft} api={c.report} evidence={c.evidence} framework={c.fw} onBack={() => undefined} />));
    await screen.findByTestId('report-page');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByTestId('rename-input');
    await user.clear(input);
    await user.type(input, 'Throwaway renamed');
    await user.click(within(screen.getByTestId('rename-row')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('report-title').textContent).toBe('Throwaway renamed'));
    // Deleting asks first, then the draft is gone and the letter of the record is kept.
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click((await document.querySelector('[data-confirm-ok]'))!);
    await waitFor(() => expect(document.querySelector('[data-confirm-ok]')).toBeNull());
    // The dialog closes as soon as the question is answered; the delete itself is still in flight.
    await waitFor(async () => expect((await fetchAs('viewer')(`/api/reports/${draft}`)).status).toBe(404));
  }, 60000);
});
