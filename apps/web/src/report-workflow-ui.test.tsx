// @vitest-environment jsdom
// The workflow on the page (TASK-094): a reviewer sends sections and decides them, the report is internally approved
// when every section is approved, a section can be reopened with its note (which demotes the report), the submission
// snapshot is frozen with its fingerprint, and Mark submitted locks the report behind a confirmation. Runs against the
// real API and database.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { frameworkApi } from './lib/framework-api';
import { reportApi } from './lib/report-api';
import { ReportPage } from './pages/reports/report-page';

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
const clientFor = (who: Who) => {
  const f = fetchAs(who);
  const a = createApi(f);
  return { report: reportApi(a, f), fw: frameworkApi(a) };
};

function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}

const STRUCTURE = {
  sections: [
    { key: 'a', title: 'First', block_type: 'narrative', requirement_codes: ['1.1'] },
    { key: 'b', title: 'Second', block_type: 'narrative', requirement_codes: ['1.1'] },
  ],
};

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('reportworkflow');
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
  await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ids.v]);
  await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [ids.v, ids.lead]);
  await db.su.query(
    `with e as (insert into engagement (institution_id, framework_version_id, subject_type, subject_id, kind, title, review_year, lead_user_id) values ($1, $2, 'institution', $1, 'initial', 'Initial 2030', 2030, $3) returning id, institution_id, lead_user_id)
     insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) select institution_id, lead_user_id, 'engagement_lead', 'engagement', id from e`,
    [ids.inst, ids.v, ids.lead]);
  ids.eng = await one(`select id from engagement where title = 'Initial 2030'`);
  const res = await app.request('/api/reports', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': `${ids.lead}:${ids.inst}` }, body: JSON.stringify({ frameworkVersionId: ids.v, templateKey: 'self_study', engagementId: ids.eng }) });
  ids.report = ((await res.json()) as { id: string }).id;
  // The milestone "Mark submitted" completes.
  await db.su.query(`insert into milestone (institution_id, engagement_id, phase, name, type, report_id) values ($1, $2, 'self_study', 'Send it', 'submission', $3)`, [ids.inst, ids.eng, ids.report]);
}, 60000);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => undefined); });
afterAll(async () => { await pool.end(); await db.close(); });

const open = async (who: Who) => {
  const c = clientFor(who);
  render(wrap(<ReportPage id={ids.report!} api={c.report} framework={c.fw} onBack={() => undefined} />));
  await screen.findByTestId('report-page');
};

/** Waits until a section chip reads the given state (the move's PATCH has landed in the page's cache). */
const stateOf = async (key: string, label: string) =>
  await waitFor(() => expect(within(screen.getByTestId(`section-${key}`)).getByTestId(`section-status-${key}`).textContent).toBe(label));

describe('the report workflow', () => {
  it('reviews sections on the page, internally approves, reopens with a note, and approves again', async () => {
    const user = userEvent.setup();
    await open('lead');
    // Send both sections, approve them; the approver's name shows under the section.
    await user.click(within(screen.getByTestId('section-a')).getByTestId('send-a'));
    await stateOf('a', 'In review');
    await user.click(within(screen.getByTestId('section-a')).getByTestId('approve-a'));
    await stateOf('a', 'Approved');
    expect(within(screen.getByTestId('section-a')).getByTestId('approved-by-a').textContent).toContain('lead@x.org');
    await user.click(within(screen.getByTestId('section-b')).getByTestId('send-b'));
    await stateOf('b', 'In review');
    await user.click(within(screen.getByTestId('section-b')).getByTestId('approve-b'));
    await stateOf('b', 'Approved');
    // Every section approved: internal approval unlocks.
    await user.click(screen.getByTestId('approve-go'));
    await waitFor(() => expect(screen.getByTestId('report-status').textContent).toBe('Internally approved'));
    expect(screen.getByTestId('notice').textContent).toContain('internally approved');
    // Reopening the approved section sends the whole report back to draft, with the note recorded.
    await user.click(within(screen.getByTestId('section-a')).getByTestId('reopen-a'));
    await screen.findByTestId('note-row-a');
    await user.type(screen.getByTestId('note-input-a'), 'A figure moved');
    await user.click(screen.getByTestId('note-go-a'));
    await stateOf('a', 'Draft');
    await waitFor(() => expect(screen.getByTestId('report-status').textContent).toBe('Draft'));
    // The review starts over: send, approve, internally approve again.
    await user.click(within(screen.getByTestId('section-a')).getByTestId('send-a'));
    await stateOf('a', 'In review');
    await user.click(within(screen.getByTestId('section-a')).getByTestId('approve-a'));
    await stateOf('a', 'Approved');
    await user.click(screen.getByTestId('approve-go'));
    await waitFor(() => expect(screen.getByTestId('report-status').textContent).toBe('Internally approved'));
    const detail = await (await fetchAs('viewer')(`/api/reports/${ids.report}`)).json() as { status: string; sections: { key: string; status: string; lastDecision: { decision: string; note: string | null } | null }[] };
    expect(detail.status).toBe('internally_approved');
    expect(detail.sections.find((s) => s.key === 'a')!.lastDecision!.decision).toBe('approved');
  }, 90000);

  it('freezes the snapshot with its fingerprint, then Mark submitted locks the report and completes the milestone', async () => {
    const user = userEvent.setup();
    await open('lead');
    // The snapshot box appears once taken; the fingerprint is shown.
    await user.click(screen.getByTestId('snapshot-go'));
    const box = await screen.findByTestId('snapshot-box');
    await waitFor(() => expect((within(box).getByTestId('snapshot-sha').textContent ?? '').length).toBeGreaterThan(8));
    // The accreditor reference travels with the submission, behind its confirmation.
    await user.type(screen.getByTestId('submit-ref'), 'WSCUC-2026-77');
    const go = await waitFor(() => {
      const b = screen.getByTestId('submit-go') as HTMLButtonElement;
      expect(b.disabled).toBe(false);
      return b;
    });
    await user.click(go);
    await screen.findByText('Mark submitted', { selector: '#confirm-title, [id="confirm-title"]' }).catch(() => undefined);
    await waitFor(() => expect(document.querySelector('[data-confirm-ok]')).toBeTruthy());
    await user.click(document.querySelector('[data-confirm-ok]')!);
    await waitFor(() => expect(screen.getByTestId('report-status').textContent).toBe('Submitted'));
    expect(screen.getByTestId('locked').textContent).toContain('submitted');
    expect(screen.getByTestId('submitted-ref').textContent).toContain('WSCUC-2026-77');
    // Read back: frozen, stamped, the milestone done.
    const detail = await (await fetchAs('viewer')(`/api/reports/${ids.report}`)).json() as { status: string; submittedRef: string | null; snapshotId: string };
    expect(detail.status).toBe('submitted');
    expect(detail.submittedRef).toBe('WSCUC-2026-77');
    const snap = await (await fetchAs('viewer')(`/api/reports/${ids.report}/snapshot`)).json() as { manifest: { sections: { approvals: unknown[] }[] }; sha256: string };
    expect(snap.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const s of snap.manifest.sections) expect(s.approvals.length).toBeGreaterThan(0);
    const ms = await db.su.query(`select status from milestone where report_id = $1`, [ids.report]);
    expect(ms.rows[0]!.status).toBe('done');
  }, 90000);
});
