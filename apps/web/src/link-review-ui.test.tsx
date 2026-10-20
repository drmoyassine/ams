// @vitest-environment jsdom
// TASK-088 in the SPA against the real API: what the Link evidence dialog says will happen, a reviewer's own link approved at once, the
// Reject dialog that requires a reason, the reason shown on the rejected link, and My work with the notice, Resubmit, Dismiss and the menu count.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, MemoryStore, seedFrameworks } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { cyclesApi } from './lib/cycles-api';
import { engagementApi } from './lib/engagement-api';
import { evidenceApi } from './lib/evidence-api';
import { frameworkApi } from './lib/framework-api';
import { settingsApi } from './lib/settings-api';
import { MyWorkTab } from './pages/cycles/my-work';
import { AppLayout } from './pages/layout';
import { RequirementWorkspacePage } from './pages/requirement-workspace';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetcherOf = (who: string) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apis = (who: string) => {
  const a = createApi(fetcherOf(who));
  const f = fetcherOf(who);
  return { evidence: evidenceApi(a, f), framework: frameworkApi(a), engagement: engagementApi(a), settings: settingsApi(a, f), cycles: cyclesApi(a, f) };
};
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const evidenceTitles = ['Minutes', 'Audit report', 'Survey results'];

beforeAll(async () => {
  db = await createTestDb('weblinkreview');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'maker']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['maker', 'contributor']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  const unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.mech = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Mechanical Engineering', 'bachelor', '{mechanical}') returning id`, [ids.inst, unit]);
  await seedFrameworks(pool);
  const a = apis('admin');
  const abet = (await a.framework.frameworks()).find((f) => f.accreditorShortName === 'ABET')!;
  const abetVersion = (await a.framework.versions(abet.id))[0]!.id;
  const eng = await a.engagement.create({ frameworkVersionId: abetVersion, subjectType: 'program', subjectId: ids.mech!, kind: 'initial', reviewYear: 2027, leadUserId: ids.admin! });
  ids.er = (await a.engagement.requirements(eng.engagement.id)).items.find((i) => i.applicable)!.id;
  for (const title of evidenceTitles) await a.evidence.create({ title, type: 'document', url: `https://example.org/${encodeURIComponent(title)}` });
}, 120000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

/** Opens "+ Link other evidence" on the requirement, picks the evidence by title and gives it a justification. */
async function linkThrough(who: string, title: string, why: string) {
  const user = userEvent.setup();
  const a = apis(who);
  render(wrap(<RequirementWorkspacePage id={ids.er!} api={a.engagement} evidence={a.evidence} />));
  const card = await screen.findByRole('region', { name: 'Evidence' });
  await user.click(await within(card).findByRole('button', { name: '+ Link other evidence' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('combobox', { name: 'Search evidence' }), title);
  await user.click(await within(dialog).findByRole('option', { name: new RegExp(`^${title} v\\d`) }));
  await user.type(within(dialog).getByLabelText('Justification'), why);
  const note = within(dialog).getByTestId('link-outcome').textContent;
  await user.click(within(dialog).getByRole('button', { name: 'Link evidence' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  return { card, note, user };
}
const linkOf = (card: HTMLElement, title: string) => waitFor(() => {
  const found = within(card).queryAllByTestId('evidence-link').find((l) => l.textContent?.includes(title));
  if (!found) throw new Error(`no link of ${title} yet`);
  return found;
});

describe('linking', () => {
  it('a contributor proposes: the dialog says a reviewer approves it, and the link is Proposed', async () => {
    const { card, note } = await linkThrough('maker', 'Minutes', 'The minutes of the review');
    expect(note).toBe('Proposed: a reviewer approves it.');
    const link = await linkOf(card, 'Minutes');
    expect(link.textContent).toContain('Proposed');
    expect(link.textContent).not.toContain('Approved');
  });

  it('a reviewer links and it is approved at once: the dialog says so, there is nothing left to approve', async () => {
    const { card, note } = await linkThrough('admin', 'Audit report', 'The audit covers it');
    expect(note).toBe('Linked and approved: you may review this, so it is approved at once.');
    const link = await linkOf(card, 'Audit report');
    expect(link.textContent).toContain('Approved');
    expect(within(link).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(link).queryByRole('button', { name: 'Reject' })).toBeNull();
  });
});

describe('rejecting', () => {
  it('asks why: Reject stays off until a reason is typed (Arabic is fine), then the reason, who and when show on the link', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<RequirementWorkspacePage id={ids.er!} api={a.engagement} evidence={a.evidence} />));
    const card = await screen.findByRole('region', { name: 'Evidence' });
    const link = await linkOf(card, 'Minutes');
    await user.click(within(link).getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject this link' });
    const reason = within(dialog).getByLabelText('Why is it rejected?') as HTMLTextAreaElement;
    expect(reason.getAttribute('dir')).toBe('auto');
    expect(reason.required).toBe(true);
    const submit = within(dialog).getByRole('button', { name: 'Reject link' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(reason, '   ');
    expect(submit.disabled).toBe(true);
    await user.clear(reason);
    await user.type(reason, 'محضر قديم');
    expect(submit.disabled).toBe(false);
    await user.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(async () => expect((await linkOf(card, 'Minutes')).textContent).toContain('Rejected'));
    const rejected = await within(await linkOf(card, 'Minutes')).findByTestId('link-rejected');
    expect(rejected.textContent).toMatch(/^Rejected by admin on .+: محضر قديم$/);
  });
});

describe('My work', () => {
  it('tells the proposer, counts it in the menu, resubmits with a new justification and dismisses', async () => {
    const user = userEvent.setup();
    // A second rejected link, to dismiss.
    await linkThrough('maker', 'Survey results', 'Alumni survey');
    cleanup();
    const admin = apis('admin');
    const survey = (await admin.evidence.requirementLinks(ids.er!)).find((l) => l.evidenceTitle === 'Survey results')!;
    await admin.evidence.review(survey.id, { decision: 'rejected', comment: 'Wrong year' });

    // The menu: My work (2) for the two unread notices (the maker owns no stage or approval).
    const maker = apis('maker');
    render(wrap(<AppLayout api={maker.settings} cycles={maker.cycles} evidence={maker.evidence} />));
    const main = await (async () => { await screen.findByTestId('institution-name'); return screen.getByRole('navigation', { name: 'Main' }); })();
    expect((await within(main).findByRole('link', { name: 'My work (2)' })).getAttribute('href')).toBe('/quality-management?tab=my-work');
    cleanup();

    render(wrap(<MyWorkTab apis={maker} />));
    const section = await screen.findByRole('region', { name: 'Notifications' });
    const notes = await within(section).findAllByTestId('my-notification');
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.getAttribute('data-unread') === 'true')).toBe(true);
    const minutes = notes.find((n) => n.textContent?.includes('Minutes'))!;
    expect(minutes.textContent).toMatch(/Your link of Minutes to .+ was rejected: محضر قديم/);

    // Resubmit: the dialog is prefilled with the old justification and shows the rejection.
    await user.click(within(minutes).getByRole('button', { name: 'Resubmit the link of Minutes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resubmit this link' });
    const why = within(dialog).getByLabelText('Justification') as HTMLTextAreaElement;
    expect(why.value).toBe('The minutes of the review');
    expect(within(dialog).getByTestId('link-rejected').textContent).toContain('محضر قديم');
    await user.clear(why);
    await user.type(why, 'The 2026 minutes of the review');
    await user.click(within(dialog).getByRole('button', { name: 'Resubmit' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getAllByTestId('my-notification')).toHaveLength(1));
    const back = (await admin.evidence.requirementLinks(ids.er!)).find((l) => l.evidenceTitle === 'Minutes')!;
    expect(back).toMatchObject({ reviewStatus: 'proposed', rationale: 'The 2026 minutes of the review', reviewComment: null });

    // Mark the other as read, then dismiss it.
    const wrongYear = screen.getByTestId('my-notification');
    expect(within(wrongYear).queryByRole('button', { name: /Resubmit/ })).toBeTruthy();
    await user.click(within(wrongYear).getByRole('button', { name: 'Mark as read' }));
    await waitFor(() => expect(screen.getByTestId('my-notification').getAttribute('data-unread')).toBe('false'));
    await user.click(within(screen.getByTestId('my-notification')).getByRole('button', { name: /^Dismiss/ }));
    await waitFor(() => expect(screen.queryByTestId('my-notification')).toBeNull());
    expect(await maker.evidence.notifications()).toEqual([]);
  });

  it('lets the reviewer approve a proposed link in one click, which also tells the proposer', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    const item = await a.evidence.create({ title: 'Course files', type: 'document', url: 'https://example.org/course-files' });
    const version = (await a.evidence.get(item.id)).versions[0]!.id;
    await apis('maker').evidence.linkRequirement(ids.er!, { evidenceVersionId: version, rationale: 'The course files' });
    render(wrap(<RequirementWorkspacePage id={ids.er!} api={a.engagement} evidence={a.evidence} />));
    const card = await screen.findByRole('region', { name: 'Evidence' });
    const link = await linkOf(card, 'Course files');
    expect(link.textContent).toContain('Proposed');
    await user.click(within(link).getByRole('button', { name: 'Approve' }));
    await waitFor(async () => expect((await linkOf(card, 'Course files')).textContent).toContain('Approved'));
    expect((await apis('maker').evidence.notifications()).map((n) => [n.kind, n.body])).toEqual([['link_approved', expect.stringMatching(/^Your link of Course files to .+ was approved\.$/)]]);
  });

  it('shows nothing of it to the reviewer who made the decisions', async () => {
    const admin = apis('admin');
    expect(await admin.evidence.notifications()).toEqual([]);
    render(wrap(<MyWorkTab apis={admin} />));
    expect((await screen.findByTestId('my-work-empty')).textContent).toBe('Nothing is waiting for you.');
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
  });
});
