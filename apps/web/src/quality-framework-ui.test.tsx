// @vitest-environment jsdom
// The institution's own quality framework in Settings, against the real API.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, seedFrameworks } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { frameworkApi } from './lib/framework-api';
import { glossaryApi } from './lib/glossary-api';
import { settingsApi } from './lib/settings-api';
import { QualityFrameworkPage } from './pages/settings/quality-framework';
import { VersionPage } from './pages/version';
import { within } from '@testing-library/react';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const apiOf = (who: string) => createApi(((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch);
const apiFor = (who: string) => frameworkApi(apiOf(who));
const extra = (who: string) => ({ glossary: glossaryApi(apiOf(who)), settings: settingsApi(apiOf(who)) });
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}

beforeAll(async () => {
  db = await createTestDb('webquality');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  await seedFrameworks(pool, undefined);
}, 60000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('quality framework settings', () => {
  it('is set up by an editor from the template: standards and sub-standards with a title and a description', async () => {
    const user = userEvent.setup();
    const { unmount } = render(wrap(<QualityFrameworkPage api={apiFor('viewer')} {...extra('viewer')} />));
    expect(await screen.findByText(/has not been set up yet/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Set up the internal quality framework' })).toBeNull();
    unmount();

    render(wrap(<QualityFrameworkPage api={apiFor('lead')} {...extra('lead')} />));
    await user.click(await screen.findByRole('button', { name: 'Set up' }));
    const version = (await screen.findByLabelText('Version')) as HTMLSelectElement;
    expect(version.selectedOptions[0]!.textContent).toBe('1 · Draft');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Requirements', 'Documents', 'Terms']);
    const standards = await screen.findByRole('list', { name: 'Standards' });
    await waitFor(() => expect(standards.textContent).toContain('Mission and governance'));
    // each standard is a closed accordion labelled "Standard 1.0", with its sub-standards ("Standard 3.2") listed right under it, indented
    const subs3 = within(standards).getByRole('list', { name: 'Sub-standards of Standard 3.0' });
    expect(within(subs3).getByRole('region', { name: 'Standard 3.2' }).textContent).toContain('Assessment of learning');
    const s3 = within(standards).getByRole('region', { name: 'Standard 3.0' });
    expect(within(s3).queryByText('Assessment of learning')).toBeNull(); // not inside the standard's own card
    await user.click(within(s3).getByRole('button', { name: /Standard 3\.0\s*Teaching and learning/ }));
    expect(within(s3).getByText('Description')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish this version' })).toBeNull(); // a lead edits; the admin publishes
    // hovering a closed card shows its details without opening it
    await user.hover(within(standards).getByRole('button', { name: /Standard 1\.0\s*Mission and governance/ }));
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toMatch(/Standard 1\.0 · Mission and governance.*Linked evidence/s);
    await user.unhover(within(standards).getByRole('button', { name: /Standard 1\.0\s*Mission and governance/ }));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());

    // "+ Standard" opens a dialog, numbered for them, saved to the draft
    await user.click(screen.getByRole('button', { name: '+ Standard' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Code') as HTMLInputElement).value).toBe('9');
    await user.type(within(dialog).getByLabelText('Title'), 'Internationalisation');
    await user.type(within(dialog).getByLabelText('Description'), 'Partnerships, mobility and international recognition.');
    await user.click(within(dialog).getByRole('button', { name: 'Save as draft' }));
    const s9 = await screen.findByRole('region', { name: 'Standard 9.0' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(s9.textContent).toMatch(/Description\s*Partnerships, mobility and international recognition\./); // opened after adding
    await user.click(within(s9).getAllByRole('button', { name: 'Actions for Standard 9.0' })[0]!);
    await user.click(screen.getByRole('menuitem', { name: 'Add sub-standard' }));
    const sub = await screen.findByRole('dialog');
    expect((within(sub).getByLabelText('Code') as HTMLInputElement).value).toBe('9.1');
    await user.type(within(sub).getByLabelText('Title'), 'Student mobility');
    await user.click(within(sub).getByRole('button', { name: 'Save as draft' }));
    const subs9 = await screen.findByRole('list', { name: 'Sub-standards of Standard 9.0' });
    expect((await within(subs9).findByRole('region', { name: 'Standard 9.1' })).textContent).toContain('Student mobility');
    // a code places the item: a standard typed as 9.2 lands under Standard 9.0
    await user.click(screen.getByRole('button', { name: '+ Standard' }));
    const placed = await screen.findByRole('dialog');
    await user.clear(within(placed).getByLabelText('Code'));
    await user.type(within(placed).getByLabelText('Code'), '9.2');
    await user.type(within(placed).getByLabelText('Title'), 'Recognition');
    await user.click(within(placed).getByRole('button', { name: 'Save as draft' }));
    expect(await within(screen.getByRole('list', { name: 'Sub-standards of Standard 9.0' })).findByRole('region', { name: 'Standard 9.2' })).toBeTruthy();
    const rows = await apiFor('lead').requirements(version.value);
    expect(rows.find((r) => r.code === '9')!.officialText).toBe('Partnerships, mobility and international recognition.');
    expect(rows.find((r) => r.code === '9.1')!.levelLabel).toBe('Sub-standard');

    // the terms tab is a short list: findings, reports, general terms
    await user.click(screen.getByRole('tab', { name: 'Terms' }));
    expect(await screen.findByText(/each external standard's Settings → Terminology maps its own words onto these/i)).toBeTruthy();
  });

  it('is published in one step by an administrator, then fixed until a new version is started', async () => {
    const user = userEvent.setup();
    render(wrap(<QualityFrameworkPage api={apiFor('admin')} {...extra('admin')} />));
    await user.click(await screen.findByRole('button', { name: 'Publish this version' }));
    await waitFor(() => expect((screen.getByLabelText('Version') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('1 · Published'));
    await waitFor(() => expect(screen.queryByRole('button', { name: '+ Standard' })).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Start a new version' }));
    await waitFor(() => expect((screen.getByLabelText('Version') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('2 · Draft'));
    expect(await screen.findByRole('button', { name: '+ Standard' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('list', { name: 'Standards' }).textContent).toContain('Internationalisation')); // carried over
  });

  it('shows the analysis\'s wording proposals above the standards, and a person declines and accepts each one', async () => {
    const user = userEvent.setup();
    const api = apiFor('lead');
    const draft = (await api.qualityFramework()).versions.at(-1)!; // the draft the previous test started
    const item = (await api.requirements(draft.id)).find((r) => r.code === '9')!;
    const run = await one(
      `insert into analysis_run (institution_id, framework_version_id, status, stage, progress, prompt_versions, started_by, started_at)
       values ($1, $2, 'succeeded', 'finalise', '{}', '{}', $3, now()) returning id`, [ids.inst, draft.id, ids.lead]);
    const propose = (quote: string, proposed: string) => one(
      `insert into wording_proposal (institution_id, framework_version_id, requirement_id, analysis_run_id, source_quote, current_text, proposed_text, reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [ids.inst, draft.id, item.id, run, quote, item.officialText, proposed, 'The policy adds a sentence.']);
    await propose('a grand ceremony is held', `${item.officialText} A grand ceremony is held.`);
    await propose('agreements are reviewed yearly', `${item.officialText} Formal agreements are reviewed yearly.`);

    render(wrap(<QualityFrameworkPage api={api} {...extra('lead')} />));
    const inbox = await screen.findByRole('region', { name: 'Wording proposals' });
    expect(inbox.textContent).toContain('2 waiting for you');
    expect(within(inbox).getAllByText('Item 9')).toHaveLength(2);
    expect(inbox.textContent).toContain('agreements are reviewed yearly');

    // Decline the first (the list orders same-second rows arbitrarily); the other stays pending and acceptable.
    await user.click(within(inbox).getAllByRole('button', { name: 'Decline' })[0]!);
    expect(await within(inbox).findByText(/Declined/)).toBeTruthy();
    await user.click(within(inbox).getByRole('button', { name: 'Accept' }));
    expect(await within(inbox).findByText(/Accepted/)).toBeTruthy();
    expect(await within(inbox).findByText('all decided')).toBeTruthy();
    const decided = ((await db.su.query(`select status, proposed_text from wording_proposal where requirement_id = $1`, [item.id])).rows) as { status: string; proposed_text: string }[];
    expect(decided.map((d) => d.status).sort()).toEqual(['accepted', 'declined']);
    const accepted = decided.find((d) => d.status === 'accepted')!;
    const rows = await api.requirements(draft.id);
    expect(rows.find((r) => r.id === item.id)!.officialText).toBe(accepted.proposed_text); // exactly the accepted diff applied
    expect(rows.find((r) => r.id === item.id)!.reviewStatus).toBe('pending'); // an acceptance is one edit, back to review
  });

  it('filters the standards to the items a document import created (TASK-111)', async () => {
    const user = userEvent.setup();
    const api = apiFor('lead');
    const draft = (await api.qualityFramework()).versions.at(-1)!; // the draft the tests above started
    const rows = await api.requirements(draft.id);
    const made = rows.find((r) => r.code === '9')!; // Standard 9.0, added in the first test
    const doc = await one(`insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256)
      values ($1, $2, 'Quality manual', 'policy_procedure', 'binding', 'quality-manual.pdf', $3) returning id`, [ids.inst, draft.id, 'a'.repeat(64)]);
    const runId = await one(`insert into import_run (institution_id, scope_kind, scope_id, target_kind, document_ids, status)
      values ($1, 'framework_version', $2, 'iqf_tree', array[$3::uuid], 'succeeded') returning id`, [ids.inst, draft.id, doc]);
    await db.su.query(`insert into import_proposal (institution_id, run_id, target_kind, candidate, label, payload, status, applied_ref)
      values ($1, $2, 'iqf_tree', false, 'Standard 9', '{}'::jsonb, 'applied', $3)`, [ids.inst, runId, JSON.stringify({ requirementId: made.id })]);

    render(wrap(<QualityFrameworkPage api={api} {...extra('lead')} />));
    await screen.findByRole('region', { name: 'Standard 1.0' }); // all standards show before a document is picked
    const picker = (await screen.findByLabelText('From document')) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'Quality manual' }); // the document list loads once the picker appears
    await user.selectOptions(picker, doc);
    expect(await screen.findByText(`1 of ${rows.filter((r) => !r.parentId).length} standards`)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Standard 1.0' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Standard 9.0' })).toBeTruthy();
    await user.selectOptions(picker, '');
    expect(await screen.findByRole('region', { name: 'Standard 1.0' })).toBeTruthy();
    expect(screen.queryByText(`${rows.filter((r) => !r.parentId).length} standards`)).toBeTruthy(); // the count is back to the whole list
  });

  it('opens a version with only the tabs that apply to the institution\'s own framework', async () => {
    const api = apiFor('lead');
    const { versions } = await api.qualityFramework();
    render(wrap(<VersionPage versionId={versions[0]!.id} api={api} onOpenVersion={() => undefined} />));
    expect(await screen.findByRole('heading', { level: 1, name: 'Internal Quality Framework' })).toBeTruthy();
    expect(screen.getByText('Version 1')).toBeTruthy();
    expect(screen.queryAllByRole('tab')).toEqual([]); // only its requirements; its terms and publishing live on its own Settings page
    expect(screen.getByRole('link', { name: 'Internal Quality Framework' })).toBeTruthy();
  });
});

describe('mappings tab', () => {
  it('maps a requirement of a standard onto an item of the internal quality framework, and an approver reviews it', async () => {
    const user = userEvent.setup();
    const admin = apiFor('admin');
    const { versions } = await admin.qualityFramework();
    const qv = versions[versions.length - 1]!.id; // the draft started in the test above
    const std = await admin.createRequirement(qv, { code: 'Q1', levelLabel: 'Standard', title: 'Teaching quality' });
    await admin.createRequirement(qv, { code: 'Q1.1', levelLabel: 'Sub-standard', title: 'Course review', parentId: std.id });
    await admin.publishQuality(qv);

    const abet = (await admin.frameworks()).find((f) => f.accreditorShortName === 'ABET')!;
    const abetVersion = (await admin.versions(abet.id))[0]!;
    const reqs = await admin.requirements(abetVersion.id);
    const target = reqs.find((r) => r.isAssessable)!;

    render(wrap(<VersionPage versionId={abetVersion.id} api={apiFor('lead')} onOpenVersion={() => undefined} />));
    await user.click(await screen.findByRole('tab', { name: 'Mappings' }));
    const tree = await screen.findByRole('tree', { name: 'Requirements to map' });
    await user.click(await within(tree).findByRole('button', { name: new RegExp(target.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }));
    expect(await screen.findByText('Not mapped to your internal quality framework yet.')).toBeTruthy();

    const item = await screen.findByLabelText('Internal Quality Framework item');
    await waitFor(() => expect([...(item as HTMLSelectElement).options].some((o) => o.textContent?.includes('Course review'))).toBe(true));
    await user.selectOptions(item, [...(item as HTMLSelectElement).options].find((o) => o.textContent?.includes('Course review'))!.value);
    await user.selectOptions(screen.getByLabelText('Relation'), 'partly_covers');
    await user.type(screen.getByLabelText('Commentary'), 'Annual course review');
    await user.click(screen.getByRole('button', { name: 'Propose mapping' }));

    const row = await screen.findByTestId('mapping');
    expect(row.textContent).toContain('Course review');
    expect(row.textContent).toContain('Pending review');
    expect(within(row).getByRole('combobox').closest('select')!.value).toBe('partly_covers');
    await user.click(within(row).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByTestId('mapping').textContent).toContain('Reviewed: approved'));
    expect((await admin.mappings(abetVersion.id)).mappings).toHaveLength(1);
  });

  it('shows the viewer the mappings without the controls to change them', async () => {
    const admin = apiFor('admin');
    const abet = (await admin.frameworks()).find((f) => f.accreditorShortName === 'ABET')!;
    const abetVersion = (await admin.versions(abet.id))[0]!;
    const target = (await admin.requirements(abetVersion.id)).find((r) => r.isAssessable)!;
    const user = userEvent.setup();
    render(wrap(<VersionPage versionId={abetVersion.id} api={apiFor('viewer')} onOpenVersion={() => undefined} />));
    await user.click(await screen.findByRole('tab', { name: 'Mappings' }));
    const tree = await screen.findByRole('tree', { name: 'Requirements to map' });
    await user.click(await within(tree).findByRole('button', { name: new RegExp(target.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }));
    expect(await screen.findByTestId('mapping')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Map to an internal quality framework item' })).toBeNull();
  });
});
