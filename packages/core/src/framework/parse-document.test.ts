import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docx, pdf, png, pptx, xlsx, zip } from './parse-fixtures.js';
import { detectFormat, DocumentReadError, findLibreOffice, parseDocument, UnsupportedDocumentError } from './parse-document.js';

const enc = (s: string) => new TextEncoder().encode(s);
const longText = 'The institution publishes its mission statement and reviews it every year with its board. '.repeat(3);

// Office, OpenDocument, spreadsheet and CSV files are converted by LibreOffice inside liteparse. CI installs it; a
// machine without it skips these tests (the PDF and error tests still run).
const soffice = await findLibreOffice();
const office = describe.skipIf(!soffice);
if (!soffice) console.warn('soffice not found: the Office-format tests in parse-document.test.ts are skipped (install libreoffice-writer, -calc and -impress)');

describe('parseDocument: PDF', () => {
  it('returns text per page and flags a page with no text layer as needing OCR', async () => {
    const doc = await parseDocument({ bytes: pdf([`Institutions must publish their mission. ${longText}`, null, 'Second text page with enough words to count as text.']), fileName: 'guide.pdf' });
    expect(doc.format).toBe('pdf');
    expect(doc.pages.map((p) => p.pageNo)).toEqual([1, 2, 3]);
    expect(doc.pages[0]!.text).toContain('Institutions must publish their mission.');
    expect(doc.pages[0]).toMatchObject({ method: 'pdf_text', needsOcr: false });
    expect(doc.pages[1]).toMatchObject({ text: '', needsOcr: true, method: 'pdf_text' });
    expect(doc.pages[1]!.warnings.join()).toMatch(/needs OCR: (scanned|no-text)/);
    expect(doc.pages[2]!.needsOcr).toBe(false);
  }, 30000);

  it('calls the injected OCR hook for pages that need it, with a rendered image and the language', async () => {
    const seen: { pageNo: number; language: string; png: boolean }[] = [];
    const doc = await parseDocument({
      bytes: pdf([longText, null]), mime: 'application/pdf', language: 'ar',
      ocrPage: async (p) => { seen.push({ pageNo: p.pageNo, language: p.language, png: p.image[1] === 0x50 && p.image[2] === 0x4e }); return 'نص من المسح الضوئي'; },
    });
    expect(seen).toEqual([{ pageNo: 2, language: 'ar', png: true }]);
    expect(doc.pages[1]).toMatchObject({ text: 'نص من المسح الضوئي', method: 'ocr', needsOcr: false });
    expect(doc.pages[0]!.method).toBe('pdf_text');
  }, 30000);

  it('keeps the page marked when the hook fails or returns nothing', async () => {
    const a = await parseDocument({ bytes: pdf([null]), fileName: 'x.pdf', ocrPage: async () => { throw new Error('no key'); } });
    expect(a.pages[0]).toMatchObject({ needsOcr: true });
    expect(a.pages[0]!.warnings.join()).toContain('no key');
    const b = await parseDocument({ bytes: pdf([null]), fileName: 'x.pdf', ocrPage: async () => ' ' });
    expect(b.pages[0]!.needsOcr).toBe(true);
  }, 30000);

  it('normalises text to NFC', async () => {
    const doc = await parseDocument({ bytes: pdf([null]), fileName: 'x.pdf', ocrPage: async () => 'Cafe\u0301' });
    expect(doc.pages[0]!.text).toBe('Caf\u00e9');
  }, 30000);
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
    await expect(parseDocument({ bytes: new Uint8Array(), fileName: 'a.pdf' })).rejects.toThrow(/empty/);
  });

  it('reports a file that is not what its name says as corrupt, before any converter runs', async () => {
    for (const fileName of ['broken.docx', 'broken.xlsx', 'broken.pptx', 'broken.odt', 'broken.pdf', 'broken.rtf']) {
      const err = await parseDocument({ bytes: enc('not a real file'), fileName }).catch((e) => e);
      expect(err).toBeInstanceOf(DocumentReadError);
      expect(err).toMatchObject({ code: 'corrupt' });
      expect(err.message).toMatch(/could not be read/);
    }
  });

  it('reports a damaged PDF as corrupt, not a crash', async () => {
    const err = await parseDocument({ bytes: enc('%PDF-1.4 garbage that is not a pdf'), fileName: 'x.pdf' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'corrupt' });
    expect(err.message).toMatch(/PDF file could not be read/);
  }, 30000);

  it('names LibreOffice when it is missing, instead of crashing', async () => {
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const err = await parseDocument({ bytes: docx([{ text: 'x' }]), fileName: 'a.docx' }).catch((e) => e);
      expect(err).toBeInstanceOf(DocumentReadError);
      expect(err).toMatchObject({ code: 'converter_missing' });
      expect(err.message).toMatch(/LibreOffice is not installed on the parser service/);
    } finally { process.env.PATH = path; }
  }, 30000);

  it('stops a file that takes too long', async () => {
    const was = process.env.PARSER_TIMEOUT_SECONDS;
    process.env.PARSER_TIMEOUT_SECONDS = '0.001';
    try {
      const err = await parseDocument({ bytes: pdf([longText]), fileName: 'a.pdf' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'timeout' });
      expect(err.message).toMatch(/took longer than/);
    } finally { if (was === undefined) delete process.env.PARSER_TIMEOUT_SECONDS; else process.env.PARSER_TIMEOUT_SECONDS = was; }
  }, 30000);

  it('reads only up to the page cap and says so', async () => {
    const was = process.env.PARSER_MAX_PAGES;
    process.env.PARSER_MAX_PAGES = '2';
    try {
      const doc = await parseDocument({ bytes: pdf([longText, longText, longText]), fileName: 'a.pdf' });
      expect(doc.pages).toHaveLength(2);
      expect(doc.warnings.join()).toMatch(/first 2 of 3 pages/);
    } finally { if (was === undefined) delete process.env.PARSER_MAX_PAGES; else process.env.PARSER_MAX_PAGES = was; }
  }, 30000);
});

office('parseDocument: Office, OpenDocument, spreadsheets, CSV and images (liteparse + LibreOffice)', () => {
  it('reads a DOCX: headings and tables as text, a page per printed page, no OCR needed', async () => {
    const bytes = docx([{ text: 'Standards', style: 'Heading1' }, { text: 'Standard 1 text about mission.' }, { table: [['Code', 'Title'], ['1.1', 'Mission']] }, { pageBreak: true }, { text: 'Guidance for reviewers.' }]);
    const doc = await parseDocument({ bytes, fileName: 'handbook.docx' });
    expect(doc.format).toBe('docx');
    expect(doc.pages.map((p) => p.pageNo)).toEqual([1, 2]);
    expect(doc.pages[0]!.text).toContain('Standard 1 text about mission.');
    expect(doc.pages[0]!.text).toMatch(/Code\s+Title\n1\.1\s+Mission/);
    expect(doc.pages[1]!.text).toBe('Guidance for reviewers.');
    expect(doc.pages.every((p) => p.method === 'pdf_text' && !p.needsOcr)).toBe(true);
  }, 60000);

  it('reads an Arabic DOCX (the letters survive; liteparse may reorder words, which the AI steps tolerate)', async () => {
    const doc = await parseDocument({ bytes: docx([{ text: 'رسالة المؤسسة', rtl: true }, { text: 'الأهداف الاستراتيجية', rtl: true }]), fileName: 'ar.docx' });
    const letters = (s: string) => [...s.replace(/[^\p{L}]/gu, '')].sort().join('');
    expect(letters(doc.pages[0]!.text)).toBe(letters('رسالة المؤسسة الأهداف الاستراتيجية'));
  }, 60000);

  it('reads a spreadsheet: a page per sheet, rows as lines of text', async () => {
    const bytes = xlsx([{ name: 'Metrics', rows: [['Year', 'Graduates'], ['2024', 5], ['2025', 7]] }, { name: 'Notes', rows: [['Hello', 'World']] }]);
    const doc = await parseDocument({ bytes, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(doc.format).toBe('xlsx');
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages[0]!.text).toMatch(/^Year\s+Graduates\n2024\s+5\n2025\s+7$/);
    expect(doc.pages[1]!.text).toMatch(/^Hello\s+World$/);
    expect(doc.pages.every((p) => p.method === 'sheet' && !p.needsOcr)).toBe(true);
  }, 60000);

  it('reads a PPTX: a page per slide, in slide order', async () => {
    const doc = await parseDocument({ bytes: pptx([{ title: 'Opening', lines: ['First point'] }, { title: 'Timeline', lines: ['Second point'] }, { title: '' }]), fileName: 'deck.pptx' });
    expect(doc.pages.map((p) => p.pageNo)).toEqual([1, 2, 3]);
    expect(doc.pages[0]!.text).toContain('Opening');
    expect(doc.pages[1]!.text).toContain('Second point');
    expect(doc.pages.every((p) => p.method === 'slide')).toBe(true);
    // a slide without text is kept (slide numbers stay true) and said to be empty, but it is not sent to OCR
    expect(doc.pages[2]).toMatchObject({ text: '', needsOcr: false });
    expect(doc.pages[2]!.warnings.join()).toMatch(/no text/);
  }, 60000);

  it('reads CSV (comma, semicolon and tab delimited, quoted fields, Arabic) as table pages without the converter noise', async () => {
    const a = await parseDocument({ bytes: enc('﻿id,name\n1,"Program, one"\n2,هندسة\n'), fileName: 'programs.csv' });
    expect(a.format).toBe('csv');
    expect(a.pages[0]!.method).toBe('table');
    expect(a.pages[0]!.text).toMatch(/^id\s+name\n1\s+Program, one\n2\s+هندسة$/);
    const b = await parseDocument({ bytes: enc('id;name\n1;Mechanical\n'), fileName: 'semi.csv' });
    expect(b.pages[0]!.text).toMatch(/^id\s+name\n1\s+Mechanical$/);
    const c = await parseDocument({ bytes: enc('id\tname\n1\tCivil\n'), fileName: 'tabs.tsv' });
    expect(c.pages[0]!.text).toMatch(/^id\s+name\n1\s+Civil$/);
  }, 60000);

  it('reads RTF through the same path', async () => {
    const rtf = await parseDocument({ bytes: enc('{\\rtf1\\ansi Mission statement of the institution.}'), fileName: 'a.rtf' });
    expect(rtf.pages[0]!.text).toBe('Mission statement of the institution.');
  }, 60000);

  it('treats an image as a one-page scan: no text, needs OCR, and the OCR hook gets the picture', async () => {
    const plain = await parseDocument({ bytes: png(), fileName: 'scan.png' });
    expect(plain.format).toBe('png');
    expect(plain.pages).toHaveLength(1);
    expect(plain.pages[0]).toMatchObject({ pageNo: 1, text: '', needsOcr: true });
    expect(plain.pages[0]!.warnings.join()).toContain('needs OCR');
    const seen: number[] = [];
    const doc = await parseDocument({ bytes: png(), fileName: 'scan.png', language: 'ar', ocrPage: async (p) => { seen.push(p.image[1]!); return 'نص من الصورة'; } });
    expect(seen).toEqual([0x50]);
    expect(doc.pages[0]).toMatchObject({ text: 'نص من الصورة', method: 'ocr', needsOcr: false });
  }, 60000);

  it('reports a damaged Office file (a zip that is not a document) as corrupt', async () => {
    const err = await parseDocument({ bytes: zip({ 'readme.txt': 'nothing here' }), fileName: 'broken.docx' }).catch((e) => e);
    expect(err).toBeInstanceOf(DocumentReadError);
    expect(err).toMatchObject({ code: 'corrupt' });
    expect(err.message).toMatch(/DOCX file could not be read/);
  }, 60000);
});

describe('liteparse import point (DEC-011)', () => {
  const root = resolve(import.meta.dirname, '../../../..');
  function* files(dir: string): Generator<string> {
    for (const e of readdirSync(dir)) {
      if (['node_modules', 'dist', 'dist-types', 'migrations'].includes(e)) continue;
      const path = join(dir, e);
      if (statSync(path).isDirectory()) yield* files(path);
      else if (/\.(ts|tsx|mjs)$/.test(e) && !/\.test\.tsx?$/.test(e)) yield path;
    }
  }
  const importers = (pattern: RegExp) => ['apps', 'packages'].flatMap((d) => [...files(join(root, d))]).filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));

  it('imports liteparse only in parse-document.ts, and no other document-format library anywhere', () => {
    expect(importers(/from\s+['"]@llamaindex\/liteparse['"]/)).toEqual(['packages/core/src/framework/parse-document.ts']);
    expect(importers(/from\s+['"](fflate|jszip|mammoth|pdfjs-dist|pdf-parse|xlsx|unzipper|adm-zip)['"]/)).toEqual([]);
  });
});
