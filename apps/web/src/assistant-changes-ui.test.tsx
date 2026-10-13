// @vitest-environment jsdom
// The assistant's bulk edits in the browser (DEC-027 Phase 2): the proposal card in the chat (every state), Do it / Change it /
// Cancel, Undo and Redo in the card, the "Written by the assistant" marker with Keep and Revert, the phone sheet. Real API and
// database, fake model.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@ams/api';
import { createFakeAiModel, fakeToolCalls, handlers, runJob, setAiModelForTests } from '@ams/core';
import type { ChangeProposalPart, JobEnvelope } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { AssistantPanel } from './components/assistant/panel';
import { ChangeCard } from './components/assistant/change-card';
import { WrittenByAssistant } from './components/assistant/written-marker';
import { resetConfirmForTests } from './components/confirm-dialog';
import { assistantApi, type AssistantApi } from './lib/assistant-api';
import { resetScreenForTests } from './lib/assistant-screen';
import { ApiError } from './lib/framework-api';
import { createApi } from './lib/api';
import { getToasts, resetUndoForTests } from './lib/undo';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const sent: JobEnvelope[] = [];
const queue = { send: async (_t: string, e: JobEnvelope) => { sent.push(e); } };
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetchFor = (who: string) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const assistantFor = (who: string): AssistantApi => assistantApi(createApi(fetchFor(who)));
const drain = async () => { await waitFor(() => expect(sent.length).toBeGreaterThan(0)); while (sent.length) await runJob(pool, 'assistant', sent.shift(), handlers, { queue }); };
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const composer = () => screen.getByRole('textbox', { name: 'Ask the assistant' }) as HTMLTextAreaElement;
const row = async (code: string) => (await db.su.query(`select * from requirement where framework_version_id = $1 and code = $2`, [ids.draft, code])).rows[0];

function renderPanel(api: AssistantApi, modal = false) {
  return render(<QueryClientProvider client={client()}><AssistantPanel api={api} modal={modal} pollMs={30} onClose={vi.fn()} onNavigate={vi.fn()} canManageAi={false} /></QueryClientProvider>);
}
/** The person asks; the (scripted) model proposes; the card is on screen. */
async function askForChange(user: ReturnType<typeof userEvent.setup>, operations: unknown[], summary: string, text = 'Please make the change') {
  setAiModelForTests(createFakeAiModel([
    fakeToolCalls([{ name: 'propose_changes', input: { versionId: ids.draft, summary, operations } }]),
    'I will make the change. Please press Do it.',
  ]).model);
  await db.su.query(`delete from job where type = 'assistant'`);
  await waitFor(() => expect(composer().disabled).toBe(false));
  await user.type(composer(), `${text}{Enter}`);
  await drain();
  const card = await screen.findByTestId('change-card');
  // The card shows up while the turn is still being polled; the buttons wait for the assistant to finish.
  await waitFor(() => expect((within(card).getByTestId('change-do-it') as HTMLButtonElement).disabled).toBe(false));
  return card;
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('webassistantchanges');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, queue, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const [n, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']] as const) {
    ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[n], role]);
  }
  ids.acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Council', 'IC', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Handbook', 'institution') returning id`, [ids.inst, ids.acc]);
  ids.draft = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, 'D1') returning id`, [ids.inst, ids.fw]);
  const std = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, official_text, display_order) values ($1, $2, '1', 'Standard', 'Library', 'Resources.', 0) returning id`, [ids.inst, ids.draft]);
  for (let i = 1; i <= 4; i += 1) {
    await db.su.query(
      `insert into requirement (institution_id, framework_version_id, parent_id, code, level_label, title, official_text, display_order) values ($1, $2, $3, $4, 'Indicator', $4, $5, $6)`,
      [ids.inst, ids.draft, std, `1-${i}`, i === 2 ? 'توضح رسالة المؤسسة الغرض من إنشائها.' : `The statement of indicator ${i}.`, i]);
  }
  await db.su.query(`insert into requirement (institution_id, framework_version_id, parent_id, code, level_label, title, display_order) values ($1, $2, $3, 'EMPTY-1', 'Measure', 'An empty heading', 9)`, [ids.inst, ids.draft, std]);
}, 30000);
afterAll(async () => { setAiModelForTests(null); await pool.end(); await db.close(); });
beforeEach(() => { sent.length = 0; resetUndoForTests(); });
afterEach(() => { cleanup(); resetConfirmForTests(); resetScreenForTests(); resetUndoForTests(); setAiModelForTests(null); });

const swap = [{ op: 'swap_title_and_description', filter: { level: 'Indicator' } }];

describe('the proposal card', () => {
  it('says in plain words what will be done, with the count and real examples, and offers Do it / Change it / Cancel (keyboard reachable)', async () => {
    const user = userEvent.setup();
    renderPanel(assistantFor('lead'));
    const card = await askForChange(user, swap, 'Make the statement the title of the 4 indicators in IC D1');
    expect(within(card).getByRole('heading', { name: /Proposed change/ })).toBeTruthy();
    expect(card.textContent).toMatch(/Make the statement the title of the 4 indicators/);
    expect(within(card).getByTestId('change-count').textContent).toBe('4 items will change');
    const examples = within(card).getByRole('list', { name: 'Examples' });
    expect(examples.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
    expect(examples.textContent).toContain('1-2');
    expect(examples.textContent).toContain('توضح رسالة المؤسسة');
    // Every text is shown as text with dir="auto", so Arabic and English each read in their own direction.
    expect([...examples.querySelectorAll('span[dir="auto"]')].length).toBeGreaterThan(2);
    expect(card.textContent).toMatch(/Nothing has been changed yet/);
    expect(card.querySelector('img, script')).toBeNull();
    const buttons = within(card).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Do it', 'Change it', 'Cancel']);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(false);
    // Tab reaches them in order.
    await user.click(composer());
    (buttons[0] as HTMLElement).focus();
    await user.tab();
    expect(document.activeElement).toBe(buttons[1]);
    await user.tab();
    expect(document.activeElement).toBe(buttons[2]);
    expect((await row('1-1')).title).toBe('1-1'); // nothing changed by asking
  });

  it('Do it applies the change, shows progress then the result with Undo and Redo, and the normal Undo toast; Undo and Redo work from the card', async () => {
    const user = userEvent.setup();
    renderPanel(assistantFor('lead'));
    const card = await askForChange(user, swap, 'Statement into title');
    await user.click(within(card).getByTestId('change-do-it'));
    const result = await within(card).findByTestId('change-result');
    expect(result.textContent).toMatch(/Changed 4 items in IC D1/);
    expect((await row('1-1')).title).toBe('The statement of indicator 1.');
    expect((await row('1-1')).official_text).toBeNull();
    expect(within(card).queryByTestId('change-do-it')).toBeNull();
    // The toast every reversible action gets (one descriptor for the whole group), and its Undo is the same group.
    expect(getToasts().some((t) => t.kind === 'undo' && /Changed 4 items/.test(t.label))).toBe(true);
    const undoButton = within(card).getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    const redoButton = within(card).getByRole('button', { name: 'Redo' }) as HTMLButtonElement;
    expect(undoButton.disabled).toBe(false);
    expect(redoButton.disabled).toBe(true);
    await user.click(undoButton);
    await waitFor(() => expect(within(card).getByTestId('change-result').textContent).toMatch(/Undone/));
    expect((await row('1-1')).title).toBe('1-1');
    expect(getToasts().some((t) => t.kind === 'redo' && /Undone: Changed 4 items/.test(t.label))).toBe(true);
    expect((within(card).getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(within(card).getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(within(card).getByTestId('change-result').textContent).not.toMatch(/Undone/));
    expect((await row('1-1')).title).toBe('The statement of indicator 1.');
    // And the saved conversation shows the same card state after a reload of the chat.
    const conv = (await assistantFor('lead').conversations())[0]!;
    const stored = (await assistantFor('lead').conversation(conv.id)).messages.flatMap((m) => m.parts).find((p) => p.type === 'change_proposal') as ChangeProposalPart;
    expect(stored).toMatchObject({ status: 'applied', result: { state: 'applied', items: 4 } });
    // Put the data back for the tests that follow.
    await db.su.query(`update requirement set official_text = title, title = code where framework_version_id = $1 and level_label = 'Indicator'`, [ids.draft]);
  });

  it('names every delete, with what goes with it, and says they go to the Trash', async () => {
    const user = userEvent.setup();
    renderPanel(assistantFor('lead'));
    const card = await askForChange(user, [{ op: 'delete_by_filter', filter: { emptyHeading: true, level: 'Measure' }, reason: 'empty headings' }], 'Delete the empty heading');
    const deletes = within(card).getByTestId('change-deletes');
    expect(deletes.textContent).toMatch(/1 delete, to the Trash/);
    expect(deletes.textContent).toContain('EMPTY-1 An empty heading');
    await user.click(within(card).getByTestId('change-cancel'));
    expect((await within(card).findByTestId('change-cancelled')).textContent).toMatch(/Cancelled. Nothing was changed/);
    expect(await row('EMPTY-1')).toBeDefined();
    expect((within(card).queryByTestId('change-do-it'))).toBeNull();
  });

  it('shows what was skipped and why', async () => {
    const user = userEvent.setup();
    renderPanel(assistantFor('lead'));
    await db.su.query(`update requirement set official_text = null where framework_version_id = $1 and code = '1-3'`, [ids.draft]);
    try {
      const card = await askForChange(user, swap, 'Statement into title');
      const skipped = within(card).getByTestId('change-skipped');
      expect(skipped.textContent).toMatch(/1 item skipped/);
      expect(skipped.textContent).toMatch(/1-3: .*no description/);
    } finally { await db.su.query(`update requirement set official_text = 'The statement of indicator 3.' where framework_version_id = $1 and code = '1-3'`, [ids.draft]); }
  });

  it('Change it keeps the card and hands the person the composer; their next message replaces the card', async () => {
    const user = userEvent.setup();
    renderPanel(assistantFor('lead'));
    const card = await askForChange(user, swap, 'Statement into title');
    await user.click(within(card).getByTestId('change-change-it'));
    expect(document.activeElement).toBe(composer());
    expect(composer().value).toMatch(/^Change it/);
    setAiModelForTests(createFakeAiModel(['Tell me what to change.']).model);
    await user.clear(composer());
    await user.type(composer(), 'Only the first two{Enter}');
    await drain();
    await waitFor(() => expect(screen.getByTestId('change-superseded')).toBeTruthy());
    const old = screen.getByTestId('change-card');
    expect(old.getAttribute('data-status')).toBe('superseded');
    for (const b of within(old).queryAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect((await row('1-1')).title).toBe('1-1');
  });

  it('a change that no longer holds says so in plain words and changes nothing', async () => {
    const user = userEvent.setup();
    renderPanel(assistantFor('lead'));
    const card = await askForChange(user, swap, 'Statement into title');
    await db.su.query(`update requirement set official_text = 'Edited meanwhile.' where framework_version_id = $1 and code = '1-1'`, [ids.draft]);
    await user.click(within(card).getByTestId('change-do-it'));
    const stale = await within(card).findByTestId('change-stale');
    expect(stale.textContent).toMatch(/This proposal changed or expired: ask me again/);
    expect((await row('1-1')).title).toBe('1-1');
    expect(card.getAttribute('data-status')).toBe('stale');
    await db.su.query(`update requirement set official_text = 'The statement of indicator 1.' where framework_version_id = $1 and code = '1-1'`, [ids.draft]);
  });

  it('a failure after Do it is shown with its plain reason and nothing is changed', async () => {
    const user = userEvent.setup();
    const real = assistantFor('lead');
    renderPanel({ ...real, applyChange: async (messageId, partId) => { const c = await real.confirmChange(messageId, partId); void c; throw new ApiError(500, 'The server could not finish: please try again.'); } });
    const card = await askForChange(user, swap, 'Statement into title');
    await user.click(within(card).getByTestId('change-do-it'));
    expect((await within(card).findByTestId('change-error')).textContent).toMatch(/could not finish/);
    expect(within(card).getByTestId('change-do-it')).toBeTruthy(); // still pending: the person can try again
    expect((await row('1-1')).title).toBe('1-1');
  });

  it('an expired or used confirmation asks for a new proposal', async () => {
    const user = userEvent.setup();
    const real = assistantFor('lead');
    renderPanel({ ...real, applyChange: async () => { throw new ApiError(409, 'This confirmation was already used, has expired or is not valid. Press Do it again.', [], { code: 'confirmation' }); } });
    const card = await askForChange(user, swap, 'Statement into title');
    await user.click(within(card).getByTestId('change-do-it'));
    expect((await within(card).findByTestId('change-error')).textContent).toBe('This proposal changed or expired: ask me again.');
  });

  it('a failed apply (the server says failed) shows the reason', async () => {
    const user = userEvent.setup();
    const real = assistantFor('lead');
    renderPanel({
      ...real,
      applyChange: async (messageId, partId, token) => {
        const a = await real.applyChange(messageId, partId, token);
        return { ...a, status: 'failed' as const, part: { ...a.part, status: 'failed' as const, result: null, error: 'A rule of the standard refused the second step.' } };
      },
    });
    const card = await askForChange(user, [{ op: 'bulk_set_assessable', filter: { level: 'Indicator' }, value: false }], 'Not assessable');
    await user.click(within(card).getByTestId('change-do-it'));
    const failed = await within(card).findByTestId('change-failed');
    expect(failed.textContent).toMatch(/Nothing was changed. A rule of the standard refused/);
    await db.su.query(`update requirement set is_assessable = true where framework_version_id = $1`, [ids.draft]);
  });

  it('waits while the assistant is still answering, and is read by assistive technology (live region, labelled section and groups)', () => {
    const part = { id: 'p1', type: 'change_proposal', status: 'pending', versionId: ids.draft, versionLabel: 'IC D1', summary: 'Do a thing', operations: [], changeSetHash: 'h', planHash: 'p',
      counts: { items: 2, byOperation: [{ op: 'set_fields', label: 'Edit fields', items: 2 }], deletes: 0, linksByCode: 0, writtenByAssistant: 0 }, examples: [], skipped: [], skippedCount: 0, deletes: [], deletesCount: 0,
      warnings: [], dryRun: { ok: true, problems: [] }, remaining: 0, newDraft: null, result: null, error: null } as unknown as ChangeProposalPart;
    render(<ChangeCard part={part} messageId="m" api={assistantFor('lead')} locked onUpdate={vi.fn()} onChangeIt={vi.fn()} onChanged={vi.fn()} />);
    const card = screen.getByTestId('change-card');
    expect(card.getAttribute('aria-labelledby')).toBeTruthy();
    expect(within(card).getByRole('group', { name: 'Your answer' })).toBeTruthy();
    expect(within(card).getAllByRole('status').length).toBeGreaterThan(0);
    for (const b of within(card).getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(card.textContent).toMatch(/when the assistant has finished/);
  });

  it('works as a full-screen sheet on a phone: the same card, buttons at least 44 px to tap, long text wraps', async () => {
    const user = userEvent.setup();
    renderPanel(assistantFor('lead'), true);
    const card = await askForChange(user, swap, 'Statement into title');
    expect(screen.getByRole('dialog', { name: 'Assistant' }).getAttribute('aria-modal')).toBe('true');
    for (const b of within(card).getAllByRole('button')) expect(b.className).toMatch(/min-h-11/);
    expect(card.querySelector('[class*="overflow-wrap:anywhere"]')).not.toBeNull();
    expect(card.className).not.toMatch(/w-\[/); // no fixed width: it takes the sheet's width
  });
});

describe('a new draft is its own step', () => {
  it('shows "Start a new draft" with the edition and applies it as a confirmed step', async () => {
    const user = userEvent.setup();
    renderPanel(assistantFor('lead'));
    setAiModelForTests(createFakeAiModel([fakeToolCalls([{ name: 'create_draft_proposal', input: { sourceVersionId: ids.draft, edition: 'D2' } }]), 'I can start a new draft. Press Do it.']).model);
    await db.su.query(`delete from job where type = 'assistant'`);
    await waitFor(() => expect(composer().disabled).toBe(false));
    await user.type(composer(), `Start a new draft{Enter}`);
    await drain();
    const card = await screen.findByTestId('change-card');
    await waitFor(() => expect((within(card).getByTestId('change-do-it') as HTMLButtonElement).disabled).toBe(false));
    expect(within(card).getByRole('heading', { name: /Start a new draft/ })).toBeTruthy();
    expect(within(card).getByTestId('change-count').textContent).toBe('A new draft, D2, copied from IC D1');
    await user.click(within(card).getByTestId('change-do-it'));
    expect((await within(card).findByTestId('change-result')).textContent).toMatch(/Started the draft D2/);
    expect((await db.su.query(`select status from framework_version where edition = 'D2'`)).rows[0].status).toBe('draft');
  });
});

describe('Written by the assistant', () => {
  it('marks a text the assistant wrote until the person keeps it or reverts it (Revert is an undoable edit)', async () => {
    const user = userEvent.setup();
    const lead = assistantFor('lead');
    const target = await row('1-3');
    const was = target.title as string;
    // The assistant's rewrite is applied through the same card.
    const view = renderPanel(lead);
    const card = await askForChange(user, [{ op: 'rewrite_text', field: 'title', instruction: 'a short title', items: [{ id: target.id, text: 'A short title' }] }], 'Write a short title for 1-3');
    expect(card.textContent).toMatch(/1 text will be written by the assistant/);
    await user.click(within(card).getByTestId('change-do-it'));
    await within(card).findByTestId('change-result');
    view.unmount();

    const shell = (api: AssistantApi) => <QueryClientProvider client={client()}><WrittenByAssistant versionId={ids.draft!} requirementId={target.id} canWrite api={api} /></QueryClientProvider>;
    const first = render(shell(lead));
    const marker = await screen.findByTestId('written-by-assistant');
    expect(marker.textContent).toMatch(/Written by the assistant.*title has not been reviewed/);
    await user.click(within(marker).getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(screen.queryByTestId('written-by-assistant')).toBeNull());
    expect((await row('1-3')).title).toBe(was);
    expect(getToasts().some((t) => t.kind === 'undo' && /Edited 1-3/.test(t.label))).toBe(true); // reverting is an ordinary, undoable edit
    first.unmount();

    // Another text, kept this time.
    const second = await row('1-4');
    renderPanel(lead);
    const card2 = await askForChange(user, [{ op: 'rewrite_text', field: 'title', instruction: 'x', items: [{ id: second.id, text: 'Another short title' }] }], 'Write a short title for 1-4');
    await user.click(within(card2).getByTestId('change-do-it'));
    await within(card2).findByTestId('change-result');
    cleanup();
    render(<QueryClientProvider client={client()}><WrittenByAssistant versionId={ids.draft!} requirementId={second.id} canWrite api={lead} /></QueryClientProvider>);
    await user.click(within(await screen.findByTestId('written-by-assistant')).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.queryByTestId('written-by-assistant')).toBeNull());
    expect((await row('1-4')).title).toBe('Another short title');
    // A viewer sees the marker but has no buttons.
    await db.su.query(`update assistant_written_text set state = 'pending' where requirement_id = $1`, [second.id]);
    cleanup();
    render(<QueryClientProvider client={client()}><WrittenByAssistant versionId={ids.draft!} requirementId={second.id} canWrite={false} api={assistantFor('viewer')} /></QueryClientProvider>);
    const note = await screen.findByTestId('written-by-assistant');
    expect(within(note).queryByRole('button')).toBeNull();
  });
});
