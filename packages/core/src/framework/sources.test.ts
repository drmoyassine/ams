// A version's sources: added, described, given their original file and page text while the version is a draft; a source
// a note cites cannot be removed; a published version's sources do not change.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { addNote } from './notes.js';
import { listRequirements } from './requirements.js';
import {
  addSourceDocument, deleteSourceDocument, deleteSourcePage, listSourceDocuments, listSourcePages, readSourceFile, setSourcePage, updateSourceDocument, uploadSourceFile,
} from './sources.js';
import { newVersionFrom } from './versions.js';

let w: World;
const ids: Record<string, string> = {};
const PDF = new TextEncoder().encode('%PDF-1.7 criteria');

beforeAll(async () => {
  w = await buildWorld('sourcesvc');
  ids.draft = (await w.as('admin', (c) => newVersionFrom(c, w.ids.wscuc!, { edition: '2028' }))).version.id;
}, 120000);
afterAll(() => w.close());

describe('sources', () => {
  it('adds a source without a file, describes it, and gives it its original', async () => {
    await expect(w.as('contrib', (c) => addSourceDocument(c, { versionId: ids.draft!, title: 'x', role: 'guidance', authority: 'informational' }))).rejects.toThrow(ForbiddenError);
    const doc = await w.as('alo', (c) => addSourceDocument(c, { versionId: ids.draft!, title: 'Handbook 2028', role: 'standards', authority: 'binding' }));
    ids.doc = doc.id;
    expect(doc.fileName).toBeNull();
    const renamed = await w.as('alo', (c) => updateSourceDocument(c, doc.id, { title: 'Handbook of Accreditation 2028', role: 'policy_procedure' }));
    expect(renamed).toMatchObject({ title: 'Handbook of Accreditation 2028', role: 'policy_procedure', authority: 'binding' });
    await expect(w.as('alo', (c) => readSourceFile(c, doc.id))).rejects.toThrow(/no file/);
    const up = await w.as('alo', (c) => uploadSourceFile(c, doc.id, { fileName: 'handbook.pdf', mime: 'application/pdf', bytes: PDF }));
    expect(up).toMatchObject({ fileName: 'handbook.pdf', mime: 'application/pdf', size: PDF.byteLength });
    const f = await w.as('contrib', (c) => readSourceFile(c, doc.id));
    expect(new TextDecoder().decode(f.bytes)).toBe('%PDF-1.7 criteria');
  });

  it('sets, corrects and removes page text, and counts the pages', async () => {
    await w.as('alo', (c) => setSourcePage(c, ids.doc!, 2, 'Institutions publish their mission.'));
    await w.as('alo', (c) => setSourcePage(c, ids.doc!, 1, 'Introduction'));
    await w.as('alo', (c) => setSourcePage(c, ids.doc!, 2, 'Institutions publish their mission statement.'));
    await expect(w.as('alo', (c) => setSourcePage(c, ids.doc!, 3, '  '))).rejects.toThrow(ValidationError);
    expect((await w.as('contrib', (c) => listSourcePages(c, ids.doc!))).map((p) => [p.pageNo, p.text])).toEqual([[1, 'Introduction'], [2, 'Institutions publish their mission statement.']]);
    const listed = (await w.as('contrib', (c) => listSourceDocuments(c, ids.draft!))).find((d) => d.id === ids.doc)!;
    expect(listed).toMatchObject({ storedPages: 2, hasFile: true });
    await w.as('alo', (c) => deleteSourcePage(c, ids.doc!, 1));
    expect((await w.as('contrib', (c) => listSourcePages(c, ids.doc!))).map((p) => p.pageNo)).toEqual([2]);
  });

  it('keeps a source a note quotes, and its quoted page', async () => {
    const req = (await w.as('alo', (c) => listRequirements(c, ids.draft!)))[0]!;
    await w.as('alo', (c) => addNote(c, { requirementId: req.id, type: 'guidance', text: 'Publish it', authority: 'required', source: { documentId: ids.doc!, page: 2, quote: 'publish their mission statement' } }));
    await expect(w.as('alo', (c) => deleteSourcePage(c, ids.doc!, 2))).rejects.toThrow(ConflictError);
    await expect(w.as('alo', (c) => deleteSourceDocument(c, ids.doc!))).rejects.toThrow(/cites this source/);
    const spare = await w.as('alo', (c) => addSourceDocument(c, { versionId: ids.draft!, title: 'Old memo', role: 'other', authority: 'informational' }));
    await w.as('alo', (c) => setSourcePage(c, spare.id, 1, 'memo'));
    await w.as('alo', (c) => deleteSourceDocument(c, spare.id));
    expect((await w.as('alo', (c) => listSourceDocuments(c, ids.draft!))).map((d) => d.id)).not.toContain(spare.id);
  });

  it('does not change the sources of a published version', async () => {
    const published = (await w.as('alo', (c) => listSourceDocuments(c, w.ids.wscuc!)))[0]!;
    await expect(w.as('alo', (c) => updateSourceDocument(c, published.id, { title: 'x' }))).rejects.toThrow(ConflictError);
    await expect(w.as('alo', (c) => uploadSourceFile(c, published.id, { fileName: 'x.pdf', mime: 'application/pdf', bytes: PDF }))).rejects.toThrow(ConflictError);
    await expect(w.as('alo', (c) => setSourcePage(c, published.id, 99, 'x'))).rejects.toThrow(ConflictError);
  });
});
