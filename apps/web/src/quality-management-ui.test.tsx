// @vitest-environment jsdom
// Settings -> Quality Management (TASK-079) in the browser, against the real API and database: the template list (default templates,
// filter, new, duplicate, revise, retire and offer again, delete with Undo), the editor (stages, inputs and outputs, live checks in
// plain words, save unfinished, publish, revise) and the read-only view for people who cannot manage cycles.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { DEFAULT_CYCLE_TEMPLATE_KEYS } from '@ams/shared';
import './i18n';
import { resetConfirmForTests } from './components/confirm-dialog';
import { UndoToaster } from './components/undo-toaster';
import { createApi } from './lib/api';
import { cyclesApi } from './lib/cycles-api';
import { settingsApi } from './lib/settings-api';
import { trashApi } from './lib/trash-api';
import { resetUndoForTests } from './lib/undo';
import { SettingsLayout } from './pages/settings/layout';
import { TemplateEditorPage } from './pages/settings/quality-management/template-editor';
import { QualityManagementSettingsPage } from './pages/settings/quality-management/templates-page';

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
const apiOf = (who: string) => createApi(fetcherOf(who));
const cyclesFor = (who: string) => cyclesApi(apiOf(who), fetcherOf(who));
const settingsFor = (who: string) => settingsApi(apiOf(who), fetcherOf(who));
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const list = (who: string, onOpen: (id: string) => void = () => undefined) => <><QualityManagementSettingsPage api={cyclesFor(who)} settingsApi={settingsFor(who)} onOpen={onOpen} /><UndoToaster /></>;
const editor = (who: string, id: string, onBack: () => void = () => undefined) => <><TemplateEditorPage templateId={id} api={cyclesFor(who)} settingsApi={settingsFor(who)} onBack={onBack} /><UndoToaster /></>;
const rowOf = async (name: string) => (await screen.findByRole('button', { name: new RegExp(`^(Edit|View) ${name}$`) })).closest('[data-testid="template-row"]') as HTMLElement;
const defaultOf = async (who: string, key: string) => (await cyclesFor(who).templates()).find((t) => t.key === key)!;
const disabled = (el: HTMLElement) => el.matches(':disabled');
const stageCard = (n: number) => screen.getAllByTestId('stage')[n - 1]!;
const openStage = async (user: ReturnType<typeof userEvent.setup>, n: number) => {
  const card = stageCard(n);
  const toggle = within(card).getAllByRole('button').find((b) => b.hasAttribute('aria-expanded'))!;
  if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
  return within(stageCard(n));
};

configure({ asyncUtilTimeout: 10000 }); // the full run loads the machine: these screens wait on several requests

beforeAll(async () => {
  db = await createTestDb('webqm');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']] as const) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u], role]);
  }
}, 60000);
afterEach(() => { resetConfirmForTests(); cleanup(); resetUndoForTests(); vi.restoreAllMocks(); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('Settings menu', () => {
  it('lists Quality Management for everyone who can read the organization, including a viewer', async () => {
    for (const who of ['viewer', 'admin']) {
      render(wrap(<SettingsLayout api={settingsFor(who)} trashApi={trashApi(apiOf(who))} />));
      expect(await screen.findByRole('link', { name: 'Quality Management' }), who).toBeTruthy();
      cleanup();
    }
  });
});

describe('the template list', () => {
  it('shows a viewer an empty list with no way to add, and a manager the button that adds the default templates', async () => {
    render(wrap(list('viewer')));
    expect((await screen.findByTestId('no-templates')).textContent).toMatch(/No cycle templates yet/);
    expect(screen.queryByRole('button', { name: 'Add the default templates' })).toBeNull();
    expect(screen.getByTestId('read-only-note')).toBeTruthy();
    cleanup();

    const user = userEvent.setup();
    render(wrap(list('admin')));
    await user.click(await screen.findByRole('button', { name: 'Add the default templates' }));
    expect((await screen.findByRole('status')).textContent).toBe('Added 7 default templates.');
    expect(await screen.findAllByTestId('template-row')).toHaveLength(DEFAULT_CYCLE_TEMPLATE_KEYS.length);
    expect(screen.queryByTestId('no-templates')).toBeNull();
    expect(screen.queryByRole('button', { name: /Restore missing defaults/ })).toBeNull();
    // The shipped Evidence collection template stays defined but is not offered (collection is the item's schedule now, DEC-031): it says
    // "coming", like the ones made for Quality Assurance / report cycles.
    const evidenceRow = await rowOf('Evidence collection');
    expect(evidenceRow.textContent).toContain('جمع الأدلة');
    expect(within(evidenceRow).getByTestId('qa-only').textContent).toBe('For report and Quality Assurance cycles (coming)');
    const annual = await rowOf('Annual program report');
    expect(within(annual).getByTestId('qa-only').textContent).toBe('For report and Quality Assurance cycles (coming)');
    expect(annual.textContent).toContain('التقرير السنوي للبرنامج');
    expect(within(annual).getByTestId('template-status').textContent).toBe('Published');
    expect(annual.textContent).toMatch(/Version:1/);
    expect(annual.textContent).toMatch(/Stages:5/);
    expect(annual.textContent).toContain('Shipped default');
    expect(within(annual).getByText('التقرير السنوي للبرنامج').getAttribute('dir')).toBe('auto');
  });

  it('shows a viewer the same list read-only: names to open, no actions', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(wrap(list('viewer', onOpen)));
    const row = await rowOf('Internal audit');
    expect(within(row).queryAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['View Internal audit']);
    expect(screen.queryByRole('button', { name: 'New template' })).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'View Internal audit' }));
    expect(onOpen).toHaveBeenCalledWith((await defaultOf('viewer', 'internal_audit')).id);
  });

  it('filters by status, retires and offers again with Undo, and revises a published template into a draft', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(wrap(list('admin', onOpen)));
    await user.click(await screen.findByRole('button', { name: 'Retire Course assessment (every semester)' }));
    await waitFor(async () => expect(within(await rowOf('Course assessment \\(every semester\\)')).getByTestId('template-status').textContent).toBe('Retired'));
    expect((await screen.findByTestId('toast')).textContent).toContain('Retired the template Course assessment (every semester)');
    await user.selectOptions(screen.getByLabelText('Status'), 'retired');
    expect(screen.getAllByTestId('template-row')).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText('Status'), 'draft');
    expect(screen.queryAllByTestId('template-row')).toHaveLength(0);
    expect(screen.getByText('No template has this status.')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Status'), '');

    await user.click(within(screen.getByTestId('toast')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByText(/^Undone: Retired the template/)).toBeTruthy());
    await waitFor(async () => expect((await defaultOf('admin', 'course_assessment')).status).toBe('published'));

    await user.click(await screen.findByRole('button', { name: 'Retire Course assessment (every semester)' }));
    await waitFor(async () => expect((await defaultOf('admin', 'course_assessment')).status).toBe('retired'));
    await user.click(await screen.findByRole('button', { name: 'Offer Course assessment (every semester) again' }));
    await waitFor(async () => expect((await defaultOf('admin', 'course_assessment')).status).toBe('published'));

    await waitFor(() => expect((screen.getByRole('button', { name: 'Retire Course assessment (every semester)' }) as HTMLButtonElement).disabled).toBe(false));   // the list is settled
    await user.click(await screen.findByRole('button', { name: 'Revise Internal audit' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.any(String)));
    const audit = await defaultOf('admin', 'internal_audit');
    expect(audit).toMatchObject({ status: 'draft', version: 1 });
    // A revised template was published once, so it cannot be deleted.
    expect(within(await rowOf('Internal audit')).queryByRole('button', { name: /^Delete/ })).toBeNull();
    await cyclesFor('admin').publishTemplate(audit.id);
  });

  it('makes a new template, duplicates one, and deletes a draft that was never published (Undo puts it back)', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(wrap(list('lead', onOpen)));
    await user.click(await screen.findByRole('button', { name: 'New template' }));
    const dialog = await screen.findByRole('dialog', { name: 'New template' });
    await user.type(within(dialog).getByLabelText('Template name (English)'), 'Scratch template');
    await user.type(within(dialog).getByLabelText('Template name (Arabic)'), 'قالب تجريبي');
    await user.click(within(dialog).getByRole('button', { name: 'Create and edit' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    const made = (await cyclesFor('lead').templates()).find((t) => t.name === 'Scratch template')!;
    expect(made).toMatchObject({ status: 'draft', version: 0, nameAr: 'قالب تجريبي', key: 'scratch_template', stages: [] });
    expect(onOpen).toHaveBeenCalledWith(made.id);

    await waitFor(() => expect(screen.getByText('Scratch template')).toBeTruthy());
    const row = await rowOf('Scratch template');
    expect(row.textContent).toContain('Not published yet');
    await user.click(within(row).getByRole('button', { name: 'Duplicate Scratch template' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
    expect((await cyclesFor('lead').templates()).some((t) => t.name === 'Copy of Scratch template' && t.key === 'scratch_template_copy')).toBe(true);

    await user.click(await screen.findByRole('button', { name: 'Delete Scratch template' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Scratch template' })).toBeNull());
    const toast = (await screen.findAllByTestId('toast')).find((x) => x.textContent?.includes('Deleted the template Scratch template'))!;
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Edit Scratch template' })).toBeTruthy();
  });

  it('restores only the missing defaults', async () => {
    await db.su.query(`begin; set local session_replication_role = replica; delete from cycle_template where key in ('custom', 'evidence_collection') and institution_id = '${ids.inst}'; commit;`);
    const user = userEvent.setup();
    render(wrap(list('admin')));
    await user.click(await screen.findByRole('button', { name: 'Restore missing defaults (2)' }));
    expect((await screen.findByRole('status')).textContent).toBe('Restored 2 missing default templates.');
    expect(await screen.findByRole('button', { name: 'View Custom (blank)' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'View Evidence collection' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Restore missing defaults/ })).toBeNull();
  });
});

describe('the template editor', () => {
  it('opens a copy of the annual program report, with its stages, inputs, outputs and a timeline', async () => {
    const user = userEvent.setup();
    const src = await defaultOf('admin', 'annual_program_report');
    const copy = await cyclesFor('admin').createTemplate({ key: 'annual_copy', name: 'Annual copy', nameAr: 'نسخة سنوية', anchorKinds: src.anchorKinds, stages: src.stages });
    ids.annual = copy.id;
    render(wrap(editor('admin', copy.id)));
    expect(await screen.findByRole('heading', { name: 'Annual copy' })).toBeTruthy();
    expect(screen.getByTestId('template-status').textContent).toBe('Draft');
    expect(screen.getAllByTestId('stage')).toHaveLength(5);
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(5);
    expect(screen.getByTestId('check-summary').textContent).toMatch(/No problems found/);
    const s1 = await openStage(user, 1);
    expect((s1.getByLabelText('Stage 1: name (English)') as HTMLInputElement).value).toBe('Collect');
    const ar = s1.getByLabelText('Stage 1: name (Arabic)') as HTMLInputElement;
    expect(ar.value).toBe('جمع الأدلة والبيانات');
    expect(ar.getAttribute('dir')).toBe('auto');
    expect(s1.getAllByTestId('input-row')).toHaveLength(3);
    expect((s1.getByLabelText('Stage 1, input 1: where it comes from') as HTMLSelectElement).value).toBe('previous_cycle');
    expect(s1.getByLabelText('Stage 1, input 1: the output it reads').textContent).toContain('Stage 5, Final report: Final report');
    expect(s1.getAllByTestId('output-row')).toHaveLength(1);
    const s3 = await openStage(user, 3);
    expect((s3.getByLabelText('Stage 3, output 1: kind') as HTMLSelectElement).value).toBe('approval');
    expect((s3.getByLabelText('Stage 3, output 1: who approves') as HTMLSelectElement).value).toBe('head_of_unit');
    // The owner rule of an older template stays readable (it is listed while the template holds it); the unit rule is no longer edited.
    expect((s3.getByLabelText('Stage 3: owner') as HTMLSelectElement).value).toBe('head_of_unit');
    expect(s3.getAllByRole('option', { name: 'Head of the unit' }).length).toBeGreaterThan(0);
    expect(s3.queryByLabelText('Stage 3: responsible unit')).toBeNull();
  });

  it('says in plain words what is wrong, per stage, as the stages change; a draft saves unfinished; Publish says what to fix', async () => {
    const user = userEvent.setup();
    render(wrap(editor('admin', ids.annual!)));
    await screen.findByRole('heading', { name: 'Annual copy' });
    // QA review (stage 4) moves below Final report (stage 5): Final report now reads something that comes after it.
    await user.click(screen.getByRole('button', { name: 'Move stage 4 down' }));
    const summary = screen.getByTestId('check-summary');
    expect(summary.textContent).toMatch(/1 to fix/);
    expect(summary.textContent).toContain('Stage 4 ("Final report"), input "QA sign-off" reads "QA review", which comes after it. Move "QA review" above it, or choose another source.');
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This template cannot be published yet. 1 to fix:');
    expect((await cyclesFor('admin').template(ids.annual!)).status).toBe('draft');
    // The stage itself says so too.
    const s4 = await openStage(user, 4);
    expect(s4.getByTestId('stage-problems').textContent).toContain('comes after it');
    expect(within(stageCard(4)).getByTestId('stage-issues').textContent).toBe('1 to fix');
    // An unfinished draft can still be saved: the order is kept.
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByTestId('editor-notice').textContent).toBe('Draft saved.'));
    expect((await cyclesFor('admin').template(ids.annual!)).stages.map((s) => s.key)).toEqual(['collect', 'self_evaluation', 'unit_review', 'final', 'qa_review']);
    expect(screen.getByTestId('save-state').textContent).toBe('All changes saved');
    // Moving it back clears the problems.
    await user.click(screen.getByRole('button', { name: 'Move stage 5 up' }));
    expect(screen.getByTestId('check-summary').textContent).toMatch(/No problems found/);
    expect(screen.getByTestId('save-state').textContent).toBe('Unsaved changes');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(async () => expect((await cyclesFor('admin').template(ids.annual!)).stages.map((s) => s.key)).toEqual(['collect', 'self_evaluation', 'unit_review', 'qa_review', 'final']));
  });

  it('refuses to save a stage with no name until it has one, and turns an input of a removed output into a pick', async () => {
    const user = userEvent.setup();
    render(wrap(editor('admin', ids.annual!)));
    await screen.findByRole('heading', { name: 'Annual copy' });
    const s2 = await openStage(user, 2);
    await user.clear(s2.getByLabelText('Stage 2: name (English)'));
    expect(screen.getByTestId('check-summary').textContent).toContain('Stage 2 needs a name.');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The draft cannot be saved yet:');
    await user.type(s2.getByLabelText('Stage 2: name (English)'), 'Self-evaluation');
    expect(screen.getByTestId('check-summary').textContent).toMatch(/No problems found/);

    // Removing an output that another stage reads turns that input into "something the stage owner picks".
    const s1 = await openStage(user, 1);
    await user.click(s1.getByRole('button', { name: 'Remove output 1 of stage 1' }));
    const s2b = await openStage(user, 2);
    expect((s2b.getByLabelText('Stage 2, input 1: where it comes from') as HTMLSelectElement).value).toBe('pick');
    expect((await screen.findByTestId('editor-notice')).textContent).toMatch(/1 input no longer reads a removed output/);

    // Stage 1 gets a new output for stage 2 to read; the first stage is never offered "an output of an earlier stage".
    await user.click(s1.getByRole('button', { name: 'Add an output to stage 1' }));
    await user.selectOptions(s2b.getByLabelText('Stage 2, input 1: where it comes from'), 'stage_output');
    expect(s2b.getByLabelText('Stage 2, input 1: the output it reads').textContent).toContain('Stage 1, Collect: Output 1');
    await user.click(s1.getByRole('button', { name: 'Add an input to stage 1' }));
    await user.selectOptions(s1.getByLabelText('Stage 1, input 4: where it comes from'), 'previous_cycle');
    // "An output of an earlier stage" is not offered to the first stage.
    expect(s1.getAllByRole('option', { name: 'An output of an earlier stage' }).every((o) => (o as HTMLOptionElement).disabled)).toBe(true);
  });

  it('builds a template from nothing, publishes it as version 1, shows it read-only, and "Revise to edit" opens it again', async () => {
    const user = userEvent.setup();
    const made = await cyclesFor('lead').createTemplate({ key: 'from_nothing', name: 'Built in the editor' });
    render(wrap(editor('lead', made.id)));
    await screen.findByRole('heading', { name: 'Built in the editor' });
    expect(screen.getByText('No stages yet. Add the first one.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Add at least one stage.');

    await user.click(screen.getByRole('button', { name: 'Add a stage' }));
    let s1 = await openStage(user, 1);
    await user.clear(s1.getByLabelText('Stage 1: name (English)'));
    await user.type(s1.getByLabelText('Stage 1: name (English)'), 'Gather');
    await user.type(s1.getByLabelText('Stage 1: name (Arabic)'), 'الجمع');
    await user.type(s1.getByLabelText('Stage 1: checklist'), 'First thing{Enter}Second thing');
    // The owner rule is simple: the cycle's owner (the default), a named role, or the head of the evidence's owner unit.
    expect((s1.getByLabelText('Stage 1: owner') as HTMLSelectElement).value).toBe('cycle_lead');
    expect(Array.from((s1.getByLabelText('Stage 1: owner') as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(['Cycle owner', 'A person with a role', 'Head of the evidence\'s owner unit']);
    expect(s1.queryByLabelText('Stage 1: responsible unit')).toBeNull();
    await user.selectOptions(s1.getByLabelText('Stage 1: owner'), 'role');
    await user.selectOptions(s1.getByLabelText('Stage 1: owner: Role'), 'lead');
    await user.click(s1.getByRole('button', { name: 'Add an output to stage 1' }));
    await user.clear(s1.getByLabelText('Stage 1, output 1: name (English)'));
    await user.type(s1.getByLabelText('Stage 1, output 1: name (English)'), 'Evidence pack');
    await user.selectOptions(s1.getByLabelText('Stage 1, output 1: kind'), 'document');

    await user.click(screen.getByRole('button', { name: 'Add a stage' }));
    const s2 = await openStage(user, 2);
    await user.clear(s2.getByLabelText('Stage 2: name (English)'));
    await user.type(s2.getByLabelText('Stage 2: name (English)'), 'Approve');
    await user.click(s2.getByRole('button', { name: 'Add an output to stage 2' }));
    await user.clear(s2.getByLabelText('Stage 2, output 1: name (English)'));
    await user.type(s2.getByLabelText('Stage 2, output 1: name (English)'), 'Sign-off');
    await user.selectOptions(s2.getByLabelText('Stage 2, output 1: kind'), 'approval');
    expect(s2.getByText(/approval "Sign-off" has no approver rule/)).toBeTruthy();   // a note: it does not stop publishing
    await user.selectOptions(s2.getByLabelText('Stage 2, output 1: who approves'), 'head_of_evidence_unit');
    await user.click(s2.getByRole('button', { name: 'Add an input to stage 2' }));
    await user.selectOptions(s2.getByLabelText('Stage 2, input 1: where it comes from'), 'stage_output');
    expect(s2.getByLabelText('Stage 2, input 1: the output it reads').textContent).toContain('Stage 1, Gather: Evidence pack');
    expect(screen.getByTestId('check-summary').textContent).toMatch(/No problems found/);
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(screen.getByTestId('template-status').textContent).toBe('Published'));
    expect(screen.getByTestId('editor-notice').textContent).toBe('Published as version 1. New cycles use it; running cycles keep their version.');
    const stored = await cyclesFor('lead').template(made.id);
    expect(stored).toMatchObject({ status: 'published', version: 1 });
    expect(stored.stages[0]).toMatchObject({
      key: 'gather', name: 'Gather', nameAr: 'الجمع', checklist: ['First thing', 'Second thing'], unit: { kind: 'cycle' }, owner: { kind: 'role', role: 'lead' },
      outputs: [{ key: 'evidence_pack', kind: 'document' }],
    });
    expect(stored.stages[1]).toMatchObject({
      key: 'approve', outputs: [{ key: 'sign_off', kind: 'approval', approver: { kind: 'head_of_evidence_unit' } }], inputs: [{ from: { stage: 'gather', output: 'evidence_pack' } }],
    });

    // Published: read-only with "Revise to edit".
    s1 = await openStage(user, 1);
    expect(disabled(s1.getByLabelText('Stage 1: name (English)'))).toBe(true);
    expect(disabled(screen.getByLabelText('Template name (English)'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a stage' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Move stage/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Revise to edit' }));
    await waitFor(() => expect(screen.getByTestId('template-status').textContent).toBe('Draft'));
    expect(screen.getByTestId('editor-notice').textContent).toMatch(/Now a draft. Edit it and publish to make version 2/);
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(disabled(screen.getByLabelText('Template name (English)'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(async () => expect((await cyclesFor('lead').template(made.id)).version).toBe(2));
  });

  it('shows a viewer a published template read-only, with no way to edit, save, publish or revise', async () => {
    const audit = await defaultOf('viewer', 'internal_audit');
    const user = userEvent.setup();
    render(wrap(editor('viewer', audit.id)));
    await screen.findByRole('heading', { name: 'Internal audit' });
    expect(screen.getByTestId('read-only-note')).toBeTruthy();
    expect(screen.getByText(/You can view it; people who manage cycles can revise it/)).toBeTruthy();
    for (const name of ['Save draft', 'Publish', 'Revise to edit', 'Add a stage']) expect(screen.queryByRole('button', { name }), name).toBeNull();
    expect(screen.queryByTestId('check-summary')).toBeNull();
    expect(screen.getAllByTestId('stage')).toHaveLength(6);
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(6);
    const s3 = within(stageCard(3));
    expect(s3.getByLabelText('Stage 3: name (English)') && disabled(s3.getByLabelText('Stage 3: name (English)') as HTMLElement)).toBe(true);
    expect(disabled(screen.getByLabelText('Template description'))).toBe(true);
    expect(s3.queryByRole('button', { name: /^Add an? / })).toBeNull();
    await user.click(screen.getAllByRole('button', { name: /^1\. Plan/ })[0]!);
    expect(within(stageCard(1)).queryByLabelText('Stage 1: name (English)')).toBeNull();
  });

  it('asks before leaving a draft with unsaved changes', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const made = await cyclesFor('admin').createTemplate({ key: 'leave_test', name: 'Leave test' });
    render(wrap(editor('admin', made.id, onBack)));
    await screen.findByRole('heading', { name: 'Leave test' });
    await user.click(screen.getByRole('button', { name: /Back to the templates/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText('Template description'), 'Changed');
    await user.click(screen.getByRole('button', { name: /Back to the templates/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /Back to the templates/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(2));
  });
});
