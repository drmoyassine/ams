// parseDocument(): the ONE place the AMS reads a file into per-page text (DEC-011, PRD 15.1 step 3).
//
// - PDF goes through liteparse (the only import of it in the repository); its OCR is switched off here. A page with
//   little or no text layer is *marked* `needsOcr`; if the caller injects an `ocrPage` hook (Step B wires `aiOcr` to
//   it) the hook is called with the rendered page image. No model is called from this file.
// - DOCX, XLSX, PPTX and CSV are read directly from their (zip/XML or text) content with fflate: they become
//   pseudo-pages (section / sheet / slide / row chunk). LibreOffice is not needed, so nothing but Node is required.
// Host-agnostic: bytes in, pages out. Text is NFC (Arabic is first-class content).
import { unzipSync, strFromU8 } from 'fflate';
import { LiteParse } from '@llamaindex/liteparse';

export type PageMethod = 'pdf_text' | 'ocr' | 'table' | 'slide' | 'sheet';
export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv';

export interface ParsedDocumentPage {
  pageNo: number;
  text: string;
  method: PageMethod;
  /** The page has no usable text layer: it should be read by OCR (or a vision model). */
  needsOcr: boolean;
  warnings: string[];
}

/** What the OCR hook receives for a page that needs it. `image` is a PNG render of the page. */
export interface OcrPageRequest { pageNo: number; image: Uint8Array; language: string; text: string }
/** Returns the page's text, or null/empty when it could not be read. */
export type OcrPageHook = (page: OcrPageRequest) => Promise<string | null | undefined>;

export interface ParseDocumentInput {
  bytes: Uint8Array;
  mime?: string | null;
  fileName?: string | null;
  /** Language hint (e.g. 'en', 'ar'); passed on to the OCR hook. */
  language?: string;
  ocrPage?: OcrPageHook;
  /** At most this many pages are rendered and handed to the OCR hook; the rest stay flagged `needsOcr` with a warning. */
  ocrMaxPages?: number;
}

export interface ParsedDocument {
  format: DocumentFormat;
  pages: ParsedDocumentPage[];
  /** Document-level notes (e.g. a skipped empty sheet). */
  warnings: string[];
}

export class UnsupportedDocumentError extends Error {
  readonly status = 400;
}

/** A PDF page with fewer non-space characters than this is treated as having no text layer. */
export const MIN_PAGE_TEXT_CHARS = 20;
/** Pseudo-page sizes for formats without pages. */
const DOCX_PAGE_CHARS = 4000;
const CSV_PAGE_CHARS = 6000;
const CSV_PAGE_ROWS = 100;

const MIME_FORMAT: Record<string, DocumentFormat> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv', 'application/csv': 'csv', 'application/vnd.ms-excel': 'csv',
};
const EXT_FORMAT: Record<string, DocumentFormat> = { pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx', csv: 'csv', tsv: 'csv' };

/** The file types a source can be read from: used by the upload allowlist and the file pickers. */
export const SOURCE_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'pptx', 'csv'] as const;
export const SOURCE_MIME_TYPES = Object.keys(MIME_FORMAT).filter((m) => m !== 'application/vnd.ms-excel' && m !== 'application/csv');

const startsWith = (b: Uint8Array, s: string) => s.split('').every((ch, i) => b[i] === ch.charCodeAt(0));

/** Decides the format from the file name, then the mime type, then the content itself. */
export function detectFormat(input: Pick<ParseDocumentInput, 'bytes' | 'mime' | 'fileName'>): DocumentFormat | null {
  const ext = input.fileName?.split('.').pop()?.toLowerCase();
  if (ext && EXT_FORMAT[ext]) return EXT_FORMAT[ext]!;
  const mime = input.mime?.split(';')[0]?.trim().toLowerCase();
  if (mime && MIME_FORMAT[mime]) return MIME_FORMAT[mime]!;
  if (startsWith(input.bytes.subarray(0, 8), '%PDF-')) return 'pdf';
  if (startsWith(input.bytes, 'PK')) {
    try {
      const names = Object.keys(unzipSync(input.bytes, { filter: (f) => /^(word\/document|xl\/workbook|ppt\/presentation)\.xml$/.test(f.name) }));
      if (names.includes('word/document.xml')) return 'docx';
      if (names.includes('xl/workbook.xml')) return 'xlsx';
      if (names.includes('ppt/presentation.xml')) return 'pptx';
    } catch { /* not a readable zip */ }
  }
  return null;
}

const nfc = (s: string) => s.normalize('NFC');

/** Reads a file into ordered pages. Throws UnsupportedDocumentError for a format it cannot read. */
export async function parseDocument(input: ParseDocumentInput): Promise<ParsedDocument> {
  const format = detectFormat(input);
  if (!format) throw new UnsupportedDocumentError('this file type cannot be read; use PDF, DOCX, XLSX, PPTX or CSV');
  if (!input.bytes.byteLength) throw new UnsupportedDocumentError('the file is empty');
  let doc: { pages: ParsedDocumentPage[]; warnings: string[] };
  try {
    doc = format === 'pdf' ? await parsePdf(input) : format === 'csv' ? parseCsv(input.bytes) : parseOffice(format, input.bytes);
  } catch (e) {
    if (e instanceof UnsupportedDocumentError) throw e;
    throw new UnsupportedDocumentError(`the ${format.toUpperCase()} file could not be read (${(e as Error).message})`);
  }
  const pages = doc.pages.map((p, i) => ({ ...p, pageNo: i + 1, text: nfc(p.text) }));
  return { format, pages, warnings: doc.warnings };
}

// ---------------------------------------------------------------------------------------------------- PDF

/** Replacement characters or private-use glyphs in bulk mean the embedded text layer is corrupted (LP3). */
function garbled(text: string): boolean {
  const chars = [...text.replace(/\s/g, '')];
  if (chars.length < MIN_PAGE_TEXT_CHARS) return false;
  const bad = chars.filter((c) => c === '�' || (c >= '' && c <= '') || c.charCodeAt(0) < 32).length;
  return bad / chars.length > 0.3;
}

async function parsePdf(input: ParseDocumentInput) {
  const parser = new LiteParse({ ocrEnabled: false, quiet: true, continueOnPageError: true, outputFormat: 'json' });
  const result = await parser.parse(input.bytes);
  const errors = new Map(result.pageErrors.map((e) => [e.pageNum, e.message]));
  const byNo = new Map(result.pages.map((p) => [p.pageNum, p]));
  const pages: ParsedDocumentPage[] = [];
  for (let n = 1; n <= result.totalPages; n++) {
    const text = (byNo.get(n)?.text ?? '').trim();
    const warnings: string[] = [];
    if (errors.has(n)) warnings.push(`page could not be read: ${errors.get(n)}`);
    const corrupt = garbled(text);
    if (corrupt) warnings.push('the text layer looks corrupted');
    const needsOcr = text.replace(/\s/g, '').length < MIN_PAGE_TEXT_CHARS || corrupt;
    pages.push({ pageNo: n, text: corrupt ? '' : text, method: 'pdf_text', needsOcr, warnings });
  }
  if (input.ocrPage) await runOcrHook(input, pages);
  return { pages, warnings: [] as string[] };
}

/** Renders the pages that need OCR and hands each to the injected hook. A failure leaves the page marked needsOcr. */
async function runOcrHook(input: ParseDocumentInput, pages: ParsedDocumentPage[]) {
  const all = pages.filter((p) => p.needsOcr);
  if (!all.length || !input.ocrPage) return;
  const limit = input.ocrMaxPages ?? Number.POSITIVE_INFINITY;
  const wanted = all.slice(0, limit);
  for (const p of all.slice(limit)) p.warnings.push(`not read by AI: the limit of ${limit} AI-read pages per file is reached (Settings -> AI)`);
  if (!wanted.length) return;
  const renderer = new LiteParse({ ocrEnabled: false, quiet: true, continueOnPageError: true, extractScreenshots: true, targetPages: wanted.map((p) => p.pageNo).join(',') });
  const shots = new Map((await renderer.parse(input.bytes)).screenshots.map((s) => [s.pageNum, s]));
  for (const p of wanted) {
    const shot = shots.get(p.pageNo);
    if (!shot) { p.warnings.push('the page could not be rendered for OCR'); continue; }
    try {
      const text = (await input.ocrPage({ pageNo: p.pageNo, image: new Uint8Array(shot.imageBuffer), language: input.language ?? 'en', text: p.text }))?.trim();
      if (text) { p.text = text; p.method = 'ocr'; p.needsOcr = false; } else p.warnings.push('OCR returned no text');
    } catch (e) { p.warnings.push(`OCR failed: ${(e as Error).message}`); }
  }
}

// ------------------------------------------------------------------------------------------- Office (zip/XML)

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
  if (e[0] === '#') { const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ''; }
  return ENTITIES[e] ?? m;
});
const attr = (tag: string, name: string) => decode(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? '');

/** Text of a paragraph-like fragment: runs, tabs and line breaks. `t` is the text-run tag ('w:t' or 'a:t'). */
function runsText(xml: string, ns: 'w' | 'a'): string {
  const re = ns === 'w' ? /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)\s*\/>/g : /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\s*\/?>/g;
  let out = '';
  for (const m of xml.matchAll(re)) out += m[1] !== undefined ? decode(m[1]) : m[0].includes('tab') ? '\t' : '\n';
  return out;
}

function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  try { return unzipSync(bytes); } catch (e) { throw new UnsupportedDocumentError(`not a valid Office file (${(e as Error).message})`); }
}
const entry = (files: Record<string, Uint8Array>, name: string) => (files[name] ? strFromU8(files[name]!) : undefined);

function parseOffice(format: 'docx' | 'xlsx' | 'pptx', bytes: Uint8Array) {
  const files = unzip(bytes);
  return format === 'docx' ? parseDocx(files) : format === 'xlsx' ? parseXlsx(files) : parsePptx(files);
}

const tableText = (rows: string[][]) => rows.map((r) => r.join(' | ')).join('\n');

/** Pseudo-pages of a DOCX: a new page at each top-level heading (or title), and when a page grows past a size. */
function parseDocx(files: Record<string, Uint8Array>) {
  const xml = entry(files, 'word/document.xml');
  if (!xml) throw new UnsupportedDocumentError('word/document.xml is missing');
  const pages: ParsedDocumentPage[] = [];
  let cur: string[] = [];
  let size = 0;
  const flush = () => {
    const text = cur.join('\n').trim();
    if (text) pages.push({ pageNo: 0, text, method: 'pdf_text', needsOcr: false, warnings: [] });
    cur = []; size = 0;
  };
  const body = xml.slice(xml.indexOf('<w:body'));
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const chunk = m[0];
    let line: string;
    if (chunk.startsWith('<w:tbl>')) {
      const rows = [...chunk.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)].map((r) =>
        [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => [...c[0].matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map((p) => runsText(p[0], 'w')).join(' ').replace(/\s+/g, ' ').trim()));
      line = tableText(rows);
    } else {
      line = runsText(chunk, 'w');
      const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(chunk)?.[1] ?? '';
      if (/^(Heading ?1|Title)$/i.test(style) && line.trim()) flush();
    }
    if (size + line.length > DOCX_PAGE_CHARS && size > 0) flush();
    cur.push(line); size += line.length + 1;
  }
  flush();
  return { pages, warnings: pages.length ? [] : ['the document has no text'] };
}

/** Resolves a relationship target (relative to its part's folder) to a zip path. */
function relTargets(files: Record<string, Uint8Array>, relsPath: string, baseDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of (entry(files, relsPath) ?? '').matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attr(m[0], 'Id'); let target = attr(m[0], 'Target');
    if (!id || !target) continue;
    if (target.startsWith('/')) target = target.slice(1);
    else {
      const parts = `${baseDir}/${target}`.split('/'); const stack: string[] = [];
      for (const p of parts) { if (p === '..') stack.pop(); else if (p && p !== '.') stack.push(p); }
      target = stack.join('/');
    }
    out.set(id, target);
  }
  return out;
}

const colIndex = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** One page per worksheet, rendered as a text table (`a | b | c`). */
function parseXlsx(files: Record<string, Uint8Array>) {
  const wb = entry(files, 'xl/workbook.xml');
  if (!wb) throw new UnsupportedDocumentError('xl/workbook.xml is missing');
  const shared = [...(entry(files, 'xl/sharedStrings.xml') ?? '').matchAll(/<si[\s>][\s\S]*?<\/si>/g)]
    .map((si) => [...si[0].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decode(t[1]!)).join(''));
  const rels = relTargets(files, 'xl/_rels/workbook.xml.rels', 'xl');
  const pages: ParsedDocumentPage[] = [];
  const warnings: string[] = [];
  for (const s of wb.matchAll(/<sheet\s[^>]*>/g)) {
    const name = attr(s[0], 'name'); const path = rels.get(attr(s[0], 'r:id'));
    const sheet = path ? entry(files, path) : undefined;
    if (!sheet) { warnings.push(`sheet "${name}" could not be found`); continue; }
    const rows: string[][] = [];
    for (const r of sheet.matchAll(/<row[\s>][\s\S]*?<\/row>/g)) {
      const cells: string[] = [];
      for (const c of r[0].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = c[1]!; const inner = c[2] ?? '';
        const type = attr(` ${tag}`, 't'); const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let value = '';
        if (type === 'inlineStr') value = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decode(t[1]!)).join('');
        else if (v !== undefined) value = type === 's' ? shared[Number(v)] ?? '' : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : decode(v);
        cells[colIndex(attr(` ${tag}`, 'r'))] = value.replace(/\s*\n\s*/g, ' ').trim();
      }
      const row = Array.from(cells, (x) => x ?? '');
      if (row.some((x) => x)) rows.push(row);
    }
    if (!rows.length) { warnings.push(`sheet "${name}" is empty and was skipped`); continue; }
    pages.push({ pageNo: 0, text: `Sheet: ${name}\n${tableText(rows)}`, method: 'sheet', needsOcr: false, warnings: [] });
  }
  return { pages, warnings };
}

const slideNo = (p: string) => Number(/(\d+)\.xml$/.exec(p)?.[1] ?? 0);

/** A shape's paragraphs (and table rows) in reading order. */
function shapesText(xml: string, only?: (sp: string) => boolean): string {
  const lines: string[] = [];
  for (const m of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>|<a:tbl>[\s\S]*?<\/a:tbl>/g)) {
    if (m[0].startsWith('<a:tbl>')) {
      lines.push(tableText([...m[0].matchAll(/<a:tr[\s>][\s\S]*?<\/a:tr>/g)].map((r) => [...r[0].matchAll(/<a:tc[\s>][\s\S]*?<\/a:tc>/g)].map((c) => runsText(c[0], 'a').replace(/\s+/g, ' ').trim()))));
      continue;
    }
    if (/<p:ph\b[^>]*type="(sldNum|dt|ftr|sldImg)"/.test(m[0]) || (only && !only(m[0]))) continue;
    for (const p of m[0].matchAll(/<a:p[\s>][\s\S]*?<\/a:p>/g)) { const t = runsText(p[0], 'a').trim(); if (t) lines.push(t); }
  }
  return lines.join('\n');
}

/** One page per slide, with its speaker notes. */
function parsePptx(files: Record<string, Uint8Array>) {
  const pres = entry(files, 'ppt/presentation.xml');
  if (!pres) throw new UnsupportedDocumentError('ppt/presentation.xml is missing');
  const rels = relTargets(files, 'ppt/_rels/presentation.xml.rels', 'ppt');
  let order = [...pres.matchAll(/<p:sldId\s[^>]*>/g)].map((m) => rels.get(attr(m[0], 'r:id'))).filter((p): p is string => !!p && !!files[p]);
  if (!order.length) order = Object.keys(files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => slideNo(a) - slideNo(b));
  const pages: ParsedDocumentPage[] = [];
  for (const path of order) {
    const slide = entry(files, path)!;
    const dir = path.slice(0, path.lastIndexOf('/'));
    const relsPath = `${dir}/_rels/${path.slice(path.lastIndexOf('/') + 1)}.rels`;
    const notesPath = [...relTargets(files, relsPath, dir).values()].find((t) => /notesSlides\/notesSlide\d+\.xml$/.test(t));
    const body = shapesText(slide);
    const notes = notesPath && entry(files, notesPath) ? shapesText(entry(files, notesPath)!, (sp) => /<p:ph\b[^>]*type="body"/.test(sp)) : '';
    const text = [body, notes && `Notes:\n${notes}`].filter(Boolean).join('\n\n');
    // A slide with no text (a picture, say) keeps its number so slide numbers stay true.
    pages.push({ pageNo: 0, text, method: 'slide', needsOcr: false, warnings: text ? [] : ['the slide has no text (it may hold only pictures)'] });
  }
  return { pages, warnings: [] as string[] };
}

// -------------------------------------------------------------------------------------------------------- CSV

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes); // a UTF-8 byte order mark is stripped by the decoder
}

/** RFC 4180 records with quoted fields; the delimiter is the commonest of comma, semicolon and tab on the first line. */
export function parseCsvRecords(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** Chunked pseudo-pages; the header row is repeated at the top of each. */
function parseCsv(bytes: Uint8Array) {
  const rows = parseCsvRecords(decodeText(bytes)).map((r) => r.map((c) => c.replace(/\s*\n\s*/g, ' ').trim()));
  if (!rows.length) return { pages: [] as ParsedDocumentPage[], warnings: ['the file has no rows'] };
  const [header, ...data] = rows as [string[], ...string[][]];
  const head = header.join(' | ');
  const pages: ParsedDocumentPage[] = [];
  let cur: string[] = []; let size = 0;
  const flush = () => { if (cur.length) pages.push({ pageNo: 0, text: [head, ...cur].join('\n'), method: 'table', needsOcr: false, warnings: [] }); cur = []; size = 0; };
  for (const r of data) {
    const line = r.join(' | ');
    if (cur.length && (cur.length >= CSV_PAGE_ROWS || size + line.length > CSV_PAGE_CHARS)) flush();
    cur.push(line); size += line.length + 1;
  }
  flush();
  if (!pages.length) pages.push({ pageNo: 0, text: head, method: 'table', needsOcr: false, warnings: ['the file has a header row only'] });
  return { pages, warnings: [] as string[] };
}
