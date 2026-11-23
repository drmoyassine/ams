// @vitest-environment jsdom
// Quality Management as the IQF in operation (DEC-048) in the SPA against the real API: the tabs are the standards a person is linked to
// by scope, the standard read-only, a course coordinator's submission (reuse the evidence, submit), and the approval chain where the
// program coordinator returns it with a note and then approves. Settings: the frequency and approval-steps dialogs from the ⋯ menu.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, MemoryStore, seedFrameworks } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { evidenceApi } from './lib/evidence-api';
import { frameworkApi } from './lib/framework-api';
import { qualityApi } from './lib/quality-api';
import { scopeApi } from './lib/scope-api';
import { settingsApi } from './lib/settings-api';
import { QualityPage } from './pages/quality/quality-page';
import { FrequencyDialog, ApprovalDialog } from './components/standard-ops/quality-dialogs';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetchAs = (who: string) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apis = (who: string) => { const a = createApi(fetchAs(who)); return { framework: frameworkApi(a), scope: scopeApi(a), settings: settingsApi(a), quality: qualityApi(fetchAs(who)), evidence: evidenceApi(a, fetchAs(who)) }; };
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const page = (who: string) => { const a = apis(who); return render(wrap(<QualityPage api={a.quality} evidence={a.evidence} />)); };
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  db = await createTestDb('webquality');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'qa', 'progcoord', 'dean', 'coursecoord', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['qa', 'viewer'], ['progcoord', 'viewer'], ['dean', 'viewer'], ['coursecoord', 'viewer'], ['viewer', 'viewer']] as const) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u], role]);
  }
  ids.college = await one(`insert into org_unit (institution_id, type, name_en, head_user_id) values ($1, 'college', 'College of Engineering', $2) returning id`, [ids.inst, ids.dean]);
  ids.qaUnit = await one(`insert into org_unit (institution_id, type, name_en, head_user_id) values ($1, 'department', 'QAIE', $2) returning id`, [ids.inst, ids.qa]);
  ids.prog = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, coordinator_user_id) values ($1, $2, 'BS ECE', 'bachelor', $3) returning id`, [ids.inst, ids.college, ids.progcoord]);
  ids.course = await one(`insert into course (institution_id, org_unit_id, code, title_en, coordinator_user_id) values ($1, $2, 'ECE420', 'Digital Signal Processing', $3) returning id`, [ids.inst, ids.college, ids.coursecoord]);
  await db.su.query(`insert into course_program (institution_id, course_id, program_id) values ($1, $2, $3)`, [ids.inst, ids.course, ids.prog]);
  await db.su.query(`insert into academic_term (institution_id, name, kind, start_date, end_date) values ($1, 'This term', 'term', $2, $3)`, [ids.inst, day(-30), day(90)]);
  await seedFrameworks(pool);
  const a = apis('admin');
  const qf = await a.framework.setUpQualityFramework({ template: true });
  ids.qv = qf.versions[0]!.id; ids.fw = qf.framework!.id;
  for (const r of await a.framework.requirements(ids.qv)) await a.framework.reviewRequirement(r.id, 'approved');
  await a.framework.submit(ids.qv);
  await a.framework.publish(ids.qv);
  const reqs = await a.framework.requirements(ids.qv);
  const top = reqs.find((r) => !r.parentId && reqs.some((c) => c.parentId === r.id))!;
  ids.code = top.code; ids.title = top.title;
  ids.sub = reqs.find((r) => r.parentId === top.id)!.code;
  await a.scope.setScope({ frameworkId: ids.fw, code: ids.code, levelKey: 'course', itemIds: [ids.course] });
  await a.scope.setChampion({ frameworkId: ids.fw, code: ids.code, userId: ids.admin! });
  await a.quality.setFrequency({ frameworkId: ids.fw, code: ids.code, rule: { every: 'semester', week: 12, timezone: 'UTC', startDate: day(-400) } });
  await a.quality.setApproval({ frameworkId: ids.fw, code: ids.code, steps: [{ kind: 'program_coordinator' }, { kind: 'unit_head', unitType: 'college', label: 'Dean' }] });
  await a.quality.setOffice(ids.qaUnit);
  ids.item = await one(`insert into evidence_item (institution_id, title, type) values ($1, 'CLO assessment report', 'document') returning id`, [ids.inst]);
  ids.version = await one(`insert into evidence_version (institution_id, evidence_item_id, version_no, url) values ($1, $2, 1, 'https://x.example/clo') returning id`, [ids.inst, ids.item]);
  await db.su.query(`insert into evidence_link (institution_id, evidence_version_id, internal_framework_id, internal_code, rationale, review_status) values ($1, $2, $3, $4, 'asked for', 'approved')`, [ids.inst, ids.version, ids.fw, ids.sub]);
}, 180000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('Quality Management (DEC-048)', () => {
  it('shows a course coordinator only the standard their course is scoped to; they reuse the evidence and submit it', async () => {
    const user = userEvent.setup();
    page('coursecoord');
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([expect.stringContaining(ids.title!)]);
    expect(await screen.findByRole('list', { name: 'Standard and sub-standards' })).toBeTruthy();
    expect((await screen.findByTestId('frequency')).textContent).toBe('Every semester, week 12');
    const row = await screen.findByTestId('submission-row');
    expect(row.textContent).toMatch(/ECE420 Digital Signal Processing.*This term.*Not started.*0 of 1/);
    await user.click(within(row).getByRole('button', { name: 'Start' }));
    const panel = await screen.findByRole('region', { name: 'Submission' });
    expect(within(panel).getAllByTestId('approval-step').map((s) => s.textContent)).toEqual([
      expect.stringMatching(/Program coordinator.*progcoord/), expect.stringMatching(/Dean.*dean/), expect.stringMatching(/QA office.*qa/), expect.stringMatching(/Champion.*admin/)]);
    expect((within(panel).getByRole('button', { name: 'Submit for approval' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(panel).getByRole('button', { name: 'Reuse version 1' }));
    await within(panel).findByText('Provided: version 1');
    await user.click(within(panel).getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(within(panel).getByTestId('submission-status').textContent).toBe('Submitted'));
  });

  it('lets the program coordinator return it with a note, then approve the resubmission; a viewer sees no standard', async () => {
    const user = userEvent.setup();
    page('progcoord');
    expect(await screen.findByLabelText('1 to approve')).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    let panel = await screen.findByRole('region', { name: 'Submission' });
    expect((within(panel).getByRole('button', { name: 'Return for changes' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(panel).getByLabelText('Decision note'), 'Add the indirect assessment.');
    await user.click(within(panel).getByRole('button', { name: 'Return for changes' }));
    await waitFor(() => expect(within(panel).getByTestId('submission-status').textContent).toBe('Returned for changes'));
    cleanup();
    page('coursecoord');
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    panel = await screen.findByRole('region', { name: 'Submission' });
    expect(panel.textContent).toContain('Add the indirect assessment.');
    await user.click(within(panel).getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(within(panel).getByTestId('submission-status').textContent).toBe('Submitted'));
    cleanup();
    page('progcoord');
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    panel = await screen.findByRole('region', { name: 'Submission' });
    await user.click(within(panel).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(panel.textContent).toMatch(/With Dean|Internally approved by progcoord/));
    cleanup();
    page('viewer');
    expect(await screen.findByTestId('no-standards')).toBeTruthy();
  });

  it('sets a standard\'s frequency and approval steps in Settings', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    const target = { frameworkId: ids.fw!, versionId: ids.qv!, code: ids.sub!, title: 'Sub', label: ids.sub!, internal: true };
    render(wrap(<FrequencyDialog target={target} api={a.quality} onClose={() => undefined} />));
    expect((await screen.findByTestId('frequency-current')).textContent).toContain(`Every semester, week 12 (from ${ids.code})`);
    await user.selectOptions(screen.getByLabelText('Every'), 'year');
    await user.selectOptions(screen.getByLabelText('Month'), '8');
    expect(screen.getByTestId('frequency-preview').textContent).toBe('Every year, on the last Monday of August');
    await user.click(screen.getByRole('button', { name: 'Save frequency' }));
    await waitFor(async () => expect((await a.quality.requirements(ids.qv!, ids.fw!)).find((x) => x.code === ids.sub)!.frequency.text).toBe('Every year, on the last Monday of August'));
    cleanup();
    render(wrap(<ApprovalDialog target={{ ...target, code: ids.code! }} api={a.quality} settings={a.settings} onClose={() => undefined} />));
    expect((await screen.findAllByTestId('approval-step-setting')).map((x) => x.textContent)).toEqual([expect.stringContaining('Program coordinator'), expect.stringContaining('Dean')]);
    await user.selectOptions(screen.getByLabelText('Step kind'), 'person');
    await user.selectOptions(await screen.findByLabelText('Person'), ids.qa!);
    await user.click(screen.getByRole('button', { name: 'Add step' }));
    await user.click(screen.getByRole('button', { name: 'Save steps' }));
    await waitFor(async () => expect((await a.quality.requirements(ids.qv!, ids.fw!)).find((x) => x.code === ids.code)!.approval.own).toHaveLength(3));
  });
});
