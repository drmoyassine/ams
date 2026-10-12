// @vitest-environment jsdom
// The in-app assistant in the browser (DEC-027): the bubble, the panel, sending and following a turn, the steps with links, the
// context chips, "Remember this?" cards, history, the not-set-up state, and the Assistant memory page. Real API, fake model.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@ams/api';
import { createFakeAiModel, fakeToolCalls, handlers, runJob, setAiModelForTests } from '@ams/core';
import type { JobEnvelope } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { AssistantPanel, type AssistantTarget } from './components/assistant/panel';
import { MarkdownLite } from './components/assistant/markdown-lite';
import { resetConfirmForTests } from './components/confirm-dialog';
import { assistantApi, type AssistantApi } from './lib/assistant-api';
import { publishScreen, registerAssistantNav, resetScreenForTests } from './lib/assistant-screen';
import { createApi } from './lib/api';
import { engagementApi } from './lib/engagement-api';
import { frameworkApi } from './lib/framework-api';
import { settingsApi } from './lib/settings-api';
import { AppLayout } from './pages/layout';
import { AssistantMemoryPage } from './pages/settings/assistant-memory';

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
/** Runs the queued assistant job(s) once the request that queued them has been answered. */
const drain = async () => { await waitFor(() => expect(sent.length).toBeGreaterThan(0)); while (sent.length) await runJob(pool, 'assistant', sent.shift(), handlers, { queue }); };
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderPanel(who: string, over: { modal?: boolean; canManageAi?: boolean; api?: AssistantApi } = {}) {
  const onNavigate = vi.fn<(t: AssistantTarget) => void>();
  const onClose = vi.fn();
  const api = over.api ?? assistantFor(who);
  const ui = (
    <QueryClientProvider client={client()}>
      <AssistantPanel api={api} modal={over.modal ?? false} pollMs={30} onClose={onClose} onNavigate={onNavigate} canManageAi={over.canManageAi ?? false} />
    </QueryClientProvider>
  );
  return { ...render(ui), onNavigate, onClose, api };
}
const composer = () => screen.getByRole('textbox', { name: 'Ask the assistant' }) as HTMLTextAreaElement;
async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  await waitFor(() => expect(composer().disabled).toBe(false));
  await user.type(composer(), `${text}{Enter}`);
}
function layout(who: string) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <AppLayout api={settingsApi(createApi(fetchFor(who)))} assistant={assistantFor(who)} /> }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return <QueryClientProvider client={client()}><RouterProvider router={router} /></QueryClientProvider>;
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('webassistant');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, queue, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const [n, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']] as const) {
    ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[n], role]);
  }
  ids.acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Council', 'IC', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Handbook', 'institution') returning id`, [ids.inst, ids.acc]);
  ids.ver = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2025') returning id`, [ids.inst, ids.fw]);
  ids.req = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, official_text) values ($1, $2, '1.1', 'Standard', 'Library resources', 'The library supports learning.') returning id`, [ids.inst, ids.ver]);
  ids.req2 = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, official_text) values ($1, $2, '1.2', 'Standard', 'Governance', 'Board oversight.') returning id`, [ids.inst, ids.ver]);
}, 30000);
afterAll(async () => { setAiModelForTests(null); await pool.end(); await db.close(); });
beforeEach(() => { setAiModelForTests(createFakeAiModel(['Hello.']).model); sent.length = 0; });
afterEach(() => { cleanup(); resetConfirmForTests(); resetScreenForTests(); setAiModelForTests(null); document.documentElement.classList.remove('assistant-open'); });

describe('the bubble and the panel', () => {
  it('shows a labelled bubble on every signed-in screen, opens the panel, and Escape closes it and returns focus', async () => {
    const user = userEvent.setup();
    render(layout('viewer'));
    const bubble = await screen.findByRole('button', { name: 'Assistant' });
    expect(bubble.className).toContain('print:hidden');
    expect(bubble.className).toMatch(/min-h-11/); // 44 px to tap
    await user.click(bubble);
    const panel = await screen.findByRole('dialog', { name: 'Assistant' });
    expect(within(panel).getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(screen.queryByTestId('assistant-bubble')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole('textbox', { name: 'Ask the assistant' })));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assistant' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('assistant-bubble')));
  });

  it('closes with its close button too', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel('lead');
    await user.click(screen.getByRole('button', { name: 'Close the assistant' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('on a phone it is a modal sheet: the page is locked and Tab stays inside', async () => {
    const user = userEvent.setup();
    renderPanel('lead', { modal: true });
    const panel = screen.getByRole('dialog', { name: 'Assistant' });
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');
    const buttons = within(panel).getAllByRole('button');
    buttons[buttons.length - 1]!.focus();
    for (let i = 0; i < 12; i++) await user.tab();
    expect(panel.contains(document.activeElement)).toBe(true);
  });
});

describe('not set up', () => {
  it('says plainly that the assistant is not set up and links an administrator to Settings → AI', async () => {
    setAiModelForTests(null);
    const user = userEvent.setup();
    const { onNavigate } = renderPanel('admin', { canManageAi: true });
    const note = await screen.findByTestId('assistant-unavailable');
    expect(note.textContent).toMatch(/not set up/i);
    expect(composer().disabled).toBe(true);
    await user.click(within(note).getByRole('button', { name: /Open Settings/ }));
    expect(onNavigate).toHaveBeenCalledWith({ to: '/settings/ai' });
  });

  it('tells other people to ask an administrator, and says when the assistant is switched off', async () => {
    await db.su.query(`insert into ai_setting (institution_id, enabled, assistant_enabled) values ($1, true, false)`, [ids.inst]);
    try {
      renderPanel('viewer');
      const note = await screen.findByTestId('assistant-unavailable');
      expect(note.textContent).toMatch(/switched off/i);
      expect(note.textContent).toMatch(/administrator/i);
      expect(within(note).queryByRole('button')).toBeNull();
    } finally { await db.su.query(`delete from ai_setting`); }
  });
});

describe('asking', () => {
  it('sends with Enter, follows the turn, shows the steps collapsed with links, and opens a requirement in place', async () => {
    setAiModelForTests(createFakeAiModel([
      fakeToolCalls([{ name: 'search_requirements', input: { versionId: ids.ver, query: 'library' } }]),
      'The library one is **1.1**.\n\n- It is about resources\n- Source: page 1',
    ]).model);
    const showRequirement = vi.fn();
    registerAssistantNav(ids.ver!, { showRequirement, showPage: vi.fn() });
    const user = userEvent.setup();
    renderPanel('viewer');
    await ask(user, 'Which standard is about the library?');
    // The question is on the end side at once; the reply is on its way.
    expect((await screen.findByTestId('message-user')).textContent).toBe('Which standard is about the library?');
    expect(composer().disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(await screen.findByRole('status')).toBeTruthy();
    await drain();
    const answer = await screen.findByText(/The library one is/);
    expect(answer.querySelector('strong')?.textContent).toBe('1.1');
    expect(screen.getAllByRole('listitem').some((li) => li.textContent === 'It is about resources')).toBe(true);
    // Steps: collapsed "Looked up 1 thing", with the requirement as a chip.
    const steps = screen.getByTestId('assistant-steps') as HTMLDetailsElement;
    expect(steps.open).toBe(false);
    expect(within(steps).getByText('Looked up 1 thing')).toBeTruthy();
    const chip = within(steps).getByRole('button', { name: /Open requirement 1.1/ });
    expect(chip.textContent).toBe('1.1');
    await user.click(chip);
    expect(showRequirement).toHaveBeenCalledWith(ids.req);
    // The composer is free again; the usage is shown.
    await waitFor(() => expect(composer().disabled).toBe(false));
    expect(screen.getByTestId('assistant-usage').textContent).toMatch(/tokens/);
    expect(screen.getByTestId('chat-title').textContent).toBe('Which standard is about the library?');
  });

  it('opens a requirement or a source page through the router when the current screen cannot', async () => {
    setAiModelForTests(createFakeAiModel([
      fakeToolCalls([{ name: 'get_requirement', input: { requirementId: ids.req } }]), 'Read it.',
    ]).model);
    const user = userEvent.setup();
    const { onNavigate } = renderPanel('viewer');
    await ask(user, 'Read 1.1');
    await drain();
    await screen.findByText('Read it.');
    await user.click(within(screen.getByTestId('assistant-steps')).getByRole('button', { name: /Open requirement/ }));
    expect(onNavigate).toHaveBeenCalledWith({ to: '/settings/versions/$versionId', params: { versionId: ids.ver }, search: { req: ids.req } });
  });

  it('Shift+Enter makes a new line and does not send; Enter on an empty box sends nothing', async () => {
    const user = userEvent.setup();
    renderPanel('viewer');
    await waitFor(() => expect(composer().disabled).toBe(false));
    await user.type(composer(), 'line one{Shift>}{Enter}{/Shift}line two');
    expect(composer().value).toBe('line one\nline two');
    expect(screen.queryByTestId('message-user')).toBeNull();
    await user.clear(composer());
    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('message-user')).toBeNull();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a failed turn with its reason and a Retry that asks again', async () => {
    setAiModelForTests(createFakeAiModel([new Error('provider is down'), 'Back again.']).model);
    const user = userEvent.setup();
    renderPanel('viewer');
    await ask(user, 'Anything there?');
    await drain();
    const failed = await screen.findByTestId('assistant-error');
    expect(failed.textContent).toMatch(/did not answer: provider is down/);
    await user.click(within(failed).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(sent.length).toBe(1));
    await drain();
    await screen.findByText('Back again.');
    expect(screen.getAllByTestId('message-user')).toHaveLength(2);
  });

  it('Stop ends a running turn and says so; the person can ask again', async () => {
    const user = userEvent.setup();
    renderPanel('viewer');
    await ask(user, 'Take your time');
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    await screen.findByText('Stopped.');
    await waitFor(() => expect(composer().disabled).toBe(false));
    sent.length = 0;
  });

  it('shows the server\'s reason when a message is refused (the per-hour limit)', async () => {
    await db.su.query(`insert into job (institution_id, type, payload, created_by) select $1, 'assistant', '{}'::jsonb, $2 from generate_series(1, 30)`, [ids.inst, ids.viewer]);
    try {
      const user = userEvent.setup();
      renderPanel('viewer');
      await ask(user, 'One too many');
      const err = await screen.findByTestId('assistant-send-error');
      expect(err.textContent).toMatch(/30 assistant questions/);
      expect(composer().value).toBe('One too many'); // nothing was lost
    } finally { await db.su.query(`delete from job where type = 'assistant' and created_by = $1`, [ids.viewer]); sent.length = 0; }
  });

  it('renders Arabic with automatic direction and never raw HTML', async () => {
    setAiModelForTests(createFakeAiModel(['مرحبا **بكم**\n\n<script>window.hacked = 1</script><img src=x onerror="window.hacked=2">']).model);
    const user = userEvent.setup();
    renderPanel('viewer');
    await ask(user, 'هل يمكنك مساعدتي؟');
    await drain();
    const answer = await screen.findByText(/مرحبا/);
    expect(answer.getAttribute('dir')).toBe('auto');
    expect(screen.getByTestId('message-user').querySelector('p')?.getAttribute('dir')).toBe('auto');
    const log = screen.getByRole('log');
    expect(log.querySelector('script')).toBeNull();
    expect(log.querySelector('img')).toBeNull();
    expect(log.textContent).toContain('<script>');
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
  });

  it('announces new messages in a live region', async () => {
    renderPanel('viewer');
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(log.getAttribute('aria-live')).toBe('polite');
  });
});

describe('context chips', () => {
  it('shows where the person is, lets them remove a chip, and sends only what is left', async () => {
    publishScreen('version-page', { versionId: ids.ver, versionLabel: 'IC 2025', tab: 'requirements', tabLabel: 'Requirements' });
    publishScreen('tree-selection', { selectedIds: [ids.req!, ids.req2!] });
    const user = userEvent.setup();
    renderPanel('viewer');
    const chips = await screen.findByRole('list', { name: 'What the assistant can see on this screen' });
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent?.replace('✕', ''))).toEqual(['Working on IC 2025', 'Requirements', '2 selected']);
    await user.click(within(chips).getByRole('button', { name: 'Remove “2 selected”' }));
    expect(within(chips).queryByText('2 selected')).toBeNull();
    await ask(user, 'What is here?');
    await drain();
    await screen.findByText('Hello.');
    const stored = await db.su.query(`select context from assistant_message where role = 'user' order by created_at desc limit 1`);
    expect(stored.rows[0].context).toEqual({ versionId: ids.ver, tab: 'requirements' });
  });

  it('removing the version chip drops its tab and selection, and sends no version', async () => {
    publishScreen('version-page', { versionId: ids.ver, versionLabel: 'IC 2025', tab: 'report', tabLabel: 'Report' });
    publishScreen('tree-selection', { selectedIds: [ids.req!] });
    const user = userEvent.setup();
    renderPanel('viewer');
    await user.click(await screen.findByRole('button', { name: 'Remove “Working on IC 2025”' }));
    expect(screen.queryByRole('list', { name: 'What the assistant can see on this screen' })).toBeNull();
    await ask(user, 'Without context');
    await drain();
    await screen.findByText('Hello.');
    const stored = await db.su.query(`select context from assistant_message where role = 'user' order by created_at desc limit 1`);
    expect(stored.rows[0].context).toBeNull();
  });

  it('shows a Settings page by its name when there is no version or engagement', async () => {
    publishScreen('route', { route: '/settings/ai', routeLabel: 'Settings · AI' });
    renderPanel('viewer');
    expect((await screen.findByRole('list', { name: 'What the assistant can see on this screen' })).textContent).toContain('Settings · AI');
  });
});

describe('Remember this?', () => {
  const propose = (over: Record<string, unknown> = {}) => createFakeAiModel([
    fakeToolCalls([{ name: 'propose_memory', input: { text: 'I prefer English titles', kind: 'preference', ...over } }]), 'I suggested a note.',
  ]).model;

  it('shows a card with the words, who sees it and what it is about; Save stores it as the person', async () => {
    setAiModelForTests(propose({ scope: { type: 'version', id: ids.ver }, visibility: 'workspace' }));
    publishScreen('version-page', { versionId: ids.ver, versionLabel: 'IC 2025', tab: 'requirements', tabLabel: 'Requirements' });
    const user = userEvent.setup();
    renderPanel('lead');
    await ask(user, 'Remember that I prefer English titles');
    await drain();
    const card = await screen.findByTestId('memory-card');
    expect(within(card).getByRole('heading', { name: 'Remember this?' })).toBeTruthy();
    expect((within(card).getByRole('textbox', { name: 'What to remember' }) as HTMLTextAreaElement).value).toBe('I prefer English titles');
    const who = within(card).getByRole('combobox', { name: 'Who sees it' }) as HTMLSelectElement;
    expect([...who.options].map((o) => o.text)).toEqual(['Only me', 'Everyone who can see IC 2025']);
    expect(who.value).toBe('workspace');
    expect((await db.su.query(`select count(*)::int as n from memory_item`)).rows[0].n).toBe(0);
    await user.clear(within(card).getByRole('textbox', { name: 'What to remember' }));
    await user.type(within(card).getByRole('textbox', { name: 'What to remember' }), 'We prefer English titles');
    await waitFor(() => expect((within(card).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    const saved = await screen.findByTestId('memory-card-saved');
    expect(saved.textContent).toContain('We prefer English titles');
    const rows = (await db.su.query(`select text, visibility, scope_type, created_by from memory_item`)).rows;
    expect(rows).toEqual([{ text: 'We prefer English titles', visibility: 'workspace', scope_type: 'version', created_by: ids.lead }]);
    await db.su.query(`delete from memory_item`);
  });

  it('Not now stores nothing; a person who may not share gets the reason and can keep it for themselves', async () => {
    setAiModelForTests(propose());
    const user = userEvent.setup();
    renderPanel('viewer');
    await ask(user, 'remember I like short answers');
    await drain();
    let card = await screen.findByTestId('memory-card');
    // A viewer chooses to share it and is refused with the rule.
    const who = within(card).getByRole('combobox', { name: 'Who sees it' });
    await user.selectOptions(who, 'workspace');
    // Saving waits until the assistant has finished its answer.
    await waitFor(() => expect((within(card).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    expect((await within(card).findByRole('alert')).textContent).toMatch(/administrator|permission/);
    expect((await db.su.query(`select count(*)::int as n from memory_item`)).rows[0].n).toBe(0);
    card = screen.getByTestId('memory-card');
    await user.click(within(card).getByRole('button', { name: 'Not now' }));
    await screen.findByTestId('memory-card-declined');
    expect((await db.su.query(`select count(*)::int as n from memory_item`)).rows[0].n).toBe(0);
  });
});

describe('history', () => {
  it('lists the person\'s chats, opens one, and deletes one after an in-app question', async () => {
    const user = userEvent.setup();
    const first = renderPanel('lead');
    await ask(user, 'First question about the library');
    await drain();
    await screen.findByText('Hello.');
    first.unmount();
    // A new panel (a new visit): the chat is in the history.
    renderPanel('lead');
    await user.click(await screen.findByRole('button', { name: 'Chat history' }));
    const list = await screen.findByRole('list', { name: 'Your chats' });
    expect(await within(list).findByText('First question about the library')).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: /^First question/ }));
    expect(await screen.findByText('Hello.')).toBeTruthy();
    expect(screen.getByTestId('chat-title').textContent).toBe('First question about the library');
    // Delete: the app's own question, not the browser's.
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByRole('button', { name: /Delete the chat “First question/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('First question about the library')).toBeNull());
    expect((await db.su.query(`select count(*)::int as n from assistant_conversation where title = 'First question about the library'`)).rows[0].n).toBe(0);
    expect((await db.su.query(`select count(*)::int as n from assistant_message m where not exists (select 1 from assistant_conversation c where c.id = m.conversation_id)`)).rows[0].n).toBe(0);
  });

  it('New chat starts empty; rename changes the title', async () => {
    const user = userEvent.setup();
    renderPanel('lead');
    await ask(user, 'Rename me please');
    await drain();
    await screen.findByText('Hello.');
    await user.click(screen.getByRole('button', { name: 'Rename this chat' }));
    const title = screen.getByRole('textbox', { name: 'Chat title' });
    await user.clear(title);
    await user.type(title, 'My notes{Enter}');
    await waitFor(() => expect(screen.getByTestId('chat-title').textContent).toBe('My notes'));
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByTestId('message-user')).toBeNull();
    expect(screen.getByTestId('assistant-empty')).toBeTruthy();
  });
});

describe('markdown-lite', () => {
  it('renders bold, lists, italics and code without making links or HTML', () => {
    const { container } = render(<MarkdownLite text={'Hello **bold** and *it* and `code`\n\n1. one\n2. two\n\n- a\n- b\n\n```\nlet x = 1;\n```\n[click](http://evil.example) <b>raw</b>'} />);
    expect(container.querySelectorAll('strong,em,code').length).toBe(3);
    expect(container.querySelectorAll('ol li').length).toBe(2);
    expect(container.querySelectorAll('ul li').length).toBe(2);
    expect(container.querySelector('pre')?.textContent).toBe('let x = 1;');
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>raw</b>');
  });
});

describe('Settings -> Assistant memory', () => {
  const page = (who: string) => {
    const f = createApi(fetchFor(who));
    return render(
      <QueryClientProvider client={client()}>
        <AssistantMemoryPage api={assistantFor(who)} frameworks={frameworkApi(f)} engagements={engagementApi(f)} />
      </QueryClientProvider>,
    );
  };

  it('adds, edits, pins and deletes a personal note; Mine and Shared tabs; a filter by what it is about', async () => {
    await db.su.query(`delete from memory_item`);
    const user = userEvent.setup();
    page('lead');
    expect(await screen.findByTestId('memory-empty')).toBeTruthy();
    // Add (personal, for a version).
    await user.click(screen.getByRole('button', { name: 'Add memory' }));
    let dialog = await screen.findByRole('dialog', { name: 'Add memory' });
    await user.type(within(dialog).getByRole('textbox', { name: 'What to remember' }), 'Keep Arabic as written');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Version: IC 2025' })).toBeTruthy());
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'About' }), 'Version: IC 2025');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    const row = await screen.findByTestId('memory-row');
    expect(row.textContent).toContain('Keep Arabic as written');
    expect(row.textContent).toContain('Only me');
    expect(row.textContent).toContain('IC 2025');
    expect(row.textContent).toContain('By you');
    // Share one with the team.
    await user.click(screen.getByRole('button', { name: 'Add memory' }));
    dialog = await screen.findByRole('dialog', { name: 'Add memory' });
    await user.type(within(dialog).getByRole('textbox', { name: 'What to remember' }), 'We call Measure Indicator group');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'About' }), 'Standard: IC Handbook');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Who sees it' }), 'workspace');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add memory' })?.querySelector('[role="alert"]')?.textContent ?? 'closed').toBe('closed'));
    await waitFor(() => expect(screen.getAllByTestId('memory-row')).toHaveLength(2));
    // Filter by what it is about.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by what it is about' }), 'Version: IC 2025');
    await waitFor(() => expect(screen.getAllByTestId('memory-row')).toHaveLength(1));
    expect(screen.getByTestId('memory-row').textContent).toContain('Keep Arabic as written');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by what it is about' }), 'Everything');
    await waitFor(() => expect(screen.getAllByTestId('memory-row')).toHaveLength(2));
    // Edit, pin.
    await user.click(screen.getByRole('button', { name: /^Edit: Keep Arabic/ }));
    dialog = await screen.findByRole('dialog', { name: 'Edit this memory' });
    const text = within(dialog).getByRole('textbox', { name: 'What to remember' });
    await user.clear(text);
    await user.type(text, 'Keep Arabic exactly as written');
    await user.type(within(dialog).getByLabelText('Forget on'), '2999-01-01');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit this memory' })).toBeNull());
    const edited = (await screen.findByText('Keep Arabic exactly as written')).closest('[data-testid="memory-row"]') as HTMLElement;
    expect(edited.textContent).toContain('Forgotten on');
    await user.click(within(edited).getByRole('button', { name: /^Pin:/ }));
    await waitFor(() => expect(screen.getAllByTestId('memory-row')[0]!.textContent).toContain('Keep Arabic exactly as written')); // pinned first
    expect(await screen.findByLabelText('Pinned')).toBeTruthy();
    // Delete asks first, in the app's own dialog; the note is archived (Show removed), then deleted for good.
    await user.click(screen.getByRole('button', { name: /^Delete: We call Measure/ }));
    let ask = await screen.findByRole('dialog', { name: 'Delete this memory?' });
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.getAllByTestId('memory-row')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /^Delete: We call Measure/ }));
    ask = await screen.findByRole('dialog', { name: 'Delete this memory?' });
    await user.click(within(ask).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getAllByTestId('memory-row')).toHaveLength(1));
    await user.click(screen.getByRole('checkbox', { name: 'Show removed' }));
    await waitFor(() => expect(screen.getAllByTestId('memory-row')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: /^Delete for good: We call Measure/ }));
    ask = await screen.findByRole('dialog', { name: 'Delete this memory for good?' });
    await user.click(within(ask).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getAllByTestId('memory-row')).toHaveLength(1));
    expect((await db.su.query(`select count(*)::int as n from memory_item`)).rows[0].n).toBe(1);
    await db.su.query(`delete from memory_item`);
  });

  it('Shared shows what the team wrote, read-only for a person who cannot edit what it is about', async () => {
    await db.su.query(`delete from memory_item`);
    await db.su.query(`insert into memory_item (institution_id, scope_type, scope_id, visibility, kind, text, created_by) values ($1, 'version', $2, 'workspace', 'convention', 'In IC the statement is the title', $3)`, [ids.inst, ids.ver, ids.lead]);
    await db.su.query(`insert into memory_item (institution_id, scope_type, visibility, kind, text, created_by) values ($1, 'institution', 'private', 'preference', 'lead private note', $2)`, [ids.inst, ids.lead]);
    const user = userEvent.setup();
    page('viewer');
    await user.click(await screen.findByRole('tab', { name: 'Shared' }));
    const row = await screen.findByTestId('memory-row');
    expect(row.textContent).toContain('In IC the statement is the title');
    expect(row.textContent).toContain('By lead');
    expect(row.textContent).toContain('Shared');
    expect(within(row).queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(within(row).queryByRole('button', { name: /^Delete/ })).toBeNull();
    expect(screen.queryByText('lead private note')).toBeNull(); // never another person's private note
    await user.click(screen.getByRole('tab', { name: 'Mine' }));
    await screen.findByTestId('memory-empty');
    await db.su.query(`delete from memory_item`);
  });
});
