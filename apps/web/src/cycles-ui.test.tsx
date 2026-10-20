// @vitest-environment jsdom
// Quality Management screens (TASK-080) in the browser, against the real API and database: the Cycles tab (list, filters, search, new
// cycle with the launch dialog and its review of who is responsible for each stage, start, delete a draft with Undo, cancel with a
// reason), the cycle page (header, timeline, stages with inputs, process, checklist and outputs, stage actions, approvals decided only by
// the named approver, a return that reopens the earlier stage, editing, building a blank draft, picked inputs, Arabic) and My work, each
// read-only for people who may not change anything. Wording is "Internally approved", never "met" or "compliant" (DEC-005).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import type { CreateCycleTemplate, CycleDetail } from '@ams/shared';
import './i18n';
import { resetConfirmForTests } from './components/confirm-dialog';
import { UndoToaster } from './components/undo-toaster';
import { AppLayout } from './pages/layout';
import { createApi } from './lib/api';
import { cyclesApi } from './lib/cycles-api';
import { documentsApi } from './lib/documents-api';
import { evidenceApi } from './lib/evidence-api';
import { frameworkApi } from './lib/framework-api';
import { plansApi } from './lib/plans-api';
import { scopeApi } from './lib/scope-api';
import { settingsApi } from './lib/settings-api';
import { resetUndoForTests } from './lib/undo';
import { CyclePage } from './pages/cycles/cycle-page';
import { MyWorkTab } from './pages/cycles/my-work';
import { QualityManagementPage, type QmTab } from './pages/quality-management';

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
  return { cycles: cyclesApi(a, f), settings: settingsApi(a, f), scope: scopeApi(a), evidence: evidenceApi(a, f), documents: documentsApi(a, f), framework: frameworkApi(a) };
};
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const tab = (who: string, which: QmTab) => { const a = apis(who); return wrap(<><QualityManagementPage api={a.framework} evidence={a.evidence} apis={a} tab={which} /><UndoToaster /></>); };
const page = (who: string, id: string, stage?: string) => wrap(<><CyclePage id={id} stageId={stage} apis={apis(who)} /><UndoToaster /></>);
const myWork = (who: string) => wrap(<MyWorkTab apis={apis(who)} />);

const NOTE = (key: string, name: string, required = true) => ({ key, name, kind: 'note' as const, required });
/** collect (head of the subject's unit) -> QA review (an approval by the head of the QA office) -> final. Every rule is data. */
const ANNUAL: CreateCycleTemplate = {
  key: 'annual_review', name: 'Annual review', nameAr: 'المراجعة السنوية', anchorKinds: ['org_unit', 'program'], origin: 'manual',
  stages: [
    {
      key: 'collect', name: 'Collect', nameAr: 'جمع البيانات', process: 'Gather the figures.', checklist: ['Pull enrolment', 'Pull results'], unit: { kind: 'subject' }, owner: { kind: 'head_of_unit' },
      startOffsetDays: 0, lengthDays: 14, outputs: [NOTE('summary', 'Summary'), { key: 'data', name: 'Data file', kind: 'document', required: false }],
      inputs: [{ key: 'evidence', name: 'Source evidence', from: { pick: 'evidence' }, required: true }],
    },
    {
      key: 'review', name: 'QA review', process: 'Review the summary.', checklist: [], unit: { kind: 'unit_type', type: 'admin_unit' }, owner: { kind: 'role', role: 'lead' },
      startOffsetDays: 14, lengthDays: 7, outputs: [{ key: 'signoff', name: 'QA sign-off', kind: 'approval', required: true, approver: { kind: 'head_of_unit' } }],
      inputs: [{ key: 'summary', name: 'Summary', from: { stage: 'collect', output: 'summary' }, required: true }],
    },
    {
      key: 'final', name: 'Final', process: '', checklist: [], unit: { kind: 'cycle' }, owner: { kind: 'cycle_lead' }, startOffsetDays: 21, lengthDays: 9,
      outputs: [NOTE('final_note', 'Final note'), { key: 'report', name: 'Report', kind: 'report', required: false, reportTemplateKey: 'annual' }],
      inputs: [{ key: 'signoff', name: 'QA sign-off', from: { stage: 'review', output: 'signoff' }, required: true }],
    },
  ],
};
/** One stage whose owner rule needs a unit head: the unit of one program has none, so the owner cannot be found. */
/** Evidence collection templates (for runs a plan proposes): one whose owner is the cycle's, one that needs the head of the evidence's unit. */
const EVIDENCE_ROUND: CreateCycleTemplate = {
  key: 'evidence_round', name: 'Evidence round', anchorKinds: ['evidence_item'], origin: 'manual',
  stages: [{ key: 'collect', name: 'Collect', process: '', checklist: [], unit: { kind: 'cycle' }, owner: { kind: 'cycle_lead' }, startOffsetDays: 0, lengthDays: 7, outputs: [NOTE('result', 'Result')], inputs: [] }],
};
const EVIDENCE_HEAD: CreateCycleTemplate = {
  key: 'evidence_head', name: 'Evidence unit check', anchorKinds: ['evidence_item'], origin: 'manual',
  stages: [{ key: 'check', name: 'Check', process: '', checklist: [], unit: { kind: 'cycle' }, owner: { kind: 'head_of_evidence_unit' }, startOffsetDays: 0, lengthDays: 7, outputs: [NOTE('result', 'Result')], inputs: [] }],
};
const NEEDS_HEAD: CreateCycleTemplate = {
  key: 'needs_head', name: 'Unit check', anchorKinds: ['program', 'org_unit'], origin: 'manual',
  stages: [{ key: 'check', name: 'Check', process: '', checklist: [], unit: { kind: 'subject' }, owner: { kind: 'head_of_unit' }, startOffsetDays: 0, lengthDays: 7, outputs: [NOTE('result', 'Result')], inputs: [] }],
};

let seq = 0;
/** A cycle of the annual template for the Nursing program, launched (a draft), and started when asked. */
async function annual(opts: { start?: boolean; lead?: string; label?: string } = {}): Promise<CycleDetail> {
  seq += 1;
  const a = apis('admin').cycles;
  const made = await a.launch({ templateId: ids.tplAnnual!, anchorKind: 'program', anchorId: ids.nursing!, startDate: '2099-01-05', leadUserId: ids[opts.lead ?? 'admin']!, periodLabel: opts.label ?? `Round ${seq}` });
  return opts.start === false ? made : a.activate(made.id);
}
/** collect done (so QA review reads a final summary); QA review started by its owner (the lead). */
async function atReview() {
  const c = await annual({});
  const head = apis('headDept').cycles;
  const collect = c.stages[0]!;
  await head.startStage(collect.id);
  await head.setNote(collect.outputs.find((o) => o.key === 'summary')!.id, 'Enrolment grew.');
  await head.finalizeOutput(collect.outputs.find((o) => o.key === 'summary')!.id);
  await head.completeStage(collect.id);
  await apis('lead').cycles.startStage(c.stages[1]!.id);
  return c;
}

const card = (name: string) => screen.getByRole('listitem', { name: `Stage ${name}` });
const chip = (c: HTMLElement) => within(c).getByTestId('stage-status').textContent;

beforeAll(async () => {
  db = await createTestDb('webcycles');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'viewer', 'headDept', 'qaHead']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer'], ['headDept', 'viewer'], ['qaHead', 'viewer']] as const) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u], role]);
  }
  const unit = (type: string, name: string, head: string | null = null) => one(`insert into org_unit (institution_id, type, name_en, head_user_id) values ($1, $2, $3, $4) returning id`, [ids.inst, type, name, head]);
  ids.dept = await unit('department', 'Nursing Department', ids.headDept!);
  ids.qa = await unit('admin_unit', 'QA Office', ids.qaHead!);
  ids.dept2 = await unit('department', 'Pharmacy Department');   // no head
  ids.nursing = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS Nursing', 'bachelor') returning id`, [ids.inst, ids.dept]);
  ids.pharmacy = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS Pharmacy', 'bachelor') returning id`, [ids.inst, ids.dept2]);
  const a = apis('admin').cycles;
  for (const [key, def] of [['tplAnnual', ANNUAL], ['tplNeeds', NEEDS_HEAD], ['tplEvidence', EVIDENCE_ROUND], ['tplHead', EVIDENCE_HEAD]] as const) {
    const t = await a.createTemplate(def);
    ids[key] = (await a.publishTemplate(t.id)).id;
  }
  ids.evidence = (await apis('admin').evidence.create({ title: 'Enrolment report 2025', type: 'document' } as never)).id;
  ids.evidenceUnit = await one(`insert into evidence_item (institution_id, title, type, owner_unit_id, owner_user_id) values ($1, 'Syllabi', 'document', $2, $3) returning id`, [ids.inst, ids.dept, ids.lead]);
}, 120000);
afterEach(() => { resetConfirmForTests(); cleanup(); resetUndoForTests(); vi.restoreAllMocks(); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('the Cycles tab', () => {
  it('lists cycles with what they are about, their owner, the status, the progress and the next stage with its owner and date', async () => {
    const c = await annual({ label: 'AY2026-27' });
    render(tab('admin', 'cycles'));
    const row = (await screen.findByRole('link', { name: c.title })).closest('[data-testid="cycle-row"]') as HTMLElement;
    expect(within(row).getByTestId('cycle-status').textContent).toBe('Active');
    expect(row.textContent).toContain('BS Nursing');
    expect(within(row).getByTestId('cycle-owner').textContent).toBe('admin');
    expect(row.textContent).not.toContain('Nursing Department');   // no responsible unit column
    expect(row.textContent).not.toMatch(/Responsible unit|Subject:/);
    expect(within(row).getByTestId('progress-text').textContent).toBe('0 of 3 stages done');
    expect(within(row).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    const next = within(row).getByTestId('next-stage');
    expect(next.textContent).toMatch(/Collect.*Not started.*headDept.*Due Jan 19, 2099/);
    expect(within(row).getByRole('link', { name: c.title }).getAttribute('href')).toBe(`/quality-management/cycles/${c.id}`);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('flags a stage whose owner the template could not find', async () => {
    const made = await apis('admin').cycles.launch({ templateId: ids.tplNeeds!, anchorKind: 'program', anchorId: ids.pharmacy!, startDate: '2026-09-01' });
    expect(made.unresolvedCount).toBe(1);
    render(tab('admin', 'cycles'));
    const row = (await screen.findByRole('link', { name: made.title })).closest('[data-testid="cycle-row"]') as HTMLElement;
    expect(within(row).getByTestId('unresolved-flag').textContent).toMatch(/Needs an owner/);
    expect(within(row).getByTestId('cycle-status').textContent).toBe('Draft');
    expect(within(row).getByTestId('next-stage').textContent).toContain('No owner chosen');
  });

  it('filters by status, template, only mine, and late or due soon; and searches the title; no unit, program or anchor filters', async () => {
    const user = userEvent.setup();
    const mine = await annual({ lead: 'admin', label: 'Mine-A' });
    const lateOne = await annual({ lead: 'lead', label: 'Late-B' });
    // Make the later one late: its first stage ended long ago.
    const collect = lateOne.stages.find((s) => s.key === 'collect')!;
    await apis('admin').cycles.updateStage(collect.id, { startDate: '2026-01-01', endDate: '2026-01-31' });
    const draft = await apis('admin').cycles.launch({ templateId: ids.tplNeeds!, anchorKind: 'program', anchorId: ids.pharmacy!, startDate: '2026-09-01', periodLabel: 'Draft-C' });
    render(tab('admin', 'cycles'));
    const titles = () => screen.queryAllByTestId('cycle-row').map((r) => within(r).getAllByRole('link')[0]!.textContent);
    await waitFor(() => expect(titles()).toEqual(expect.arrayContaining([mine.title, lateOne.title, draft.title])));

    await user.selectOptions(screen.getByLabelText('Status'), 'draft');
    await waitFor(() => expect(titles()).not.toContain(mine.title));
    await waitFor(() => expect(titles()).toContain(draft.title));
    expect(screen.queryAllByTestId('cycle-row').every((r) => r.getAttribute('data-status') === 'draft')).toBe(true);
    await user.selectOptions(screen.getByLabelText('Status'), '');

    await user.selectOptions(screen.getByLabelText('Template'), ids.tplNeeds!);
    await waitFor(() => expect(titles()).not.toContain(mine.title));
    await waitFor(() => expect(titles()).toContain(draft.title));
    await user.selectOptions(screen.getByLabelText('Template'), '');

    expect(screen.queryByLabelText('Unit or program')).toBeNull();
    expect(screen.queryByLabelText('About')).toBeNull();

    // "Only mine": the person leads the cycle or owns one of its stages (the admin leads Mine-A, not Late-B).
    await user.click(screen.getByRole('checkbox', { name: 'Only mine' }));
    await waitFor(() => expect(titles()).not.toContain(lateOne.title));
    await waitFor(() => expect(titles()).toContain(mine.title));
    await user.click(screen.getByRole('checkbox', { name: 'Only mine' }));

    await user.selectOptions(screen.getByLabelText('Due'), 'late');
    await waitFor(() => expect(titles()).toEqual([lateOne.title]));
    const lateRow = screen.getByTestId('cycle-row');
    expect(within(lateRow).getByTestId('cycle-late').textContent).toBe('Late');
    expect(within(lateRow).getByTestId('next-stage').textContent).toMatch(/Collect.*Due Jan 31, 2026 \(Late\)/);
    await user.selectOptions(screen.getByLabelText('Due'), '');

    await user.type(screen.getByLabelText('Search the cycles'), 'Mine-A');
    await waitFor(() => expect(titles()).toEqual([mine.title]));
  });

  it('starts a draft with Start, cancels a running cycle with a reason, and deletes a draft to the Trash with Undo', async () => {
    const user = userEvent.setup();
    const d1 = await annual({ start: false, label: 'Start-D' });
    const d2 = await annual({ start: false, label: 'Trash-E' });
    const running = await annual({ label: 'Cancel-F' });
    render(tab('admin', 'cycles'));
    const rowOf = async (title: string) => (await screen.findByRole('link', { name: title })).closest('[data-testid="cycle-row"]') as HTMLElement;

    await user.click(await within(await rowOf(d1.title)).findByRole('button', { name: `Start ${d1.title}` }));
    await waitFor(async () => expect(within(await rowOf(d1.title)).getByTestId('cycle-status').textContent).toBe('Active'));
    expect((await apis('admin').cycles.get(d1.id)).status).toBe('active');

    await user.click(await within(await rowOf(running.title)).findByRole('button', { name: `Cancel ${running.title}` }));
    const dialog = await screen.findByRole('dialog', { name: `Cancel ${running.title}` });
    expect((within(dialog).getByRole('button', { name: 'Cancel the cycle' }) as HTMLButtonElement).disabled).toBe(true);   // a reason is needed
    await user.type(within(dialog).getByLabelText('Reason for cancelling'), 'Merged into the institutional review');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the cycle' }));
    await waitFor(async () => expect(within(await rowOf(running.title)).getByTestId('cycle-status').textContent).toBe('Cancelled'));
    expect((await rowOf(running.title)).textContent).toContain('Merged into the institutional review');

    await user.click(await within(await rowOf(d2.title)).findByRole('button', { name: `Delete ${d2.title}` }));
    await user.click(within(await screen.findByRole('dialog', { name: `Delete ${d2.title}?` })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: d2.title })).toBeNull());
    const undo = await screen.findByRole('button', { name: 'Undo' });
    await user.click(undo);
    expect(await screen.findByRole('link', { name: d2.title })).toBeTruthy();
  });

  it('has no New cycle: evidence is collected by the schedule on the item (DEC-031) and cycles for reports and Quality Assurance are coming; the cycles that exist are listed', async () => {
    render(tab('admin', 'cycles'));
    expect(screen.queryByRole('button', { name: 'New cycle' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Cycles made earlier (by the API, which still works) are listed.
    expect((await screen.findAllByRole('link', { name: /Annual review/ })).length).toBeGreaterThan(0);
  });

  it('launches a run a plan proposed: the owner is the plan\'s, the stages follow them, and only what the rules could not settle is asked ("Choose an owner for stage X")', async () => {
    const user = userEvent.setup();
    // A plan (made through the API: no screen makes one) on an evidence item with no unit, for a template whose stage needs that unit's head.
    await plansApi(createApi(fetcherOf('admin'))).set({ anchorKind: 'evidence_item', anchorId: ids.evidence!, templateId: ids.tplHead!, recurrence: { every: 1, unit: 'month' }, firstStart: '2026-01-01', ownerUserId: ids.admin });
    render(myWork('admin'));
    const run = (await screen.findAllByTestId('my-due-run')).find((r) => r.textContent?.includes('Evidence unit check'))!;
    await user.click(within(run).getByRole('button', { name: /^Start Evidence unit check/ }));
    const dialog = await screen.findByRole('dialog', { name: /Launch a proposed run/ });
    expect(Array.from(dialog.querySelectorAll('select, input')).map((el) => el.getAttribute('aria-label'))).toEqual(['Template', 'Evidence item', 'Owner', 'Start date']);
    // Nothing to ask about units, leads or what the cycle is about.
    for (const gone of ['Responsible unit', 'Cycle lead', 'Lead', 'What the cycle is about', 'Who the cycle is about']) expect(within(dialog).queryByLabelText(gone)).toBeNull();
    await waitFor(() => expect((within(dialog).getByLabelText('Evidence item') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Enrolment report 2025'));
    await waitFor(() => expect((within(dialog).getByLabelText('Owner') as HTMLSelectElement).value).toBe(ids.admin));
    await user.click(within(dialog).getByRole('button', { name: 'Create cycle' }));
    const review = await within(dialog).findByTestId('launch-review');
    expect(review.textContent).toMatch(/was created as a draft/);
    const stage = within(review).getByTestId('launch-stage');
    expect(stage.textContent).toContain('Choose an owner for stage Check');
    expect(within(stage).getByTestId('unresolved-owner').textContent).toBe('Not found: choose one');
    expect(within(review).getByTestId('unresolved-note').textContent).toMatch(/1 item\(s\) still need a person/);
    expect(within(review).getByTestId('owner-cascade-note').textContent).toContain('Every stage is owned by admin');
    await user.selectOptions(within(stage).getByLabelText('Owner of Check'), ids.lead!);
    await waitFor(() => expect(within(review).queryByTestId('unresolved-owner')).toBeNull());
    expect(within(review).queryByTestId('unresolved-note')).toBeNull();
    const made = (await apis('admin').cycles.list({ templateId: ids.tplHead })).find((c) => c.planId)!;
    expect(made).toMatchObject({ leadUserId: ids.admin, unresolvedCount: 0, anchorId: ids.evidence });
    await user.click(within(review).getByRole('button', { name: 'Start the cycle' }));
    await waitFor(async () => expect((await apis('admin').cycles.get(made.id)).status).toBe('active'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('is read-only for someone who cannot manage cycles: the list, no row actions, one line saying so', async () => {
    const c = await annual({ label: 'View-G' });
    render(tab('viewer', 'cycles'));
    expect(await screen.findByRole('link', { name: c.title })).toBeTruthy();
    expect(screen.getByTestId('read-only-note').textContent).toBe('You can view this; ask an administrator to change it.');
    expect(screen.queryByRole('button', { name: new RegExp(`^(Start|Cancel|Delete) ${c.title}`) })).toBeNull();
  });
});

describe('the cycle page', () => {
  it('shows the header, the stages on a timeline and in a list, with Arabic names in their own direction', async () => {
    const c = await annual({ label: 'AY2027-28' });
    render(page('viewer', c.id));
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(c.title);
    expect(screen.getByRole('heading', { level: 1 }).getAttribute('dir')).toBe('auto');
    expect(screen.getByTestId('cycle-status').textContent).toBe('Active');
    const header = screen.getByTestId('cycle-page');
    expect(header.textContent).not.toMatch(/Responsible unit|Lead:/);
    for (const text of ['BS Nursing', 'Owner:', 'AY2027-28', 'Annual review · Version 1', '0 of 3 stages done']) expect(header.textContent).toContain(text);
    expect(within(screen.getByTestId('cycle-timeline')).getAllByTestId('timeline-row')).toHaveLength(3);
    expect(screen.getAllByTestId('stage-card')).toHaveLength(3);
    expect(within(card('Collect')).getByText('جمع البيانات').getAttribute('dir')).toBe('auto');
    expect(screen.queryByRole('complementary')).toBeNull();
    // A viewer sees all of it, read-only, with the one line.
    expect(screen.getByTestId('read-only-note').textContent).toMatch(/You can view this/);
    expect(screen.queryByRole('button', { name: /^(Start|Edit|Complete|Skip) /i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit the cycle' })).toBeNull();
  });

  it('shows missing inputs flagged but never blocking, and the process text and checklist', async () => {
    const user = userEvent.setup();
    const c = await annual({});
    render(page('headDept', c.id));
    const collect = await screen.findByRole('listitem', { name: 'Stage Collect' });
    expect(within(collect).getByTestId('process-text').textContent).toBe('Gather the figures.');
    expect(within(collect).getAllByTestId('checklist-item')).toHaveLength(2);
    const input = within(collect).getByTestId('input-row');
    expect(input.getAttribute('data-satisfied')).toBe('false');
    expect(within(input).getByTestId('input-state').textContent).toBe('Missing');
    expect(within(collect).getByText(/does not stop the stage/)).toBeTruthy();
    // The stage owner is the head of the unit; they can start although the input is missing.
    await user.click(within(collect).getByRole('button', { name: 'Start Collect' }));
    await waitFor(() => expect(chip(card('Collect'))).toBe('In progress'));
    // Ticking a checklist item records who and when.
    await user.click(within(card('Collect')).getByRole('checkbox', { name: 'Pull enrolment' }));
    await waitFor(() => expect(within(card('Collect')).getAllByTestId('checklist-item')[0]!.textContent).toMatch(/Ticked by headDept on /));
  });

  it('lets the stage owner work their stage without cycle:work: a note, a document, a picked input, and complete with what is missing explained', async () => {
    const user = userEvent.setup();
    const c = await annual({});
    render(page('headDept', c.id));
    await screen.findByRole('listitem', { name: 'Stage Collect' });
    await user.click(within(card('Collect')).getByRole('button', { name: 'Start Collect' }));
    await waitFor(() => expect(chip(card('Collect'))).toBe('In progress'));

    // Complete is explained, not refused blindly: the required note is not final.
    await user.click(within(card('Collect')).getByRole('button', { name: 'Complete Collect' }));
    const why = within(card('Collect')).getByTestId('complete-explain');
    expect(why.textContent).toMatch(/cannot be completed yet.*Summary/);
    expect(chip(card('Collect'))).toBe('In progress');

    const slot = () => within(card('Collect')).getAllByTestId('output-slot').find((s) => s.getAttribute('data-kind') === 'note')!;
    expect(within(slot()).getByTestId('output-state').textContent).toBe('Missing');
    await user.type(within(slot()).getByLabelText('Text of Summary'), 'Enrolment grew by 4%.');
    await user.click(within(slot()).getByRole('button', { name: 'Save Summary' }));
    await waitFor(() => expect(within(slot()).getByTestId('output-state').textContent).toBe('Draft'));
    await user.click(within(slot()).getByRole('button', { name: 'Mark Summary final' }));
    await waitFor(() => expect(within(slot()).getByTestId('output-state').textContent).toBe('Final'));
    expect(within(slot()).getByTestId('note-text').textContent).toBe('Enrolment grew by 4%.');

    // A document: upload, then it can be downloaded; the optional output does not hold the stage back.
    const doc = () => within(card('Collect')).getAllByTestId('output-slot').find((s) => s.getAttribute('data-kind') === 'document')!;
    await user.upload(within(doc()).getByLabelText('Upload a file for Data file'), new File(['year,n\n2025,100'], 'enrolment.csv', { type: 'text/csv' }));
    await waitFor(() => expect(within(doc()).getByTestId('file-line').textContent).toContain('enrolment.csv'));
    expect(within(doc()).getByRole('link', { name: 'enrolment.csv' }).getAttribute('href')).toBe(`/api/cycle-outputs/${(await apis('admin').cycles.get(c.id)).stages[0]!.outputs[1]!.id}/file`);

    // A picked input: choose an evidence item from the picker.
    await user.click(within(card('Collect')).getByRole('button', { name: 'Pick for Source evidence' }));
    const picker = await screen.findByRole('dialog', { name: 'Choose for Source evidence' });
    await user.click(await within(picker).findByRole('button', { name: 'Enrolment report 2025' }));
    await waitFor(() => expect(within(card('Collect')).getByTestId('pick-value').textContent).toBe('Evidence item: Enrolment report 2025'));
    expect(within(card('Collect')).getByTestId('input-state').textContent).toBe('Ready');

    await user.click(within(card('Collect')).getByRole('button', { name: 'Complete Collect' }));
    await waitFor(() => expect(chip(card('Collect'))).toBe('Completed'));
    // The next stage's input (read from this stage's note) is satisfied now.
    const review = within(card('QA review'));
    expect(review.getByTestId('input-state').textContent).toBe('Ready');
    // A completed stage folds away; reopening is for the owner too.
    await user.click(within(card('Collect')).getByRole('button', { name: 'Show the details of Collect' }));
    await user.click(within(card('Collect')).getByRole('button', { name: 'Reopen Collect' }));
    await waitFor(() => expect(chip(card('Collect'))).toBe('In progress'));
  });

  it('skips a stage with a reason, which is kept, and reopens it', async () => {
    const user = userEvent.setup();
    const c = await annual({});
    render(page('admin', c.id));
    await screen.findByRole('listitem', { name: 'Stage Final' });
    await user.click(within(card('Final')).getByRole('button', { name: 'Skip Final' }));
    const dialog = await screen.findByRole('dialog', { name: 'Skip Final' });
    expect((within(dialog).getByRole('button', { name: 'Skip' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Reason for skipping'), 'Not needed this year');
    await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(chip(card('Final'))).toBe('Skipped'));
    expect(within(card('Final')).getByTestId('skip-reason').textContent).toMatch(/Not needed this year/);
    // A skipped stage folds away; reopening puts it back to not started.
    await user.click(within(card('Final')).getByRole('button', { name: 'Show the details of Final' }));
    await user.click(within(card('Final')).getByRole('button', { name: 'Reopen Final' }));
    await waitFor(() => expect(chip(card('Final'))).toBe('Not started'));
  });

  it('shows a report output as "Report engine pending" with a manual mark-final', async () => {
    const user = userEvent.setup();
    const c = await annual({});
    await apis('admin').cycles.startStage(c.stages[2]!.id);
    render(page('admin', c.id));
    await screen.findByRole('listitem', { name: 'Stage Final' });
    const report = within(card('Final')).getAllByTestId('output-slot').find((s) => s.getAttribute('data-kind') === 'report')!;
    expect(within(report).getByTestId('report-pending').textContent).toMatch(/Report engine pending/);
    await user.click(within(report).getByRole('button', { name: 'Mark Report final' }));
    await waitFor(() => expect(within(report).getByTestId('output-state').textContent).toBe('Final'));
  });

  describe('approvals', () => {
    it('is decided only by the named approver: nobody else gets the buttons, whatever their role', async () => {
      const c = await atReview();
      for (const who of ['admin', 'lead', 'headDept']) {
        render(page(who, c.id));
        await screen.findByRole('listitem', { name: 'Stage QA review' });
        expect(within(card('QA review')).getByTestId('approver-line').textContent).toContain('qaHead');
        expect(within(card('QA review')).queryByTestId('decision-panel'), who).toBeNull();
        expect(within(card('QA review')).getByTestId('waiting-approver').textContent).toBe('Waiting for qaHead to decide.');
        expect(screen.queryByRole('button', { name: 'Internally approved' })).toBeNull();
        cleanup();
      }
      render(page('qaHead', c.id));
      await screen.findByRole('listitem', { name: 'Stage QA review' });
      const panel = within(card('QA review')).getByTestId('decision-panel');
      expect(within(panel).getAllByRole('button').map((b) => b.textContent)).toEqual(['Internally approved', 'Internally approved with conditions', 'Returned for changes']);
      expect(document.body.textContent).not.toMatch(/\bcompliant\b|\bmet\b/i);
    });

    it('needs a comment to approve with conditions or to return, and says "Internally approved" for a plain approval', async () => {
      const user = userEvent.setup();
      const c = await atReview();
      render(page('qaHead', c.id));
      await screen.findByRole('listitem', { name: 'Stage QA review' });
      const panel = () => within(card('QA review')).getByTestId('decision-panel');
      await user.click(within(panel()).getByRole('button', { name: 'Internally approved with conditions' }));
      expect(within(panel()).getByRole('alert').textContent).toMatch(/A comment is required/);
      expect((await apis('admin').cycles.get(c.id)).stages[1]!.outputs[0]!.state).toBe('missing');
      await user.type(within(panel()).getByLabelText('Comment on QA sign-off'), 'Add the 2024 figures next year.');
      await user.click(within(panel()).getByRole('button', { name: 'Internally approved with conditions' }));
      const decision = await within(card('QA review')).findByTestId('decision');
      expect(decision.getAttribute('data-decision')).toBe('approved_with_conditions');
      expect(decision.textContent).toContain('Internally approved with conditions');
      expect(decision.textContent).toContain('Add the 2024 figures next year.');
      expect(within(card('QA review')).getByTestId('output-state').textContent).toBe('Final');
      expect(within(card('QA review')).queryByTestId('decision-panel')).toBeNull();   // decided
      // The sign-off is final, so the stage can now be completed (by its owner, not by the approver).
      expect((await apis('lead').cycles.completeStage(c.stages[1]!.id)).stages[1]!.status).toBe('completed');
    });

    it('a return reopens the earlier stage that produced what was reviewed, and leaves the approval to be decided again', async () => {
      const user = userEvent.setup();
      const c = await atReview();
      render(page('qaHead', c.id));
      await screen.findByRole('listitem', { name: 'Stage QA review' });
      expect(chip(card('Collect'))).toBe('Completed');
      await user.type(within(card('QA review')).getByLabelText('Comment on QA sign-off'), 'The enrolment figures need a source.');
      await user.click(within(card('QA review')).getByRole('button', { name: 'Returned for changes' }));
      await waitFor(() => expect(chip(card('Collect'))).toBe('In progress'));
      expect(screen.getByTestId('notice').textContent).toMatch(/Returned for changes. The earlier stage is open again./);
      const decision = within(card('QA review')).getByTestId('decision');
      expect(decision.getAttribute('data-decision')).toBe('returned');
      expect(decision.textContent).toContain('The enrolment figures need a source.');
      expect(within(card('QA review')).getByTestId('output-state').textContent).toBe('Draft');
      // The summary the stage reads is a draft again, so the input shows missing (never blocking).
      expect(within(card('QA review')).getByTestId('input-state').textContent).toBe('Missing');
      // The approver can decide again later.
      expect(within(card('QA review')).getByTestId('decision-panel')).toBeTruthy();
    });
  });

  it('is edited by people who manage the cycle: a stage\'s owner and dates (with an Undo), and the cycle\'s own details', async () => {
    const user = userEvent.setup();
    const c = await annual({});
    render(page('admin', c.id));
    await screen.findByRole('listitem', { name: 'Stage Final' });
    await user.click(within(card('Final')).getByRole('button', { name: 'Edit Final' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Final' });
    await user.selectOptions(within(dialog).getByLabelText('Owner'), ids.lead!);
    await user.clear(within(dialog).getByLabelText('End date'));
    await user.type(within(dialog).getByLabelText('End date'), '2099-12-31');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(card('Final')).getByTestId('stage-owner').textContent).toContain('lead'));
    expect(card('Final').textContent).toContain('Dec 31, 2099');
    expect((await apis('admin').cycles.get(c.id)).stages[2]).toMatchObject({ ownerUserId: ids.lead, endDate: '2099-12-31' });
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(within(card('Final')).getByTestId('stage-owner').textContent).toContain('admin'));

    await user.click(screen.getByRole('button', { name: 'Edit the cycle' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit the cycle' });
    expect((within(edit).getByLabelText('Start date') as HTMLInputElement).disabled).toBe(true);   // a running cycle keeps its start
    await user.clear(within(edit).getByLabelText('Title'));
    await user.type(within(edit).getByLabelText('Title'), 'Nursing annual review 2026-27');
    await user.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Nursing annual review 2026-27'));
  });

  it('has one owner: stages follow it until given their own, the owner is changed once and the stages that follow move with it', async () => {
    const user = userEvent.setup();
    const c = await annual({ lead: 'admin' });   // Collect: the unit head's rule, Review: the person with the role, Final: the cycle's owner
    render(page('admin', c.id));
    await screen.findByRole('listitem', { name: 'Stage Final' });
    // The header has an Owner and no Lead or Responsible unit.
    const header = screen.getByTestId('cycle-page');
    expect(screen.getByTestId('cycle-owner').textContent).toBe('admin');
    expect(header.textContent).not.toMatch(/Responsible unit|Lead:/);
    expect(screen.getByTestId('owner-cascade').textContent).toMatch(/owned by the cycle owner unless it has an owner of its own/);
    expect(within(card('Final')).getByTestId('owner-source').textContent).toBe('Cycle owner');
    expect(within(card('Collect')).getByTestId('owner-source').textContent).toBe('Own owner');
    expect(card('Final').textContent).not.toContain('Responsible unit');

    // Change the cycle's owner: the stage that followed it follows; the stage with an owner of its own keeps it.
    await user.click(screen.getByRole('button', { name: 'Edit the cycle' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit the cycle' });
    expect(within(edit).queryByLabelText('Responsible unit')).toBeNull();
    await user.selectOptions(within(edit).getByLabelText('Owner'), ids.qaHead!);
    await user.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('cycle-owner').textContent).toBe('qaHead'));
    await waitFor(() => expect(within(card('Final')).getByTestId('stage-owner').textContent).toContain('qaHead'));
    expect(within(card('Final')).getByTestId('owner-source').textContent).toBe('Cycle owner');
    expect(within(card('Collect')).getByTestId('stage-owner').textContent).toContain('headDept');

    // Give Final an owner of its own (the stage dialog offers the cycle's owner first); the next change of the cycle's owner leaves it alone.
    await user.click(within(card('Final')).getByRole('button', { name: 'Edit Final' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Final' });
    expect(within(dialog).queryByLabelText('Responsible unit')).toBeNull();
    expect(within(dialog).getAllByRole('option').map((o) => o.textContent)).toContain('qaHead (the cycle owner)');
    await user.selectOptions(within(dialog).getByLabelText('Owner'), ids.lead!);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(card('Final')).getByTestId('owner-source').textContent).toBe('Own owner'));
    await user.click(screen.getByRole('button', { name: 'Edit the cycle' }));
    const again = await screen.findByRole('dialog', { name: 'Edit the cycle' });
    await user.selectOptions(within(again).getByLabelText('Owner'), ids.admin!);
    await user.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('cycle-owner').textContent).toBe('admin'));
    expect(within(card('Final')).getByTestId('stage-owner').textContent).toContain('lead');
    expect((await apis('admin').cycles.get(c.id)).stages.map((s) => s.ownerUserId)).toEqual([ids.headDept, ids.lead, ids.lead]);
  });

  it('cancels a running cycle with a reason, which stays on the page, and then nothing can be worked', async () => {
    const user = userEvent.setup();
    const c = await annual({});
    render(page('admin', c.id));
    await screen.findByRole('listitem', { name: 'Stage Final' });
    await user.click(screen.getByRole('button', { name: 'Cancel the cycle' }));
    const dialog = await screen.findByRole('dialog', { name: `Cancel ${c.title}` });
    await user.type(within(dialog).getByLabelText('Reason for cancelling'), 'The program is being merged');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the cycle' }));
    await waitFor(() => expect(screen.getByTestId('cycle-status').textContent).toBe('Cancelled'));
    expect(screen.getByTestId('cancel-reason').textContent).toContain('The program is being merged');
    expect(screen.queryByRole('button', { name: /^Start /})).toBeNull();
  });

  it('links to the previous cycle of the same template and deletes a draft to the Trash with Undo', async () => {
    const user = userEvent.setup();
    const first = await annual({ label: 'AY2025-26' });
    const second = await annual({ start: false, label: 'AY2026-27' });
    expect((await apis('admin').cycles.get(second.id)).previousCycleId).toBe(first.id);
    render(page('admin', second.id));
    expect(await screen.findByTestId('draft-note')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the previous cycle' }).getAttribute('href')).toBe(`/quality-management/cycles/${first.id}`);
    await user.click(screen.getByRole('button', { name: 'Delete the draft' }));
    await user.click(within(await screen.findByRole('dialog', { name: `Delete ${second.title}?` })).getByRole('button', { name: 'Delete' }));
    await waitFor(async () => expect((await apis('admin').cycles.list({ q: 'AY2026-27' })).some((x) => x.id === second.id)).toBe(false));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('builds a blank draft by hand: stages, an output, an input, who signs, then starts it', async () => {
    const user = userEvent.setup();
    const blank = await apis('admin').cycles.launch({ anchorKind: 'org_unit', anchorId: ids.dept!, startDate: '2026-09-01', title: 'Hand-made review' });
    expect(blank.stages).toHaveLength(0);
    render(page('admin', blank.id));
    expect((await screen.findByTestId('no-stages')).textContent).toMatch(/Add them by hand/);
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);   // needs a stage first

    await user.click(screen.getByRole('button', { name: 'Add a stage' }));
    let dialog = await screen.findByRole('dialog', { name: 'Add a stage' });
    await user.type(within(dialog).getByLabelText('Name'), 'Gather');
    await user.type(within(dialog).getByLabelText('Checklist (one item per line)'), 'Ask the department{enter}Collect the files');
    await user.selectOptions(within(dialog).getByLabelText('Owner'), ids.headDept!);
    await user.click(within(dialog).getByRole('button', { name: 'Add stage' }));
    await waitFor(() => expect(screen.getAllByTestId('stage-card')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Add a stage' }));
    dialog = await screen.findByRole('dialog', { name: 'Add a stage' });
    await user.type(within(dialog).getByLabelText('Name'), 'Approve');
    await user.click(within(dialog).getByRole('button', { name: 'Add stage' }));
    await waitFor(() => expect(screen.getAllByTestId('stage-card')).toHaveLength(2));
    expect(within(card('Gather')).getAllByTestId('checklist-item')).toHaveLength(2);

    await user.click(within(card('Gather')).getByRole('button', { name: 'Add an output' }));
    dialog = await screen.findByRole('dialog', { name: 'Add an output to Gather' });
    await user.type(within(dialog).getByLabelText('Name'), 'Findings');
    await user.click(within(dialog).getByRole('button', { name: 'Add output' }));
    await waitFor(() => expect(within(card('Gather')).getAllByTestId('output-slot')).toHaveLength(1));

    await user.click(within(card('Approve')).getByRole('button', { name: 'Add an output' }));
    dialog = await screen.findByRole('dialog', { name: 'Add an output to Approve' });
    await user.type(within(dialog).getByLabelText('Name'), 'Sign-off');
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'approval');
    await user.selectOptions(within(dialog).getByLabelText('Approver'), ids.qaHead!);
    await user.click(within(dialog).getByRole('button', { name: 'Add output' }));
    await waitFor(() => expect(within(card('Approve')).getAllByTestId('output-slot')).toHaveLength(1));
    expect(within(card('Approve')).getByTestId('approver-line').textContent).toContain('qaHead');

    await user.click(within(card('Approve')).getByRole('button', { name: 'Add an input' }));
    dialog = await screen.findByRole('dialog', { name: 'Add an input to Approve' });
    await user.type(within(dialog).getByLabelText('Name'), 'The findings');
    await user.selectOptions(within(dialog).getByLabelText('Output'), within(dialog).getByRole('option', { name: 'Gather → Findings' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add input' }));
    await waitFor(() => expect(within(card('Approve')).getAllByTestId('input-row')).toHaveLength(1));
    expect(within(card('Approve')).getByTestId('input-row').textContent).toContain('Gather');

    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(screen.getByTestId('cycle-status').textContent).toBe('Active'));
    expect(screen.queryByTestId('draft-note')).toBeNull();
    expect((await apis('admin').cycles.get(blank.id)).stages.map((s) => s.name)).toEqual(['Gather', 'Approve']);
  });
});

describe('My work', () => {
  it('lists the stages I own and the approvals waiting for me, each linking to the stage, with late flags', async () => {
    const c = await annual({});
    // The head of the unit owns Collect (made late); the head of the QA office has an approval once QA review starts.
    await apis('admin').cycles.updateStage(c.stages[0]!.id, { startDate: '2026-01-01', endDate: '2026-01-31' });
    const head = apis('headDept').cycles;
    await head.startStage(c.stages[0]!.id);
    await head.setNote(c.stages[0]!.outputs[0]!.id, 'Done.');
    await head.finalizeOutput(c.stages[0]!.outputs[0]!.id);
    await head.completeStage(c.stages[0]!.id);
    await apis('lead').cycles.startStage(c.stages[1]!.id);

    render(myWork('qaHead'));
    const approval = (await screen.findAllByTestId('my-approval')).find((a) => a.textContent?.includes(c.title))!;
    expect(within(approval).getByRole('link', { name: 'QA sign-off' }).getAttribute('href')).toBe(`/quality-management/cycles/${c.id}?stage=${c.stages[1]!.id}`);
    expect(approval.textContent).toContain('QA review');
    cleanup();

    render(myWork('lead'));
    const mine = (await screen.findAllByTestId('my-stage')).find((s) => s.textContent?.includes(c.title))!;
    expect(within(mine).getByRole('link', { name: 'QA review' }).getAttribute('href')).toBe(`/quality-management/cycles/${c.id}?stage=${c.stages[1]!.id}`);
    expect(mine.textContent).toMatch(/In progress/);
    cleanup();

    // The late one is the head's other cycle: make a fresh cycle whose first stage is late and owned by the head.
    const late = await annual({});
    await apis('admin').cycles.updateStage(late.stages[0]!.id, { startDate: '2026-01-01', endDate: '2026-01-31' });
    render(myWork('headDept'));
    const lateStage = (await screen.findAllByTestId('my-stage')).find((s) => s.textContent?.includes(late.title))!;
    expect(lateStage.getAttribute('data-late')).toBe('true');
    expect(within(lateStage).getByTestId('my-late').textContent).toBe('Late');
    expect(lateStage.textContent).toMatch(/1 inputs and 1 outputs still missing|1 inputs and 2 outputs still missing/);
  });

  it('lists the runs that have fallen due of plans I own, each with a Start that opens the launch dialog with the template and the evidence item fixed', async () => {
    const user = userEvent.setup();
    const admin = plansApi(createApi(fetcherOf('admin')));
    await admin.set({ anchorKind: 'evidence_item', anchorId: ids.evidenceUnit!, templateId: ids.tplEvidence!, recurrence: { every: 1, unit: 'month' }, firstStart: '2026-01-01', ownerUserId: ids.lead });
    // Someone else's plan is not mine.
    render(myWork('viewer'));
    expect((await screen.findByTestId('my-work-empty')).textContent).toBe('Nothing is waiting for you.');
    cleanup();

    render(myWork('lead'));
    const run = (await screen.findAllByTestId('my-due-run'))[0]!;
    expect(run.textContent).toContain('Evidence round');
    expect(run.textContent).toContain('Syllabi');
    expect(within(run).getByTestId('due-state').textContent).toBe('Due');
    await user.click(within(run).getByRole('button', { name: /^Start Evidence round/ }));
    const dialog = await screen.findByRole('dialog', { name: /Launch a proposed run/ });
    expect((within(dialog).getByLabelText('Template') as HTMLSelectElement).disabled).toBe(true);
    await waitFor(() => expect((within(dialog).getByLabelText('Evidence item') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Syllabi'));
    await waitFor(() => expect((within(dialog).getByLabelText('Owner') as HTMLSelectElement).value).toBe(ids.lead));
    await user.click(within(dialog).getByRole('button', { name: 'Create cycle' }));
    await within(dialog).findByTestId('launch-review');
    await user.click(within(dialog).getByRole('button', { name: 'Keep as a draft' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const made = (await apis('lead').cycles.list({ anchorKind: 'evidence_item', anchorId: ids.evidenceUnit! })).find((c) => c.planId);
    expect(made).toMatchObject({ leadUserId: ids.lead, status: 'draft', anchorName: 'Syllabi' });
    // The run is launched: it is no longer waiting to be started.
    await waitFor(() => expect(screen.queryByTestId('my-due-run')).toBeNull());
  });

  it('says there is nothing waiting for someone with no stage and no approval, and is a tab of Quality Management', async () => {
    render(tab('viewer', 'my-work'));
    expect((await screen.findByTestId('my-work-empty')).textContent).toBe('Nothing is waiting for you.');
    expect(screen.getByRole('tab', { name: 'My work' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('the menu', () => {
  it('shows "My work (N)" only while something waits for the person, and it opens My work', async () => {
    const shell = (who: string) => { const a = apis(who); return <AppLayout api={a.settings} cycles={a.cycles} />; };
    const nav = async () => { await screen.findByTestId('institution-name'); return screen.getByRole('navigation', { name: 'Main' }); };
    // The viewer owns no stage and has no approval.
    render(wrap(shell('viewer')));
    const main = await nav();
    await waitFor(() => expect(within(main).getByRole('link', { name: 'Evidence' })).toBeTruthy());
    expect(within(main).queryByRole('link', { name: /My work/ })).toBeNull();
    cleanup();
    // The head of the QA office has an approval waiting once QA review has started.
    await atReview();
    render(wrap(shell('qaHead')));
    const link = await within(await nav()).findByRole('link', { name: /^My work \(\d+\)$/ });
    expect(link.getAttribute('href')).toBe('/quality-management?tab=my-work');
  });
});
