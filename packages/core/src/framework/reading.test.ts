// Reading a source's file into pages: queued by a person, done by the worker's extract_text handler as that person.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobEnvelope } from '@ams/shared';
import { ConflictError, ForbiddenError, type Ctx } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createFakeAiModel, setAiModelForTests } from '../ai/index.js';
import { handlers } from '../jobs/handlers.js';
import { runJob } from '../jobs/run.js';
import { pdf } from './parse-fixtures.js';
import { requestTextExtraction } from './reading.js';
import { addSourceDocument, listSourceDocuments, listSourcePages, setSourcePage, uploadSourceFile } from './sources.js';
import { newVersionFrom } from './versions.js';

let w: World;
const ids: Record<string, string> = {};
const sent: JobEnvelope[] = [];
const text = 'Institutions must publish their mission statement and review it every year with the board. ';

/** Runs a service as a person, with a queue that remembers what was sent. */
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w.as(who, (c) => fn({ ...c, queue: { send: async (_t, e) => { sent.push(e); } }, afterCommit: (f) => { void f(); } }));
/** Lets the worker run the oldest queued job, as pg-boss would. */
const work = (store = w.store) => runJob(w.pool, 'extract_text', sent.shift(), handlers, { store });
const doc = async () => (await as('alo', (c) => listSourceDocuments(c, ids.draft!))).find((d) => d.id === ids.doc)!;

beforeAll(async () => {
  w = await buildWorld('reading');
  ids.draft = (await as('admin', (c) => newVersionFrom(c, w.ids.wscuc!, { edition: '2029' }))).version.id;
  ids.doc = (await as('alo', (c) => addSourceDocument(c, { versionId: ids.draft!, title: 'Handbook', role: 'standards', authority: 'binding' }))).id;
}, 120000);
afterAll(() => w.close());

describe('extract_text', () => {
  it('needs a file, a type it can read, and permission to write', async () => {
    await expect(as('alo', (c) => requestTextExtraction(c, ids.doc!))).rejects.toThrow(/upload the file first/);
    await as('alo', (c) => uploadSourceFile(c, ids.doc!, { fileName: 'notes.txt', mime: 'text/plain', bytes: new TextEncoder().encode('x') }));
    await expect(as('alo', (c) => requestTextExtraction(c, ids.doc!))).rejects.toThrow(ConflictError);
    await as('alo', (c) => uploadSourceFile(c, ids.doc!, { fileName: 'handbook.pdf', mime: 'application/pdf', bytes: pdf([text, null, text + 'More.']) }));
    await expect(as('contrib', (c) => requestTextExtraction(c, ids.doc!))).rejects.toThrow(ForbiddenError);
    expect(sent).toHaveLength(0);
  });

  it('queues, then the worker stores each page, flags the one without text, and records counts in the job result', async () => {
    const q = await as('alo', (c) => requestTextExtraction(c, ids.doc!));
    expect(q.textStatus).toBe('queued');
    expect(await doc()).toMatchObject({ textStatus: 'queued' });
    await work();
    const pages = await as('alo', (c) => listSourcePages(c, ids.doc!));
    expect(pages.map((p) => [p.pageNo, p.needsOcr, p.fromFile, p.method])).toEqual([[1, false, true, 'pdf_text'], [2, true, true, 'pdf_text'], [3, false, true, 'pdf_text']]);
    expect(pages[0]!.text).toContain('Institutions must publish');
    expect(await doc()).toMatchObject({ textStatus: 'ocr_needed', pageCount: 3, storedPages: 3, needsOcrPages: 1 });
    const { rows } = await w.db.su.query(`select status, result from job where id = $1`, [q.jobId]);
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].result).toMatchObject({ ok: true, format: 'pdf', pages: 3, written: 3, keptPages: 0, needsOcr: 1 });
  }, 60000);

  it('reads again without replacing a page a person corrected', async () => {
    await as('alo', (c) => setSourcePage(c, ids.doc!, 2, 'Typed in from the scan.'));
    await as('alo', (c) => uploadSourceFile(c, ids.doc!, { fileName: 'handbook.pdf', mime: 'application/pdf', bytes: pdf(['Revised first page of the handbook, now with plenty of text to read.', null, text]) }));
    const q = await as('alo', (c) => requestTextExtraction(c, ids.doc!));
    await work();
    const pages = await as('alo', (c) => listSourcePages(c, ids.doc!));
    expect(pages[0]!.text).toContain('Revised first page');
    expect(pages[1]).toMatchObject({ text: 'Typed in from the scan.', needsOcr: false, fromFile: false });
    expect(await doc()).toMatchObject({ textStatus: 'extracted', needsOcrPages: 0 });
    const { rows } = await w.db.su.query(`select result from job where id = $1`, [q.jobId]);
    expect(rows[0].result).toMatchObject({ ok: true, written: 2, keptPages: 1 });
    // A reviewed page is kept too, even if it came from a file.
    await w.db.su.query(`update source_page set reviewed = true where source_document_id = $1 and page_no = 1`, [ids.doc]);
    await as('alo', (c) => requestTextExtraction(c, ids.doc!));
    await work();
    expect((await w.db.su.query(`select result from job order by created_at desc limit 1`)).rows[0].result).toMatchObject({ written: 1, keptPages: 2 });
  }, 60000);

  it('reads sheets, slides and tables of other formats into pages with their method', async () => {
    const csv = await as('alo', (c) => addSourceDocument(c, { versionId: ids.draft!, title: 'Programs', role: 'other', authority: 'informational' }));
    await as('alo', (c) => uploadSourceFile(c, csv.id, { fileName: 'programs.csv', mime: 'text/csv', bytes: new TextEncoder().encode('id,name\n1,Mechanical\n2,Civil\n') }));
    await as('alo', (c) => requestTextExtraction(c, csv.id));
    await work();
    const pages = await as('alo', (c) => listSourcePages(c, csv.id));
    expect(pages.map((p) => [p.method, p.text.replace(/[ \t]+/g, ' ')])).toEqual([['table', 'id name\n1 Mechanical\n2 Civil']]);
    expect((await as('alo', (c) => listSourceDocuments(c, ids.draft!))).find((d) => d.id === csv.id)).toMatchObject({ textStatus: 'extracted' });
  }, 60000);

  it('marks a file it cannot read as failed, with the reason, instead of retrying', async () => {
    const bad = await as('alo', (c) => addSourceDocument(c, { versionId: ids.draft!, title: 'Broken', role: 'other', authority: 'informational' }));
    await as('alo', (c) => uploadSourceFile(c, bad.id, { fileName: 'broken.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: new TextEncoder().encode('not a zip') }));
    const q = await as('alo', (c) => requestTextExtraction(c, bad.id));
    await work();
    expect((await as('alo', (c) => listSourceDocuments(c, ids.draft!))).find((d) => d.id === bad.id)).toMatchObject({ textStatus: 'failed' });
    const { rows } = await w.db.su.query(`select status, result from job where id = $1`, [q.jobId]);
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].result).toMatchObject({ ok: false, error: expect.stringMatching(/DOCX file could not be read/) });
  }, 60000);
});

describe('extract_text with Settings -> AI', () => {
  afterEach(() => setAiModelForTests(null));
  const scanned = async (title: string) => {
    const d = await as('alo', (c) => addSourceDocument(c, { versionId: ids.draft!, title, role: 'other', authority: 'informational' }));
    await as('alo', (c) => uploadSourceFile(c, d.id, { fileName: 'scan.pdf', mime: 'application/pdf', bytes: pdf([text, null]) }));
    const q = await as('alo', (c) => requestTextExtraction(c, d.id));
    return { id: d.id, jobId: q.jobId };
  };

  it('reads a scanned page with aiOcr, counts it in the job result, and keeps the others as they were', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fake = createFakeAiModel(['Text read from the scan of page two.'], { inputTokens: 500, outputTokens: 20 });
    setAiModelForTests(fake.model);
    const d = await scanned('Scan on');
    await work();
    const pages = await as('alo', (c) => listSourcePages(c, d.id));
    expect(pages.map((p) => [p.pageNo, p.method, p.needsOcr])).toEqual([[1, 'pdf_text', false], [2, 'ocr', false]]);
    expect(pages[1]!.text).toBe('Text read from the scan of page two.');
    expect(fake.calls).toHaveLength(1);
    const { rows } = await w.db.su.query(`select result from job where id = $1`, [d.jobId]);
    expect(rows[0].result.ai).toEqual([expect.objectContaining({ task: 'ocr', promptVersion: 'v1', inputTokens: 500, outputTokens: 20, ok: true })]);
  }, 60000);

  it('leaves pages flagged needsOcr when AI is switched off', async () => {
    const fake = createFakeAiModel(['should not be used']);
    setAiModelForTests(fake.model);
    await w.db.su.query(`insert into ai_setting (institution_id, model, enabled) values ($1, 'm', false)`, [w.ids.inst]);
    const d = await scanned('Scan off');
    await work();
    const pages = await as('alo', (c) => listSourcePages(c, d.id));
    expect(pages.map((p) => [p.pageNo, p.needsOcr])).toEqual([[1, false], [2, true]]);
    expect(fake.calls).toHaveLength(0);
    await w.db.su.query(`delete from ai_setting`);
  }, 60000);

  const scannedMany = async (title: string, pages: number) => {
    const d = await as('alo', (c) => addSourceDocument(c, { versionId: ids.draft!, title, role: 'other', authority: 'informational' }));
    await as('alo', (c) => uploadSourceFile(c, d.id, { fileName: 'scan.pdf', mime: 'application/pdf', bytes: pdf([text, ...Array.from({ length: pages }, () => null)]) }));
    const q = await as('alo', (c) => requestTextExtraction(c, d.id));
    return { id: d.id, jobId: q.jobId };
  };
  const result = async (jobId: string) => (await w.db.su.query(`select result from job where id = $1`, [jobId])).rows[0].result as { warnings: string[]; needsOcr: number; ai?: unknown[] };

  it('"Read scanned pages with AI" off: no model call, pages stay flagged, and the result says why', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fake = createFakeAiModel(['should not be used']);
    setAiModelForTests(fake.model);
    await w.db.su.query(`insert into ai_setting (institution_id, model, enabled, ocr_enabled) values ($1, 'm', true, false)`, [w.ids.inst]);
    const d = await scanned('Scan ocr off');
    await work();
    expect((await as('alo', (c) => listSourcePages(c, d.id))).map((p) => [p.pageNo, p.needsOcr])).toEqual([[1, false], [2, true]]);
    expect(fake.calls).toHaveLength(0);
    expect((await result(d.jobId)).warnings.join(' ')).toMatch(/"Read scanned pages with AI" is off/);
    await w.db.su.query(`delete from ai_setting`);
  }, 60000);

  it('"Max AI-read pages per file" caps the pages sent to the model; the rest stay flagged with a warning', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fake = createFakeAiModel(['Text read from the scan.']);
    setAiModelForTests(fake.model);
    await w.db.su.query(`insert into ai_setting (institution_id, model, enabled, ocr_max_pages) values ($1, 'm', true, 2)`, [w.ids.inst]);
    const d = await scannedMany('Scan capped', 4);
    await work();
    const pages = await as('alo', (c) => listSourcePages(c, d.id));
    expect(pages.map((p) => [p.pageNo, p.method, p.needsOcr])).toEqual([[1, 'pdf_text', false], [2, 'ocr', false], [3, 'ocr', false], [4, 'pdf_text', true], [5, 'pdf_text', true]]);
    expect(fake.calls).toHaveLength(2);
    const r = await result(d.jobId);
    expect(r.needsOcr).toBe(2);
    expect(r.warnings.join(' ')).toMatch(/not read by AI: the limit of 2 AI-read pages per file/);
    await w.db.su.query(`delete from ai_setting`);
  }, 60000);

  it('reads with the reading model of its own account, and the language hint overrides the source language', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const configs: { provider: string; model: string }[] = [];
    const fake = createFakeAiModel(['Text read from the scan.']);
    setAiModelForTests((cfg) => { configs.push(cfg); return fake.model; });
    const acc = (await w.db.su.query(`insert into ai_account (institution_id, name, provider, base_url) values ($1, 'Cheap vision', 'openai_compatible', 'http://vision.invalid/v1') returning id`, [w.ids.inst])).rows[0].id as string;
    await w.db.su.query(`insert into ai_setting (institution_id, model, enabled, vision_account_id, vision_model, ocr_language) values ($1, 'm', true, $2, 'cheap-vision', 'ar')`, [w.ids.inst, acc]);
    const d = await scanned('Scan vision');
    await work();
    expect((await as('alo', (c) => listSourcePages(c, d.id))).map((p) => p.method)).toEqual(['pdf_text', 'ocr']);
    expect(configs[0]).toMatchObject({ provider: 'openai_compatible', model: 'cheap-vision' });
    expect(JSON.stringify(fake.calls[0])).toContain('Language hint: ar');
    expect((await result(d.jobId)).ai).toEqual([expect.objectContaining({ task: 'ocr', provider: 'openai_compatible', model: 'cheap-vision', ok: true })]);
    await w.db.su.query(`delete from ai_setting`);
    await w.db.su.query(`delete from ai_account`);
  }, 60000);

  it('a reading account that cannot be used leaves the pages flagged, with the reason, instead of failing the job', async () => {
    const fake = createFakeAiModel(['should not be used']);
    setAiModelForTests(fake.model);
    const acc = (await w.db.su.query(`insert into ai_account (institution_id, name, provider) values ($1, 'No key', 'google') returning id`, [w.ids.inst])).rows[0].id as string;
    await w.db.su.query(`insert into ai_setting (institution_id, model, enabled, vision_account_id, vision_model) values ($1, 'm', true, $2, 'v')`, [w.ids.inst, acc]);
    const d = await scanned('Scan bad vision');
    await work();
    expect((await as('alo', (c) => listSourcePages(c, d.id))).map((p) => p.needsOcr)).toEqual([false, true]);
    expect(fake.calls).toHaveLength(0);
    expect((await result(d.jobId)).warnings.join(' ')).toMatch(/not read by the AI: AI has no API key/);
    await w.db.su.query(`delete from ai_setting`);
    await w.db.su.query(`delete from ai_account`);
  }, 60000);
});
