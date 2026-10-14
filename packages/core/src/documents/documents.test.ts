// Documents of a Docs tab (TASK-075): the registry of uploads, permissions per scope kind, the standards adapter, the Trash, and the
// rule that evidence is never listed.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobEnvelope, JobType } from '@ams/shared';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Ctx, type JobQueue } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { addFileVersion, createEvidence } from '../evidence/evidence.js';
import { handlers } from '../jobs/handlers.js';
import { runJob } from '../jobs/run.js';
import { pdf } from '../framework/parse-fixtures.js';
import { addSourceDocument, MAX_SOURCE_BYTES } from '../framework/sources.js';
import { newVersionFrom } from '../framework/versions.js';
import { deleteForever, listTrash, restoreTrash } from '../trash/index.js';
import {
  deleteDocument, getDocument, getDocumentPageView, getScopeInfo, listAllDocuments, listDocumentPages, listDocuments, readDocumentFile, requestRead, uploadDocument,
} from './documents.js';

let w: World;
const sent: (JobEnvelope & { type: JobType })[] = [];
const queue: JobQueue = { send: async (type, e) => { sent.push({ ...e, type }); } };
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); } }));
async function drain() {
  while (sent.length) {
    const { type, ...env } = sent.shift()!;
    await runJob(w.pool, type, env, handlers, { store: w.store, queue });
  }
}
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;
const catalogue = (n = 1) => pdf(Array.from({ length: n }, (_, i) => `Unit: College of Arts ${i} (college)\nThis page lists the units of the university and describes each of them at some length.`));
const upload = (who: string, over: Partial<Parameters<typeof uploadDocument>[1]> = {}) =>
  as(who, (c) => uploadDocument(c, { scopeKind: 'org_chart', scopeId: null, fileName: 'units.pdf', mime: 'application/pdf', bytes: catalogue(), ...over }));
const ids: Record<string, string> = {};

beforeAll(async () => {
  w = await buildWorld('documents');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
}, 120000);
afterAll(() => w.close());

describe('the registry of uploads', () => {
  it('needs the scope\'s write permission to upload and its read permission to see', async () => {
    await expect(upload('contrib')).rejects.toThrow(ForbiddenError); // contributors read the org chart but cannot change it
    await expect(as('outsider', (c) => listDocuments(c, 'org_chart', null))).rejects.toThrow(ForbiddenError);
    await expect(as('contrib', (c) => listDocuments(c, 'org_chart', null))).resolves.toEqual([]);
    await expect(as('contrib', (c) => listDocuments(c, 'glossary', null))).resolves.toEqual([]);
    await expect(upload('contrib', { scopeKind: 'programs' })).rejects.toThrow(ForbiddenError);
    await expect(as('alo', (c) => listDocuments(c, 'nonsense', null))).rejects.toThrow(NotFoundError);
    expect(sent).toHaveLength(0);
  });

  it('stores the file, records who and when, and queues the reading', async () => {
    const row = await upload('alo');
    ids.doc = row.id;
    expect(row).toMatchObject({
      source: 'import', scopeKind: 'org_chart', scopeId: null, name: 'units.pdf', fileKind: 'PDF', mime: 'application/pdf', status: 'queued', hasFile: true,
      uploadedBy: w.ids.alo, uploadedByName: 'alo', language: 'en',
    });
    expect(row.size).toBeGreaterThan(100);
    const [{ file_path: key, sha256 }] = await q(`select file_path, sha256 from import_document where id = $1`, [row.id]);
    expect(key).toContain(`${w.ids.inst}/documents/org_chart/${row.id}/units.pdf`);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.store.objects.has(key)).toBe(true);
    expect(sent.map((s) => s.type)).toEqual(['extract_text']);
    const [{ payload }] = await q(`select payload from job order by created_at desc limit 1`);
    expect(payload).toEqual({ importDocumentId: row.id });
  });

  it('refuses the same file twice in one place, an empty file, a file of a kind it cannot read, and a file that is too large', async () => {
    await expect(upload('alo')).rejects.toMatchObject({ message: expect.stringContaining('already here as "units.pdf"') });
    await expect(upload('alo', { fileName: 'again.pdf' })).rejects.toThrow(ConflictError); // same bytes, other name
    await expect(upload('alo', { fileName: 'empty.pdf', bytes: new Uint8Array() })).rejects.toThrow(ValidationError);
    await expect(upload('alo', { fileName: 'notes.txt', mime: 'text/plain', bytes: new TextEncoder().encode('x') })).rejects.toThrow(/cannot be read/);
    await expect(upload('alo', { fileName: 'huge.pdf', bytes: new Uint8Array(MAX_SOURCE_BYTES + 1) })).rejects.toThrow(/larger than/);
    // The same bytes in another place are fine.
    await expect(upload('alo', { scopeKind: 'glossary' })).resolves.toMatchObject({ scopeKind: 'glossary' });
    expect(await as('alo', (c) => listDocuments(c, 'org_chart', null))).toHaveLength(1);
  });

  it('reads the file in the parser job: pages, page count and status', async () => {
    sent.length = 0;
    await as('alo', (c) => requestRead(c, ids.doc!)); // read again, as the button does
    await drain();
    const row = await as('contrib', (c) => getDocument(c, ids.doc!));
    expect(row).toMatchObject({ status: 'read', pageCount: 1, needsOcrPages: 0, readError: null });
    expect(row.statusText).toBe('Read: 1 page');
    const pages = await as('contrib', (c) => listDocumentPages(c, ids.doc!));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.text).toContain('College of Arts');
    const view = await as('contrib', (c) => getDocumentPageView(c, ids.doc!, 1, 'Unit: College of Arts 0 (college)'));
    expect(view.page?.pageNo).toBe(1);
    expect(view.highlight).not.toBeNull();
    const file = await as('contrib', (c) => readDocumentFile(c, ids.doc!));
    expect(file).toMatchObject({ mime: 'application/pdf', fileName: 'units.pdf' });
  }, 60000);

  it('records a file that cannot be read as failed, with the reason', async () => {
    const bad = new TextEncoder().encode('%PDF-1.4 this is not really a pdf at all');
    const row = await upload('alo', { fileName: 'broken.pdf', bytes: bad });
    await drain();
    const after = await as('alo', (c) => getDocument(c, row.id));
    expect(after.status).toBe('failed');
    expect(after.readError).toBeTruthy();
    expect(after.statusText).toMatch(/^Could not be read/);
  }, 60000);

  it('lists with the newest first and gives a place the person can write in', async () => {
    const list = await as('alo', (c) => listDocuments(c, 'org_chart', null));
    expect(list.map((d) => d.name)).toEqual(['broken.pdf', 'units.pdf']);
    expect(await as('alo', (c) => getScopeInfo(c, 'org_chart', null))).toMatchObject({ canRead: true, canWrite: true, editable: true, label: 'Org chart' });
    expect(await as('contrib', (c) => getScopeInfo(c, 'org_chart', null))).toMatchObject({ canRead: true, canWrite: false });
  });
});

describe('delete goes to the Trash', () => {
  it('keeps the file and the pages for restoring, and Undo brings it back', async () => {
    const [{ file_path: key }] = await q(`select file_path from import_document where id = $1`, [ids.doc]);
    await expect(as('contrib', (c) => deleteDocument(c, ids.doc!))).rejects.toThrow(ForbiddenError);
    const res = await as('alo', (c) => deleteDocument(c, ids.doc!));
    expect(res.counts).toMatchObject({ items: 1, pages: 1 });
    expect(await as('alo', (c) => listDocuments(c, 'org_chart', null))).toHaveLength(1); // only broken.pdf is left
    expect((await q(`select count(*)::int n from import_page where import_document_id = $1`, [ids.doc]))[0].n).toBe(0);
    expect(w.store.objects.has(key)).toBe(true);
    const trash = await as('alo', (c) => listTrash(c));
    expect(trash.groups.find((g) => g.groupId === res.groupId)?.items[0]).toMatchObject({ kind: 'import_document', label: 'units.pdf', context: 'Org chart' });
    const back = await as('alo', (c) => restoreTrash(c, { groupId: res.groupId }));
    expect(back.restored).toMatchObject({ documents: 1, pages: 1 });
    const again = await as('alo', (c) => getDocument(c, ids.doc!));
    expect(again).toMatchObject({ name: 'units.pdf', status: 'read', uploadedByName: 'alo' });
  });

  it('removes the stored file only when it leaves the Trash for good', async () => {
    const [{ file_path: key }] = await q(`select file_path from import_document where id = $1`, [ids.doc]);
    const res = await as('alo', (c) => deleteDocument(c, ids.doc!));
    await as('alo', (c) => deleteForever(c, { groupId: res.groupId }));
    expect(w.store.objects.has(key)).toBe(false);
    await expect(as('alo', (c) => getDocument(c, ids.doc!))).rejects.toThrow(NotFoundError);
  });

  it('puts nothing back for a person who may not write there', async () => {
    const row = await upload('alo', { fileName: 'second.pdf', bytes: catalogue(2) });
    const res = await as('alo', (c) => deleteDocument(c, row.id));
    await expect(as('contrib', (c) => restoreTrash(c, { groupId: res.groupId }))).rejects.toThrow();
  });
});

describe('the standards adapter', () => {
  it('lists a version\'s source documents in the same row shape, and the actions delegate to the source services', async () => {
    const draft = (await as('admin', (c) => newVersionFrom(c, w.ids.wscuc!, { edition: '2031' }))).version.id;
    const doc = await as('alo', (c) => addSourceDocument(c, { versionId: draft, title: 'Handbook', role: 'standards', authority: 'binding' }));
    const row = await as('alo', (c) => uploadDocument(c, { scopeKind: 'framework_version', scopeId: draft, fileName: 'council.pdf', mime: 'application/pdf', bytes: catalogue(3) }));
    expect(row).toMatchObject({ source: 'source', scopeKind: 'framework_version', scopeId: draft, name: 'council', fileName: 'council.pdf', fileKind: 'PDF', status: 'queued', uploadedByName: 'alo', role: null, roleOrigin: 'unset' });
    await drain();
    const list = await as('contrib', (c) => listDocuments(c, 'framework_version', draft));
    expect(list.map((d) => d.name).sort()).toEqual(['Handbook', 'council']);
    const read = list.find((d) => d.name === 'council')!;
    expect(read).toMatchObject({ source: 'source', status: 'read', pageCount: 3, hasFile: true });
    const typed = list.find((d) => d.id === doc.id)!;
    expect(typed).toMatchObject({ status: 'not_read', hasFile: false });
    expect((await as('contrib', (c) => listDocumentPages(c, read.id))).length).toBe(3);
    expect(await as('contrib', (c) => getScopeInfo(c, 'framework_version', draft))).toMatchObject({ canRead: true, canWrite: false, editable: true });
    // Uploading the same file again, reading again and deleting go through the existing services.
    await expect(as('alo', (c) => uploadDocument(c, { scopeKind: 'framework_version', scopeId: draft, fileName: 'other-name.pdf', mime: 'application/pdf', bytes: catalogue(3) }))).rejects.toThrow(/already here/);
    await as('alo', (c) => requestRead(c, read.id));
    expect(sent.map((s) => s.type)).toEqual(['extract_text']);
    sent.length = 0;
    const del = await as('alo', (c) => deleteDocument(c, read.id));
    const trash = await as('alo', (c) => listTrash(c));
    expect(trash.groups.find((g) => g.groupId === del.groupId)?.items[0]).toMatchObject({ kind: 'source_document' });
    expect((await as('alo', (c) => listDocuments(c, 'framework_version', draft))).map((d) => d.name)).toEqual(['Handbook']);
    ids.draft = draft;
  }, 60000);

  it('refuses uploads and deletes to a version that is no longer a draft', async () => {
    await w.db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ids.draft]);
    await expect(as('alo', (c) => uploadDocument(c, { scopeKind: 'framework_version', scopeId: ids.draft!, fileName: 'late.pdf', mime: 'application/pdf', bytes: catalogue(4) }))).rejects.toThrow(/fixed with it/);
    expect(await as('alo', (c) => getScopeInfo(c, 'framework_version', ids.draft!))).toMatchObject({ editable: false });
    await w.db.su.query(`update framework_version set status = 'draft' where id = $1`, [ids.draft]);
  });
});

describe('the Documents area', () => {
  it('lists what the person may see across places, with who, when and where it is used, and filters it', async () => {
    await upload('alo', { fileName: 'third.pdf', bytes: catalogue(5) });
    const all = await as('alo', (c) => listAllDocuments(c));
    const names = all.items.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['units.pdf', 'broken.pdf', 'third.pdf', 'Handbook']));
    const units = all.items.find((d) => d.name === 'third.pdf')!;
    expect(units.place).toEqual({ label: 'Org chart', href: expect.stringContaining('/settings/organization') });
    expect(all.items.find((d) => d.name === 'Handbook')!.place.href).toBe(`/settings/versions/${ids.draft}?tab=docs`);
    expect(all.places.length).toBeGreaterThanOrEqual(3);
    expect(all.uploaders).toContainEqual({ id: w.ids.alo, name: 'alo' });
    expect(all.fileKinds).toContain('PDF');

    const byPlace = await as('alo', (c) => listAllDocuments(c, { place: 'org_chart' }));
    expect(byPlace.items.every((d) => d.scopeKind === 'org_chart')).toBe(true);
    expect((await as('alo', (c) => listAllDocuments(c, { place: `framework_version:${ids.draft}` }))).items.map((d) => d.name)).toEqual(['Handbook']);
    expect((await as('alo', (c) => listAllDocuments(c, { status: 'failed' }))).items.map((d) => d.name)).toEqual(['broken.pdf']);
    expect((await as('alo', (c) => listAllDocuments(c, { q: 'THIRD' }))).items.map((d) => d.name)).toEqual(['third.pdf']);
    expect((await as('alo', (c) => listAllDocuments(c, { uploadedBy: w.ids.contrib! }))).items).toEqual([]);
    expect((await as('alo', (c) => listAllDocuments(c, { fileKind: 'Word' }))).items).toEqual([]);
    const today = new Date().toISOString().slice(0, 10);
    expect((await as('alo', (c) => listAllDocuments(c, { from: today, to: today }))).total).toBe(all.total);
    expect((await as('alo', (c) => listAllDocuments(c, { to: '2000-01-01' }))).total).toBe(0);
  });

  it('shows a person only the places they may read, and nobody without a role anything', async () => {
    const contrib = await as('contrib', (c) => listAllDocuments(c));
    expect(contrib.items.length).toBe((await as('alo', (c) => listAllDocuments(c))).items.length); // contributors read org chart, glossary and standards
    const none = await as('outsider', (c) => listAllDocuments(c));
    expect(none).toMatchObject({ items: [], total: 0 });
  });

  it('never lists evidence, whatever its file is called', async () => {
    const item = await as('alo', (c) => createEvidence(c, { title: 'Board minutes 2025', type: 'document' }));
    await as('alo', (c) => addFileVersion(c, item.id, { fileName: 'minutes-secret.pdf', mime: 'application/pdf', bytes: catalogue(1) }));
    const all = await as('alo', (c) => listAllDocuments(c, { q: 'minutes' }));
    expect(all.items).toEqual([]);
    expect((await as('alo', (c) => listAllDocuments(c))).items.some((d) => d.name.includes('minutes'))).toBe(false);
    // And no document service can reach the evidence tables: this module imports nothing from them.
    const dir = import.meta.dirname;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/from\s+['"][^'"]*evidence[^'"]*['"]/);
      expect(src, f).not.toMatch(/\bevidence(Item|Version|Link)\b/);
    }
  });
});
