import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { docx, pdf, png, pptx, xlsx, zip } from './parse-fixtures.js';
import { detectFormat, DocumentReadError, findLibreOffice, MIN_PAGE_TEXT_CHARS, parseDocument, textLayerLooksCorrupt, UnsupportedDocumentError } from './parse-document.js';

const enc = (s: string) => new TextEncoder().encode(s);
const longText = 'The institution publishes its mission statement and reviews it every year with its board. '.repeat(3);
/** Text that stays inside the page width: one line per sentence. */
const lines = (...l: string[]) => l.join('\n');
const para = lines(...Array.from({ length: 3 }, () => 'The institution publishes its mission statement and reviews it every year.'));
const withLimits = async <T>(env: Record<string, string>, fn: () => Promise<T>) => {
  const was = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

// The temporary fallback reader (PowerPoint, OpenDocument, RTF, legacy Office) converts with LibreOffice. CI installs it;
// a machine without it skips those tests (everything the owned parser reads still runs).
const soffice = await findLibreOffice();
const fallback = describe.skipIf(!soffice);
if (!soffice) console.warn('soffice not found: the fallback-format tests in parse-document.test.ts are skipped (install libreoffice-writer, -calc and -impress)');

describe('parseDocument: PDF (@drmoyassine/liteparse, one page at a time)', () => {
  it('returns text per page, keeps the line breaks, and flags a page with no text layer as needing OCR', async () => {
    const doc = await parseDocument({ bytes: pdf([lines('Institutions must publish their mission.', para), null, 'Second text page with enough words to count as text, in full.']), fileName: 'guide.pdf' });
    expect(doc.format).toBe('pdf');
    expect(doc.pages.map((p) => p.pageNo)).toEqual([1, 2, 3]);
    expect(doc.pages[0]!.text).toMatch(/^Institutions must publish their mission\.\nThe institution publishes/);
    expect(doc.pages[0]!.text.split('\n')).toHaveLength(4);
    expect(doc.pages[0]).toMatchObject({ method: 'pdf_text', needsOcr: false });
    expect(doc.pages[1]).toMatchObject({ text: '', needsOcr: true, method: 'pdf_text' });
    expect(doc.pages[1]!.warnings.join()).toContain('needs OCR: no-text');
    expect(doc.pages[2]!.needsOcr).toBe(false);
    expect(doc.parser).toMatchObject({ name: '@drmoyassine/liteparse', version: expect.stringMatching(/^\d+\.\d+\.\d+/), fallback: false });
    expect(doc.parser.configHash).toMatch(/^[0-9a-f]{16}$/);
  }, 30000);

  it('judges every page on its own: a scan in the middle of a digital document is read as a scan, the rest stay native', async () => {
    const seen: number[] = [];
    const doc = await parseDocument({ bytes: pdf([para, null, para]), fileName: 'mixed.pdf', ocrPage: async (p) => { seen.push(p.pageNo); return 'scanned page'; } });
    expect(seen).toEqual([2]);
    expect(doc.pages.map((p) => [p.method, p.needsOcr])).toEqual([['pdf_text', false], ['ocr', false], ['pdf_text', false]]);
  }, 30000);

  it('calls the injected OCR hook for pages that need it, with a PNG render of the page and the language', async () => {
    const seen: { pageNo: number; language: string; png: boolean }[] = [];
    const doc = await parseDocument({
      bytes: pdf([para, null]), mime: 'application/pdf', language: 'ar',
      ocrPage: async (p) => { seen.push({ pageNo: p.pageNo, language: p.language, png: p.image[1] === 0x50 && p.image[2] === 0x4e }); return 'نص من المسح الضوئي'; },
    });
    expect(seen).toEqual([{ pageNo: 2, language: 'ar', png: true }]);
    expect(doc.pages[1]).toMatchObject({ text: 'نص من المسح الضوئي', method: 'ocr', needsOcr: false });
    expect(doc.pages[0]!.method).toBe('pdf_text');
  }, 30000);

  it('keeps Arabic diacritics from the OCR hook (nothing is stripped) and normalises to NFC', async () => {
    const harakat = 'مَرْحَبًا بِالْعَالَمِ';
    const a = await parseDocument({ bytes: pdf([null]), fileName: 'x.pdf', ocrPage: async () => harakat });
    expect(a.pages[0]!.text).toBe(harakat.normalize('NFC'));
    expect(a.pages[0]!.text).toMatch(/[ً-ْ]/);
    const b = await parseDocument({ bytes: pdf([null]), fileName: 'x.pdf', ocrPage: async () => 'Café' });
    expect(b.pages[0]!.text).toBe('Café');
  }, 30000);

  it('keeps the page marked when the hook fails or returns nothing, and says why', async () => {
    const a = await parseDocument({ bytes: pdf([null]), fileName: 'x.pdf', ocrPage: async () => { throw new Error('no key'); } });
    expect(a.pages[0]).toMatchObject({ needsOcr: true });
    expect(a.pages[0]!.warnings.join()).toContain('OCR failed: no key');
    const b = await parseDocument({ bytes: pdf([null]), fileName: 'x.pdf', ocrPage: async () => ' ' });
    expect(b.pages[0]!.needsOcr).toBe(true);
    expect(b.pages[0]!.warnings.join()).toContain('OCR returned no text');
  }, 30000);

  it('hands the hook only as many pages as ocrMaxPages allows; the others stay flagged with the reason', async () => {
    const seen: number[] = [];
    const doc = await parseDocument({ bytes: pdf([null, null, null, null]), fileName: 'x.pdf', ocrMaxPages: 2, ocrPage: async (p) => { seen.push(p.pageNo); return 'read'; } });
    expect(seen).toEqual([1, 2]);
    expect(doc.pages.map((p) => [p.method, p.needsOcr])).toEqual([['ocr', false], ['ocr', false], ['pdf_text', true], ['pdf_text', true]]);
    expect(doc.pages[3]!.warnings.join()).toMatch(/not read by AI: the limit of 2 AI-read pages per file/);
  }, 30000);

  it('does not trust a corrupted text layer: it is re-read as a scan, or left empty and flagged when nothing can read it', async () => {
    const junk = lines(...Array.from({ length: 3 }, () => 'Acc{ed|tation of Inst|tut|on must b{ ma|nta|ned by the Comm|ss|on {nd rev|ewed {nnu{lly w|th the boa{d'));
    expect(textLayerLooksCorrupt(junk)).toBe(true);
    const without = await parseDocument({ bytes: pdf([junk]), fileName: 'x.pdf' });
    expect(without.pages[0]).toMatchObject({ text: '', needsOcr: true });
    expect(without.pages[0]!.warnings.join()).toContain('corrupted');
    const withHook = await parseDocument({ bytes: pdf([junk]), fileName: 'x.pdf', ocrPage: async () => 'Accreditation of Institutions' });
    expect(withHook.pages[0]).toMatchObject({ text: 'Accreditation of Institutions', method: 'ocr', needsOcr: false });
  }, 30000);

  it('treats a page with almost no text as a picture, but keeps what text it has', async () => {
    const without = await parseDocument({ bytes: pdf(['Page 7']), fileName: 'x.pdf' });
    expect(without.pages[0]).toMatchObject({ text: 'Page 7', needsOcr: true });
    expect(without.pages[0]!.warnings.join()).toContain('needs OCR');
    const withHook = await parseDocument({ bytes: pdf(['Page 7']), fileName: 'x.pdf', ocrPage: async (p) => `${p.text} full text read from the picture` });
    expect(withHook.pages[0]).toMatchObject({ text: 'Page 7 full text read from the picture', method: 'ocr', needsOcr: false });
  }, 30000);

  it('detects corrupted text layers, and leaves normal text (code, currency, Arabic) alone', () => {
    expect(textLayerLooksCorrupt('�'.repeat(40))).toBe(true);
    expect(textLayerLooksCorrupt(longText)).toBe(false);
    expect(textLayerLooksCorrupt('C# and C++ cost US$100 or £50, e-mail a@b.org; R&D 50% of 1-1-1 and مَرْحَبًا بالعالم في هذه الوثيقة التي تحتوي على نص عربي طويل')).toBe(false);
    expect(textLayerLooksCorrupt('Asflranc€ ')).toBe(false); // too short to judge
  });
});

describe('parseDocument: format detection and errors', () => {
  it('detects the format from the name, the mime type, then the content', () => {
    expect(detectFormat({ bytes: new Uint8Array(), fileName: 'a.XLSX' })).toBe('xlsx');
    expect(detectFormat({ bytes: new Uint8Array(), mime: 'text/csv; charset=utf-8' })).toBe('csv');
    expect(detectFormat({ bytes: docx([{ text: 'x' }]) })).toBe('docx');
    expect(detectFormat({ bytes: xlsx([{ name: 'S', rows: [['a']] }]) })).toBe('xlsx');
    expect(detectFormat({ bytes: pptx([{ title: 'x' }]) })).toBe('pptx');
    expect(detectFormat({ bytes: png() })).toBe('png');
    expect(detectFormat({ bytes: pdf(['x']) })).toBe('pdf');
    expect(detectFormat({ bytes: enc('hello') })).toBeNull();
  });

  it('refuses what it cannot read, with a typed error', async () => {
    await expect(parseDocument({ bytes: enc('hello'), fileName: 'a.txt' })).rejects.toBeInstanceOf(UnsupportedDocumentError);
    await expect(parseDocument({ bytes: enc('hello'), fileName: 'a.txt' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(parseDocument({ bytes: new Uint8Array(), fileName: 'a.pdf' })).rejects.toThrow(/empty/);
  });

  it('reports a file that is not what its name says as corrupt, before any parser runs', async () => {
    for (const fileName of ['broken.docx', 'broken.xlsx', 'broken.pptx', 'broken.odt', 'broken.pdf', 'broken.rtf', 'broken.doc']) {
      const err = await parseDocument({ bytes: enc('not a real file'), fileName }).catch((e) => e);
      expect(err).toBeInstanceOf(DocumentReadError);
      expect(err).toMatchObject({ code: 'corrupt' });
      expect(err.message).toMatch(/could not be read/);
    }
  });

  it('reports a damaged PDF, DOCX or XLSX as corrupt, not a crash', async () => {
    const pdfErr = await parseDocument({ bytes: enc('%PDF-1.4 garbage that is not a pdf'), fileName: 'x.pdf' }).catch((e) => e);
    expect(pdfErr).toMatchObject({ code: 'corrupt' });
    expect(pdfErr.message).toMatch(/PDF file could not be read/);
    const docxErr = await parseDocument({ bytes: zip({ 'readme.txt': 'nothing here' }), fileName: 'broken.docx' }).catch((e) => e);
    expect(docxErr).toBeInstanceOf(DocumentReadError);
    expect(docxErr).toMatchObject({ code: 'corrupt' });
    expect(docxErr.message).toMatch(/DOCX file could not be read/);
    const xlsxErr = await parseDocument({ bytes: enc('PK\u0003\u0004 truncated'), fileName: 'broken.xlsx' }).catch((e) => e);
    expect(xlsxErr).toMatchObject({ code: 'corrupt' });
  }, 30000);

  it('stops a file that takes too long', async () => {
    await withLimits({ PARSER_TIMEOUT_SECONDS: '0.001' }, async () => {
      const err = await parseDocument({ bytes: pdf([para]), fileName: 'a.pdf' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'timeout' });
      expect(err.message).toMatch(/took longer than/);
    });
  }, 30000);

  it('reads only up to the page cap and says so', async () => {
    await withLimits({ PARSER_MAX_PAGES: '2' }, async () => {
      const doc = await parseDocument({ bytes: pdf([para, para, para]), fileName: 'a.pdf' });
      expect(doc.pages).toHaveLength(2);
      expect(doc.warnings.join()).toMatch(/first 2 of 3 pages/);
    });
  }, 30000);
});

describe('parseDocument: Word, Excel, CSV and images (@drmoyassine/liteparse)', () => {
  it('reads a DOCX as one page of text (the library reports no page breaks or headings) and says so', async () => {
    const bytes = docx([{ text: 'Standards', style: 'Heading1' }, { text: 'Standard 1 text about mission.' }, { table: [['Code', 'Title'], ['1.1', 'Mission']] }, { pageBreak: true }, { text: 'Guidance for reviewers.' }]);
    const doc = await parseDocument({ bytes, fileName: 'handbook.docx' });
    expect(doc.format).toBe('docx');
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0]!.text).toContain('Standard 1 text about mission.');
    expect(doc.pages[0]!.text).toContain('Guidance for reviewers.');
    expect(doc.pages[0]!.text).toMatch(/Code[\s\S]*Title[\s\S]*1\.1[\s\S]*Mission/);
    expect(doc.pages[0]).toMatchObject({ method: 'pdf_text', needsOcr: false });
    expect(doc.warnings.join()).toMatch(/one page/);
    expect(doc.parser.fallback).toBe(false);
  }, 30000);

  it('reads an Arabic DOCX with its diacritics (tashkeel) kept, in logical order', async () => {
    const a = 'رَسَالَةُ المُؤَسَّسَةِ';
    const b = 'الأهداف الاستراتيجية';
    const doc = await parseDocument({ bytes: docx([{ text: a, rtl: true }, { text: b, rtl: true }]), fileName: 'ar.docx' });
    expect(doc.pages[0]!.text).toContain(a.normalize('NFC'));
    expect(doc.pages[0]!.text).toContain(b);
    expect(doc.pages[0]!.text).toMatch(/[ً-ْ]/);
  }, 30000);

  it('reads a spreadsheet: a page per sheet (split at the "# Sheet" headers), rows as CSV, headers intact', async () => {
    const bytes = xlsx([{ name: 'Table 5-1', rows: [['Year', 'Graduates'], ['2024', 5], ['2025', 7]] }, { name: 'جدول', rows: [['Hello', 'World']] }, { name: 'Empty', rows: [] }]);
    const doc = await parseDocument({ bytes, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(doc.format).toBe('xlsx');
    expect(doc.pages.map((p) => p.pageNo)).toEqual([1, 2, 3]);
    expect(doc.pages[0]!.text).toBe('# Table 5-1\nYear,Graduates\n2024,5\n2025,7');
    expect(doc.pages[1]!.text).toBe('# جدول\nHello,World');
    expect(doc.pages[2]!.warnings.join()).toContain('no cells');
    expect(doc.pages.every((p) => p.method === 'sheet' && !p.needsOcr)).toBe(true);
  }, 30000);

  it('reads a one-sheet workbook as one page (liteparse gives no sheet name then)', async () => {
    const doc = await parseDocument({ bytes: xlsx([{ name: 'Only', rows: [['H1', 'H2'], ['a', 'b']] }]), fileName: 'one.xlsx' });
    expect(doc.pages.map((p) => p.text)).toEqual(['H1,H2\na,b']);
  }, 30000);

  it('reads CSV (comma, semicolon and tab delimited, quoted fields, Arabic, UTF-8 and UTF-16) as a table page', async () => {
    const a = await parseDocument({ bytes: enc('﻿id,name\n1,"Program, one"\n2,هندسة\n'), fileName: 'programs.csv' });
    expect(a.format).toBe('csv');
    expect(a.pages[0]!.method).toBe('table');
    expect(a.pages[0]!.text).toBe('id,name\n1,"Program, one"\n2,هندسة');
    const b = await parseDocument({ bytes: enc('id;name\n1;Mechanical\n'), fileName: 'semi.csv' });
    expect(b.pages[0]!.text).toBe('id,name\n1,Mechanical');
    const c = await parseDocument({ bytes: enc('id\tname\n1\tCivil\n'), fileName: 'tabs.tsv' });
    expect(c.format).toBe('tsv');
    expect(c.pages[0]!.text).toBe('id,name\n1,Civil');
    const noBom = await parseDocument({ bytes: enc('id,name\n1,هندسة مدنية\n'), fileName: 'no-bom.csv' });
    expect(noBom.pages[0]!.text).toBe('id,name\n1,هندسة مدنية');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('id,name\n1,هندسة\n', 'utf16le')]);
    const d = await parseDocument({ bytes: new Uint8Array(utf16), fileName: 'excel-unicode.csv' });
    expect(d.pages[0]!.text).toBe('id,name\n1,هندسة');
  }, 30000);

  it('reports a spreadsheet or document with no text as having no pages (the caller records why)', async () => {
    const doc = await parseDocument({ bytes: xlsx([{ name: 'E', rows: [] }]), fileName: 'e.xlsx' });
    expect(doc.pages).toEqual([]);
    expect(doc.warnings.join()).toContain('has no text');
  }, 30000);

  it('treats an image as a one-page scan: no text, needs OCR, and the OCR hook gets a PNG', async () => {
    const plain = await parseDocument({ bytes: png(), fileName: 'scan.png' });
    expect(plain.format).toBe('png');
    expect(plain.pages).toHaveLength(1);
    expect(plain.pages[0]).toMatchObject({ pageNo: 1, text: '', needsOcr: true });
    expect(plain.pages[0]!.warnings.join()).toContain('needs OCR');
    const seen: number[] = [];
    const doc = await parseDocument({ bytes: png(), fileName: 'scan.png', language: 'ar', ocrPage: async (p) => { seen.push(p.image[1]!); return 'نص من الصورة'; } });
    expect(seen).toEqual([0x50]);
    expect(doc.pages[0]).toMatchObject({ text: 'نص من الصورة', method: 'ocr', needsOcr: false });
  }, 30000);

  it('converts TIFF, BMP, GIF and WebP images to PNG before the hook sees them', async () => {
    const base = sharp({ create: { width: 40, height: 30, channels: 3, background: '#fff' } });
    for (const [fileName, bytes] of [['a.tif', await base.clone().tiff().toBuffer()], ['a.gif', await base.clone().gif().toBuffer()], ['a.webp', await base.clone().webp().toBuffer()]] as const) {
      const heads: number[][] = [];
      const doc = await parseDocument({ bytes: new Uint8Array(bytes), fileName, ocrPage: async (p) => { heads.push([...p.image.subarray(0, 4)]); return 'read'; } });
      expect(heads).toEqual([[0x89, 0x50, 0x4e, 0x47]]);
      expect(doc.pages[0]).toMatchObject({ text: 'read', method: 'ocr' });
    }
    const err = await parseDocument({ bytes: enc('II*\0 not an image'), fileName: 'bad.tif' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'corrupt' });
  }, 30000);
});

fallback('parseDocument: formats the owned parser does not read yet (temporary fallback, LibreOffice)', () => {
  it('reads a PPTX: a page per slide, in slide order', async () => {
    const doc = await parseDocument({ bytes: pptx([{ title: 'Opening', lines: ['First point'] }, { title: 'Timeline', lines: ['Second point'] }, { title: '' }]), fileName: 'deck.pptx' });
    expect(doc.pages.map((p) => p.pageNo)).toEqual([1, 2, 3]);
    expect(doc.pages[0]!.text).toContain('Opening');
    expect(doc.pages[1]!.text).toContain('Second point');
    expect(doc.pages.every((p) => p.method === 'slide')).toBe(true);
    // a slide without text is kept (slide numbers stay true) and said to be empty
    expect(doc.pages[2]).toMatchObject({ text: '', needsOcr: false });
    expect(doc.pages[2]!.warnings.join()).toMatch(/no text/);
    expect(doc.parser).toMatchObject({ name: '@llamaindex/liteparse', fallback: true });
  }, 60000);

  it('reads RTF through the same path', async () => {
    const rtf = await parseDocument({ bytes: enc('{\\rtf1\\ansi Mission statement of the institution.}'), fileName: 'a.rtf' });
    expect(rtf.pages[0]!.text).toBe('Mission statement of the institution.');
    expect(rtf.pages[0]!.method).toBe('pdf_text');
    expect(rtf.parser.fallback).toBe(true);
  }, 60000);

  it('names LibreOffice when it is missing, instead of crashing', async () => {
    await withLimits({ PATH: '/nonexistent' }, async () => {
      const err = await parseDocument({ bytes: pptx([{ title: 'x', lines: ['y'] }]), fileName: 'a.pptx' }).catch((e) => e);
      expect(err).toBeInstanceOf(DocumentReadError);
      expect(err).toMatchObject({ code: 'converter_missing' });
      expect(err.message).toMatch(/LibreOffice is not installed on the parser service/);
    });
  }, 60000);
});

describe('local OCR switch (PARSER_LOCAL_OCR)', () => {
  it('is off by default: no local engine is loaded and the vision hook reads scans', async () => {
    const doc = await parseDocument({ bytes: pdf([null]), fileName: 'x.pdf', language: 'en', ocrPage: async () => 'read by the hook' });
    expect(doc.pages[0]).toMatchObject({ text: 'read by the hook', method: 'ocr' });
    expect(doc.warnings).toEqual([]);
    expect(doc.parser.configHash).toMatch(/^[0-9a-f]{16}$/);
  }, 30000);

  it('when switched on without onnxruntime-node and the packaged models, says so and falls back to the vision hook', async () => {
    await withLimits({ PARSER_LOCAL_OCR: 'rapidocr', RAPIDOCR_MODEL_PATH: '/nonexistent/models' }, async () => {
      const doc = await parseDocument({ bytes: pdf([null]), fileName: 'x.pdf', language: 'en', ocrPage: async () => 'read by the hook' });
      expect(doc.pages[0]).toMatchObject({ text: 'read by the hook', method: 'ocr', needsOcr: false });
      expect(doc.warnings.join()).toMatch(/local OCR \(PARSER_LOCAL_OCR=rapidocr\) is not available/);
    });
  }, 30000);
});

describe('parse thresholds', () => {
  it('keeps the minimum page text the reading step relies on', () => { expect(MIN_PAGE_TEXT_CHARS).toBe(20); });
});

describe('parser import points (DEC-011)', () => {
  const root = resolve(import.meta.dirname, '../../../..');
  function* files(dir: string): Generator<string> {
    for (const e of readdirSync(dir)) {
      if (['node_modules', 'dist', 'dist-types', 'migrations', '.scratch'].includes(e)) continue;
      const path = join(dir, e);
      if (statSync(path).isDirectory()) yield* files(path);
      else if (/\.(ts|tsx|mjs)$/.test(e) && !/\.test\.tsx?$/.test(e)) yield path;
    }
  }
  const importers = (pattern: RegExp) => ['apps', 'packages'].flatMap((d) => [...files(join(root, d))]).filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));

  it('imports the owned parser only in parse-document.ts and the temporary upstream fallback only in parse-document-fallback.ts', () => {
    expect(importers(/['"]@drmoyassine\/liteparse(\/[\w/-]+)?['"]/)).toEqual(['packages/core/src/framework/parse-document.ts']);
    expect(importers(/['"]@llamaindex\/liteparse['"]/)).toEqual(['packages/core/src/framework/parse-document-fallback.ts']);
  });

  it('has no other document-format library anywhere (pdfjs-dist is liteparse\'s peer and is loaded only in parse-document.ts)', () => {
    expect(importers(/from\s+['"](fflate|jszip|mammoth|pdf-parse|xlsx|unzipper|adm-zip)['"]/)).toEqual([]);
    expect(importers(/['"]pdfjs-dist[\w/.-]*['"]/)).toEqual(['packages/core/src/framework/parse-document.ts']);
  });
});
