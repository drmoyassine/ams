import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { pdf, W, para, zip } from './parse-fixtures.js';
import { detectFormat, parseCsvRecords, parseDocument, UnsupportedDocumentError } from './parse-document.js';

const longText = 'The institution publishes its mission statement and reviews it every year with its board. '.repeat(3);

describe('parseDocument: PDF', () => {
  it('returns text per page and flags a page with no text layer as needing OCR', async () => {
    const doc = await parseDocument({ bytes: pdf([`Institutions must publish their mission. ${longText}`, null, 'Second text page with enough words to count as text.']), fileName: 'guide.pdf' });
    expect(doc.format).toBe('pdf');
    expect(doc.pages.map((p) => p.pageNo)).toEqual([1, 2, 3]);
    expect(doc.pages[0]!.text).toContain('Institutions must publish their mission.');
    expect(doc.pages[0]).toMatchObject({ method: 'pdf_text', needsOcr: false });
    expect(doc.pages[1]).toMatchObject({ text: '', needsOcr: true, method: 'pdf_text' });
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
});

describe('parseDocument: Office and CSV', () => {
  it('splits a DOCX at top-level headings and renders tables', async () => {
    const body = [para('Standards', 'Heading1'), para('Standard 1 text.'), '<w:tbl><w:tr><w:tc>' + para('Code') + '</w:tc><w:tc>' + para('Title') + '</w:tc></w:tr><w:tr><w:tc>' + para('1.1') + '</w:tc><w:tc>' + para('Mission &amp; vision') + '</w:tc></w:tr></w:tbl>',
      para('Guidance', 'Heading1'), para('الرسالة والأهداف')].join('');
    const bytes = zip({ 'word/document.xml': `<w:document ${W}><w:body>${body}</w:body></w:document>` });
    const doc = await parseDocument({ bytes, fileName: 'handbook.docx' });
    expect(doc.format).toBe('docx');
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages[0]!.text).toBe('Standards\nStandard 1 text.\nCode | Title\n1.1 | Mission & vision');
    expect(doc.pages[1]!.text).toContain('الرسالة والأهداف');
    expect(doc.pages.every((p) => p.method === 'pdf_text' && !p.needsOcr)).toBe(true);
  });

  it('makes a page per worksheet, as a text table, using shared and inline strings', async () => {
    const bytes = zip({
      'xl/workbook.xml': '<workbook xmlns:r="x"><sheets><sheet name="Metrics" sheetId="1" r:id="rId1"/><sheet name="Blank" sheetId="2" r:id="rId2"/><sheet name="Notes" sheetId="3" r:id="rId3"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="/xl/worksheets/sheet3.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Year</t></si><si><t>Graduates</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>2024</v></c><c r="C2"><v>5</v></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
      'xl/worksheets/sheet3.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Hello</t></is></c><c r="B1" t="b"><v>1</v></c></row></sheetData></worksheet>',
    });
    const doc = await parseDocument({ bytes, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(doc.format).toBe('xlsx');
    expect(doc.pages.map((p) => p.text)).toEqual(['Sheet: Metrics\nYear | Graduates\n2024 |  | 5', 'Sheet: Notes\nHello | TRUE']);
    expect(doc.pages.every((p) => p.method === 'sheet')).toBe(true);
    expect(doc.warnings.join()).toContain('Blank');
  });

  it('makes a page per slide, in presentation order, with notes', async () => {
    const A = 'xmlns:a="a" xmlns:p="p"';
    const sp = (t: string, ph = '') => `<p:sp><p:nvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const bytes = zip({
      'ppt/presentation.xml': '<p:presentation xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="rId2"/><p:sldId id="2" r:id="rId1"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': `<p:sld ${A}>${sp('Opening')}${sp('1', '<p:ph type="sldNum"/>')}</p:sld>`,
      'ppt/slides/slide2.xml': `<p:sld ${A}>${sp('Accreditation timeline')}${sp('Second line')}</p:sld>`,
      'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
      'ppt/notesSlides/notesSlide1.xml': `<p:notes ${A}>${sp('', '<p:ph type="sldImg"/>')}${sp('Say this aloud', '<p:ph type="body"/>')}</p:notes>`,
    });
    const doc = await parseDocument({ bytes, fileName: 'deck.pptx' });
    expect(doc.pages.map((p) => p.text)).toEqual(['Accreditation timeline\nSecond line\n\nNotes:\nSay this aloud', 'Opening']);
    expect(doc.pages.every((p) => p.method === 'slide')).toBe(true);
  });

  it('chunks a CSV with the header repeated, honouring quoted commas and newlines', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => `${i + 1},"Program, ${i + 1}"`).join('\n');
    const doc = await parseDocument({ bytes: strToU8(`\uFEFFid,name\n${rows}\n`), fileName: 'programs.csv' });
    expect(doc.pages).toHaveLength(3);
    expect(doc.pages.every((p) => p.text.startsWith('id | name\n') && p.method === 'table')).toBe(true);
    expect(doc.pages[0]!.text.split('\n')).toHaveLength(101);
    expect(doc.pages[2]!.text.split('\n').at(-1)).toBe('250 | Program, 250');
    expect(parseCsvRecords('a;b\n"x\ny";2\r\n')).toEqual([['a', 'b'], ['x\ny', '2']]);
  });

  it('normalises to NFC and detects the format from content when the name is unhelpful', async () => {
    const bytes = zip({ 'word/document.xml': `<w:document ${W}><w:body>${para('Café')}</w:body></w:document>` });
    expect(detectFormat({ bytes })).toBe('docx');
    expect((await parseDocument({ bytes })).pages[0]!.text).toBe('Café');
  });

  it('refuses what it cannot read', async () => {
    await expect(parseDocument({ bytes: strToU8('hello'), fileName: 'a.txt' })).rejects.toBeInstanceOf(UnsupportedDocumentError);
    await expect(parseDocument({ bytes: strToU8('not a zip'), fileName: 'a.docx' })).rejects.toThrow(/not a valid Office file/);
  });
});
