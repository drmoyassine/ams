// @vitest-environment jsdom
// Org chart -> Docs (TASK-073): the Docs tab of the Org chart section, the review of units read from a chart beside the image, and
// the apply as one undoable change, against the real API and database; the worker runs with a fake model (no network).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createFakeAiModel, handlers, runJob, setAiModelForTests } from '@ams/core';
import type { JobEnvelope, JobType } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { ImportReview } from './components/docs';
import { resetConfirmForTests } from './components/confirm-dialog';
import { UndoToaster } from './components/undo-toaster';
import { createApi } from './lib/api';
import { documentsApi } from './lib/documents-api';
import { settingsApi } from './lib/settings-api';
import { resetUndoForTests } from './lib/undo';
import { OrgChartSection } from './pages/settings/org-chart/org-chart-section';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const queued: (JobEnvelope & { type: JobType })[] = [];
const queue = { send: async (type: JobType, e: JobEnvelope) => { queued.push({ ...e, type }); } };
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
type Who = 'admin' | 'viewer';
const fetchAs = (who: Who) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
function page(who: Who) {
  const f = fetchAs(who);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <><OrgChartSection api={settingsApi(createApi(f), f)} docs={documentsApi(createApi(f), f)} canEdit={who !== 'viewer'} onOpenPrograms={() => undefined} /><UndoToaster /></>,
    }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
async function work(types: JobType[]) {
  let n = 0;
  while (n++ < 100) {
    const i = queued.findIndex((q) => types.includes(q.type));
    if (i < 0) break;
    const [{ type, ...env }] = queued.splice(i, 1) as [JobEnvelope & { type: JobType }];
    await runJob(pool, type, env, handlers, { store, queue });
  }
}
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
const filler = 'This page is part of the chart of the university and shows its units and their heads.';

/** The fake reading model: one unit per "[level] English | head Name | type key" line of the outline, citing the line. */
function responder() {
  return (options: unknown): object => {
    const prompt = (options as { prompt?: { role: string; content: unknown }[] }).prompt ?? [];
    const user = prompt.filter((m) => m.role === 'user').map((m) => (Array.isArray(m.content) ? m.content.map((c) => (c as { text?: string }).text ?? '').join('') : String(m.content))).join('\n');
    const items: object[] = [];
    const parts = user.split(/=== Page (\d+) ===/);
    for (let i = 1; i < parts.length; i += 2) {
      const stack: { level: number; name: string }[] = [];
      for (const m of parts[i + 1]!.matchAll(/^\[(\d)\] (.+?)[ \t]*$/gm)) {
        const level = Number(m[1]);
        while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
        const [name, ...cols] = m[2]!.split(' | ');
        const col = (p: string) => cols.find((c) => c.startsWith(`${p} `))?.slice(p.length + 1) ?? null;
        items.push({
          item: { nameEn: name, type: col('type'), headName: col('head'), parentName: stack[stack.length - 1]?.name ?? null, boxText: m[0] },
          source: { page: Number(parts[i]), quote: m[0] }, confidence: 0.9, flags: [],
        });
        stack.push({ level, name: name! });
      }
    }
    return { items };
  };
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('weborgchartdocs');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store, queue,
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [who, role, name] of [['admin', 'admin', 'Ada Admin'], ['viewer', 'viewer', 'Vera Viewer']] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $3) returning id`, [ids.inst, name, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[who], role]);
  }
  await one(`insert into org_unit (institution_id, type, name_en, edited_by_person) values ($1, 'college', 'Engineering', true) returning id`, [ids.inst]);
}, 60000);
beforeEach(() => { resetUndoForTests(); resetConfirmForTests(); });
afterEach(() => { cleanup(); setAiModelForTests(null); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('Org chart -> Docs', () => {
  it('uploads a chart, imports units, reviews them, applies them as one undoable change and shows them in the chart', async () => {
    const user = userEvent.setup({ applyAccept: false });
    setAiModelForTests(createFakeAiModel([responder()]).model);
    render(page('admin'));
    await user.click(await screen.findByRole('tab', { name: 'Docs' }));
    const tab = await screen.findByRole('region', { name: 'Docs' });
    const chart = `[1] Board of Trustees\n[2] Faculty of Health | head Dr Hana | type college\n[3] Nursing Department | type department\n[2] Engineering\n${filler}`;
    await user.upload(await within(tab).findByLabelText('Files to upload'), new File([pdf([chart]) as unknown as BlobPart], 'chart.pdf', { type: 'application/pdf' }));
    await screen.findByRole('article', { name: 'chart.pdf' });
    await work(['extract_text']);
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'chart.pdf' })).getByRole('status').textContent).toBe('Read'));

    await user.click(screen.getByRole('button', { name: 'Import org chart' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Start import' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(dialog).getByRole('button', { name: 'Start import' }));
    await screen.findByRole('status', { name: 'Import progress' });
    await work(['import']);
    const history = await screen.findByRole('list', { name: 'Import history' });
    await waitFor(() => expect(within(history).getByTestId('import-run').textContent).toContain('Finished'));
    await user.click(within(history).getByRole('button', { name: /Review/ }));

    const review = await screen.findByRole('region', { name: 'Review proposals' });
    const table = await within(review).findByRole('table', { name: 'Proposals' });
    const rows = within(table).getAllByTestId('proposal');
    expect(rows).toHaveLength(4);
    // A cell for every field, editable with its own direction; the unit without a parent says so.
    const board = rows.find((r) => within(r).queryByDisplayValue('Board of Trustees'))!;
    expect(board.textContent).toMatch(/No parent box was found/);
    const health = rows.find((r) => within(r).queryByDisplayValue('Faculty of Health'))!;
    const head = within(health).getByLabelText(/^Head name of /) as HTMLInputElement;
    expect(head.getAttribute('dir')).toBe('auto');
    expect(head.value).toBe('Dr Hana');
    // A name is corrected in the review before it is applied.
    const nursing = rows.find((r) => within(r).queryByDisplayValue('Nursing Department'))!;
    const nameCell = within(nursing).getByLabelText(/^Name en of /) as HTMLInputElement;
    await user.clear(nameCell);
    await user.type(nameCell, 'School of Nursing');
    await user.tab();
    await waitFor(() => expect(within(nursing).getByText('Edited')).toBeTruthy());

    await user.click(within(review).getByRole('checkbox', { name: 'Select all' }));
    await user.click(within(review).getByRole('button', { name: 'Accept selected' }));
    await user.click(await within(review).findByRole('button', { name: /^Apply \d+$/ }));
    const confirmation = await screen.findByRole('dialog');
    await user.click(within(confirmation).getByRole('button', { name: /^Apply \d+$/ }));
    const result = await within(review).findByTestId('apply-result');
    expect(result.textContent).toMatch(/Applied 3/);
    // "Engineering" was already in the org chart and a person edited it: left alone, and the reason is shown.
    expect(within(result).getByLabelText('Left alone').textContent).toMatch(/Engineering.*a person edited it/);
    const units = (await db.su.query(`select u.name_en, u.source, u.created_by, p.name_en parent from org_unit u left join org_unit p on p.id = u.parent_id order by u.name_en`)).rows;
    expect(units.map((u) => [u.name_en, u.parent])).toEqual([['Board of Trustees', null], ['Engineering', null], ['Faculty of Health', 'Board of Trustees'], ['School of Nursing', 'Faculty of Health']]);
    expect(units.filter((u) => u.source === 'image').every((u) => u.created_by === ids.admin)).toBe(true);

    await user.click(within(result).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByTestId('apply-result').textContent).toMatch(/^Undone: Applied/));
    expect((await db.su.query(`select name_en from org_unit order by name_en`)).rows.map((r) => r.name_en)).toEqual(['Engineering']);
    await user.click(within(screen.getByTestId('apply-result')).getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(screen.getByTestId('apply-result').textContent).toMatch(/^Applied/));
    expect((await db.su.query(`select count(*)::int n from org_unit`)).rows[0].n).toBe(4);

    // Back to the chart: the new units are there.
    await user.click(screen.getByRole('tab', { name: 'Chart' }));
    expect(await screen.findByLabelText('Open Faculty of Health')).toBeTruthy();
  }, 120000);

  it('shows a person who may not edit the org chart the documents, with no upload and no Import', async () => {
    render(page('viewer'));
    await userEvent.setup().click(await screen.findByRole('tab', { name: 'Docs' }));
    const tab = await screen.findByRole('region', { name: 'Docs' });
    await within(tab).findByRole('article', { name: 'chart.pdf' });
    expect(within(tab).queryByRole('group', { name: 'Upload documents' })).toBeNull();
    expect(within(tab).queryByRole('button', { name: 'Import org chart' })).toBeNull();
  });
});

describe('the review of an image', () => {
  const proposal = {
    id: 'p1', runId: 'r1', targetKind: 'org_chart', seq: 1, label: 'Faculty of Health', payload: {}, editedPayload: null, effective: { nameEn: 'Faculty of Health', parentName: null },
    documentId: 'd1', pageNo: 1, quote: '[1] Faculty of Health', quoteVerified: false, confidence: 0.4, flags: ['The AI was not sure about this one.'], status: 'pending', appliedRef: null,
  };
  const stub = (documentName: string) => ({
    proposals: async () => ({ run: { id: 'r1', targetLabel: 'Org chart', status: 'succeeded', usage: { inputTokens: 0, outputTokens: 0, costUsd: null, calls: 0 }, error: null, counts: {} }, proposals: [{ ...proposal, documentName }] }),
    pageView: async () => ({ document: { id: 'd1', title: documentName, hasFile: true, mime: 'image/png' }, pageNos: [1], page: { pageNo: 1, text: '[1] Faculty of Health', needsOcr: false }, highlight: null, quoteGiven: true, quoteFoundOnPage: null }),
    fileUrl: (id: string) => `/api/documents/${id}/file`,
  }) as unknown as ReturnType<typeof documentsApi>;
  const show = (documentName: string) => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ImportReview api={stub(documentName)} runId="r1" canWrite onBack={() => undefined} /></QueryClientProvider>,
  );

  it('shows the picture beside the proposals, and the flags that ask for a closer look', async () => {
    show('chart.png');
    const img = (await screen.findByTestId('source-image')).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/documents/d1/file');
    expect(img.getAttribute('alt')).toContain('chart.png');
    expect(screen.getByRole('list', { name: 'To look at for Faculty of Health' }).textContent).toMatch(/not sure/);
  });

  it('shows no picture for a PDF', async () => {
    show('chart.pdf');
    await screen.findByRole('table', { name: 'Proposals' });
    expect(screen.queryByTestId('source-image')).toBeNull();
  });
});
