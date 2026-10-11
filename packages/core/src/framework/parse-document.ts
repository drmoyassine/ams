// parseDocument(): the ONE place the AMS reads a file into per-page text (DEC-011, PRD 15.1 step 3).
//
// - EVERY format goes through liteparse (the only import of it in the repository): PDF directly; Office and OpenDocument
//   files, RTF, spreadsheets and CSV are converted to PDF by liteparse itself with LibreOffice (the parser image has
//   it); images are rendered by liteparse (ImageMagick for the formats PDFium cannot read). No other format library.
// - liteparse's own OCR is switched off. Its per-page verdict (`complexity.needsOcr` with reasons: scanned, no-text,
//   garbled, ...) decides `needsOcr`; if the caller injects an `ocrPage` hook (aiOcr, Step B) it is called with the
//   rendered page image. No model is called from this file.
// - Pages are what liteparse returns: real pages for PDF, a page per slide for presentations, the printed pages of the
//   converted document for DOCX/ODT/RTF, the printed pages of each sheet for spreadsheets and CSV, one page per image.
// Host-agnostic: bytes in, pages out. Text is NFC (Arabic is first-class content).
import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { LiteParse, ParseTimeoutError, type LiteParseConfig, type ParseResult } from '@llamaindex/liteparse';

export type PageMethod = 'pdf_text' | 'ocr' | 'table' | 'slide' | 'sheet';
export type DocumentFormat =
  | 'pdf' | 'docx' | 'doc' | 'odt' | 'rtf' | 'xlsx' | 'xls' | 'ods' | 'csv' | 'tsv' | 'pptx' | 'ppt' | 'odp'
  | 'png' | 'jpg' | 'tiff' | 'webp' | 'bmp' | 'gif';

export interface ParsedDocumentPage {
  pageNo: number;
  text: string;
  /** pdf_text: the text layer (or converted document text); slide/sheet/table: the page of a presentation/spreadsheet/CSV; ocr: read by the OCR hook. */
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
  /** Document-level notes (e.g. pages beyond the page cap were not read). */
  warnings: string[];
}

export type DocumentReadErrorCode = 'unsupported' | 'corrupt' | 'converter_missing' | 'timeout';

/** A file that cannot be read, with a reason a person can act on. Recorded on the document; never retried. */
export class DocumentReadError extends Error {
  readonly status = 400;
  constructor(readonly code: DocumentReadErrorCode, message: string) { super(message); this.name = 'DocumentReadError'; }
}
export class UnsupportedDocumentError extends DocumentReadError {
  constructor(message: string) { super('unsupported', message); this.name = 'UnsupportedDocumentError'; }
}

/** A page with fewer non-space characters than this is treated as having no text layer. */
export const MIN_PAGE_TEXT_CHARS = 20;
/** Per-file limits (env-tunable on the parser service). */
const timeoutMs = () => Math.max(0.001, Number(process.env.PARSER_TIMEOUT_SECONDS ?? 300)) * 1000;
const maxPages = () => Math.max(1, Number(process.env.PARSER_MAX_PAGES ?? 1000));

type Kind = 'pdf' | 'text' | 'sheet' | 'slides' | 'image';
const FORMATS: Record<DocumentFormat, { kind: Kind; ext: string[]; mime: string[] }> = {
  pdf: { kind: 'pdf', ext: ['pdf'], mime: ['application/pdf'] },
  docx: { kind: 'text', ext: ['docx'], mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  doc: { kind: 'text', ext: ['doc'], mime: ['application/msword'] },
  odt: { kind: 'text', ext: ['odt'], mime: ['application/vnd.oasis.opendocument.text'] },
  rtf: { kind: 'text', ext: ['rtf'], mime: ['application/rtf', 'text/rtf'] },
  xlsx: { kind: 'sheet', ext: ['xlsx'], mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
  xls: { kind: 'sheet', ext: ['xls'], mime: ['application/vnd.ms-excel'] },
  ods: { kind: 'sheet', ext: ['ods'], mime: ['application/vnd.oasis.opendocument.spreadsheet'] },
  csv: { kind: 'sheet', ext: ['csv'], mime: ['text/csv', 'application/csv'] },
  tsv: { kind: 'sheet', ext: ['tsv'], mime: ['text/tab-separated-values'] },
  pptx: { kind: 'slides', ext: ['pptx'], mime: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] },
  ppt: { kind: 'slides', ext: ['ppt'], mime: ['application/vnd.ms-powerpoint'] },
  odp: { kind: 'slides', ext: ['odp'], mime: ['application/vnd.oasis.opendocument.presentation'] },
  png: { kind: 'image', ext: ['png'], mime: ['image/png'] },
  jpg: { kind: 'image', ext: ['jpg', 'jpeg'], mime: ['image/jpeg'] },
  tiff: { kind: 'image', ext: ['tif', 'tiff'], mime: ['image/tiff'] },
  webp: { kind: 'image', ext: ['webp'], mime: ['image/webp'] },
  bmp: { kind: 'image', ext: ['bmp'], mime: ['image/bmp'] },
  gif: { kind: 'image', ext: ['gif'], mime: ['image/gif'] },
};
const ALL = Object.keys(FORMATS) as DocumentFormat[];
const byExt = new Map(ALL.flatMap((f) => FORMATS[f].ext.map((e) => [e, f] as const)));
const byMime = new Map(ALL.flatMap((f) => FORMATS[f].mime.map((m) => [m, f] as const)));

/** The file types a source can be read from: used by the upload allowlist and the file pickers. */
export const SOURCE_EXTENSIONS = ALL.flatMap((f) => FORMATS[f].ext);
export const SOURCE_MIME_TYPES = ALL.flatMap((f) => FORMATS[f].mime);
export const UNSUPPORTED_FILE_MESSAGE = 'this file type cannot be read; use PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV or an image (PNG, JPEG, TIFF, WebP)';

const has = (b: Uint8Array, s: string, at = 0) => s.split('').every((ch, i) => b[at + i] === ch.charCodeAt(0));
const contains = (b: Uint8Array, s: string) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).includes(s);

/** Decides the format from the file name, then the mime type, then the content itself. */
export function detectFormat(input: Pick<ParseDocumentInput, 'bytes' | 'mime' | 'fileName'>): DocumentFormat | null {
  const ext = input.fileName?.split('.').pop()?.toLowerCase();
  if (ext && byExt.has(ext)) return byExt.get(ext)!;
  const mime = input.mime?.split(';')[0]?.trim().toLowerCase();
  if (mime && byMime.has(mime)) return byMime.get(mime)!;
  const b = input.bytes;
  if (has(b, '%PDF-')) return 'pdf';
  if (has(b, '\x89PNG')) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (has(b, 'GIF8')) return 'gif';
  if (has(b, 'RIFF') && has(b, 'WEBP', 8)) return 'webp';
  if (has(b, '{\\rtf')) return 'rtf';
  if ((has(b, 'II') && b[2] === 42) || (has(b, 'MM') && b[3] === 42)) return 'tiff';
  if (has(b, 'PK')) {
    const head = b.subarray(0, Math.min(b.length, 1 << 20));
    if (contains(head, 'word/document.xml')) return 'docx';
    if (contains(head, 'xl/workbook.xml')) return 'xlsx';
    if (contains(head, 'ppt/presentation.xml')) return 'pptx';
    if (contains(head, 'application/vnd.oasis.opendocument.text')) return 'odt';
    if (contains(head, 'application/vnd.oasis.opendocument.spreadsheet')) return 'ods';
    if (contains(head, 'application/vnd.oasis.opendocument.presentation')) return 'odp';
  }
  return null;
}

// ------------------------------------------------------------------------------------------ LibreOffice check

/** The LibreOffice binary liteparse will use (`soffice` or `libreoffice` on PATH), or null. Used for the startup log. */
export async function findLibreOffice(): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of ['libreoffice', 'soffice']) {
      try { await access(join(dir, name), constants.X_OK); return join(dir, name); } catch { /* next */ }
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------- parsing

const nfc = (s: string) => s.normalize('NFC');

/** Replacement characters or private-use glyphs in bulk mean the embedded text layer is corrupted (LP3). */
function garbled(text: string): boolean {
  const chars = [...text.replace(/\s/g, '')];
  if (chars.length < MIN_PAGE_TEXT_CHARS) return false;
  const bad = chars.filter((c) => c === '�' || (c >= '' && c <= '') || c.charCodeAt(0) < 32).length;
  return bad / chars.length > 0.3;
}

/** Reads a file into ordered pages. Throws DocumentReadError (UnsupportedDocumentError for a type it cannot read). */
export async function parseDocument(input: ParseDocumentInput): Promise<ParsedDocument> {
  const format = detectFormat(input);
  if (!format) throw new UnsupportedDocumentError(UNSUPPORTED_FILE_MESSAGE);
  if (!input.bytes.byteLength) throw new UnsupportedDocumentError('the file is empty');
  const kind = FORMATS[format].kind;
  checkSignature(format, input.bytes);
  const source = await prepareSource(format, input.bytes);
  try {
    const run = (extra: Partial<LiteParseConfig> = {}) => liteparse(format, source.input, extra);
    const result = await run({ includeComplexity: true } as Partial<LiteParseConfig>);
    const errors = new Map(result.pageErrors.map((e) => [e.pageNum, e.message]));
    const pages = result.pages.map((p) => readPage(p as unknown as LiteParsePage, format, kind, errors.get(p.pageNum)));
    const warnings: string[] = [];
    if (result.totalPages > result.pages.length) warnings.push(`only the first ${result.pages.length} of ${result.totalPages} pages were read (PARSER_MAX_PAGES)`);
    if (input.ocrPage) await runOcrHook(input, pages, (extra) => run(extra));
    return { format, pages: pages.map((p) => ({ ...p, text: nfc(p.text) })), warnings };
  } finally {
    await source.cleanup();
  }
}

interface LiteParsePage { pageNum: number; text: string; complexity?: { needsOcr: boolean; reasons: string[] } }

/** Magic-number checks, so a renamed or truncated file is a clear error and not a mis-read (LibreOffice would open plain text as a document). */
function checkSignature(format: DocumentFormat, b: Uint8Array) {
  const bad = (what: string) => new DocumentReadError('corrupt', `the ${format.toUpperCase()} file could not be read: it is not a valid ${what}`);
  if (format === 'pdf' && !contains(b.subarray(0, 1024), '%PDF-')) throw bad('PDF');
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(format) && !has(b, 'PK')) throw bad('Office/OpenDocument (zip) file');
  if (['doc', 'xls', 'ppt'].includes(format) && !(b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0)) throw bad('Office file');
  if (format === 'rtf' && !has(b, '{\\rtf')) throw bad('RTF file');
}

// CSV/TSV: liteparse picks text formats by file extension and LibreOffice splits only on commas here, so the delimiter is
// normalised to a comma first (quotes honoured). That is the only pre-processing; the reading is liteparse's.
function toCommaCsv(bytes: Uint8Array): Uint8Array {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  else text = new TextDecoder('utf-8').decode(bytes);
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  if (delim === ',' && !(bytes[0] === 0xff || bytes[0] === 0xfe)) return bytes;
  const out: string[] = []; let field = ''; let row: string[] = []; let quoted = false;
  // A field keeps its own quotes; an unquoted one that holds a comma (the file's delimiter was another character) gets them.
  const fin = (f: string) => (f.startsWith('"') || !f.includes(',') ? f : `"${f}"`);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { field += '""'; i++; } else { quoted = false; field += ch; } } else field += ch; }
    else if (ch === '"' && field === '') { quoted = true; field += ch; }
    else if (ch === delim) { row.push(fin(field)); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(fin(field)); field = ''; out.push(row.join(',')); row = []; }
    else field += ch;
  }
  if (field || row.length) { row.push(fin(field)); out.push(row.join(',')); }
  return new TextEncoder().encode(`${out.join('\n')}\n`);
}

/** What is handed to liteparse: the bytes (it recognises the type from the content), or a temp file for CSV/TSV. */
async function prepareSource(format: DocumentFormat, bytes: Uint8Array): Promise<{ input: string | Uint8Array; cleanup: () => Promise<void> }> {
  if (format !== 'csv' && format !== 'tsv') return { input: bytes, cleanup: async () => undefined };
  const dir = await mkdtemp(join(tmpdir(), 'ams-parse-'));
  const path = join(dir, `${CSV_STEM}.csv`);
  await writeFile(path, toCommaCsv(bytes));
  return { input: path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const CSV_STEM = 'ams_csv_input';

/** One liteparse call in a killable worker process, so a runaway conversion cannot stall or crash the parser. */
async function liteparse(format: DocumentFormat, input: string | Uint8Array, extra: Partial<LiteParseConfig>): Promise<ParseResult> {
  const parser = new LiteParse({
    ocrEnabled: false, quiet: true, continueOnPageError: true, outputFormat: 'json',
    maxPages: maxPages(), poolSize: 1, parseTimeoutMs: timeoutMs(), ...extra,
  } as Partial<LiteParseConfig>);
  try {
    return await parser.parse(input as Buffer | string);
  } catch (e) {
    throw mapError(format, e);
  } finally {
    parser.close();
  }
}

function mapError(format: DocumentFormat, e: unknown): DocumentReadError {
  if (e instanceof DocumentReadError) return e;
  const name = format.toUpperCase();
  if (e instanceof ParseTimeoutError) return new DocumentReadError('timeout', `the ${name} file took longer than ${Math.round(e.timeoutMs / 1000)} seconds to read and was stopped`);
  const msg = String((e as Error)?.message ?? e).replace(/^liteparse worker process died while parsing [^:]*: /, '');
  if (/libreoffice is not installed/i.test(msg)) {
    return new DocumentReadError('converter_missing', `LibreOffice is not installed on the parser service, so ${name} files cannot be read (install libreoffice-core with writer, calc and impress; the parser image includes them)`);
  }
  if (/magick/i.test(msg)) return new DocumentReadError('converter_missing', `ImageMagick is not installed on the parser service, so ${name} files cannot be read (the parser image includes it): ${msg}`);
  return new DocumentReadError('corrupt', `the ${name} file could not be read (${msg})`);
}

const HARD_REASONS = ['scanned', 'garbled'];
const SOFT_REASONS = ['embedded-images', 'vector-text', 'annotation-text'];

function readPage(p: LiteParsePage, format: DocumentFormat, kind: Kind, error?: string): ParsedDocumentPage {
  let text = (p.text ?? '').trim();
  const warnings: string[] = [];
  if (error) warnings.push(`page could not be read: ${error}`);
  if (kind === 'sheet') text = tidySheet(text, format);
  const reasons = p.complexity?.reasons ?? [];
  const chars = text.replace(/\s/g, '').length;
  const corrupt = kind === 'pdf' && garbled(text);
  if (corrupt) { text = ''; warnings.push('the text layer looks corrupted'); }
  // Pages that are pictures: scanned/garbled by liteparse's own verdict; a PDF page with (almost) no text is one too.
  // A converted document's short page (a title slide, a heading) is not: its text is exact, so it is not sent to OCR.
  const hard = reasons.filter((r) => HARD_REASONS.includes(r) && !(kind !== 'pdf' && kind !== 'image' && r === 'garbled'));
  const needsOcr = corrupt || hard.length > 0 || ((kind === 'pdf' || kind === 'image') && chars < MIN_PAGE_TEXT_CHARS);
  if (needsOcr) warnings.push(`needs OCR: ${(corrupt ? ['garbled', ...hard] : hard.length ? hard : [chars ? 'sparse-text' : 'no-text']).join(', ')}`);
  else if (!chars) warnings.push(kind === 'slides' ? 'the slide has no text (it may hold only pictures)' : 'the page has no text');
  const soft = reasons.filter((r) => SOFT_REASONS.includes(r));
  if (soft.length && !needsOcr) warnings.push(`the page has content that may not be in its text (${soft.join(', ')})`);
  const method: PageMethod = kind === 'slides' ? 'slide' : kind === 'sheet' ? (format === 'csv' || format === 'tsv' ? 'table' : 'sheet') : 'pdf_text';
  return { pageNo: p.pageNum, text, method, needsOcr, warnings };
}

/** The printed page of a sheet: drops LibreOffice's default "Page N" footer, the temp CSV's name header and the alignment indent of each line. */
function tidySheet(text: string, format: DocumentFormat): string {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const trim = () => { while (lines.length && !lines.at(-1)) lines.pop(); while (lines.length && !lines[0]) lines.shift(); };
  trim();
  if (lines.length && /^\s*Page \d+$/.test(lines.at(-1)!)) { lines.pop(); trim(); }
  if ((format === 'csv' || format === 'tsv') && lines[0]?.trim() === CSV_STEM) { lines.shift(); trim(); }
  return lines.map((l) => l.trim()).join('\n');
}

/** Renders the pages that need OCR and hands each to the injected hook. A failure leaves the page marked needsOcr. */
async function runOcrHook(input: ParseDocumentInput, pages: ParsedDocumentPage[], run: (extra: Partial<LiteParseConfig>) => Promise<ParseResult>) {
  const all = pages.filter((p) => p.needsOcr);
  if (!all.length || !input.ocrPage) return;
  const limit = input.ocrMaxPages ?? Number.POSITIVE_INFINITY;
  const wanted = all.slice(0, limit);
  for (const p of all.slice(limit)) p.warnings.push(`not read by AI: the limit of ${limit} AI-read pages per file is reached (Settings -> AI)`);
  if (!wanted.length) return;
  let shots: Map<number, { imageBuffer: Buffer | Uint8Array }>;
  try {
    shots = new Map((await run({ extractScreenshots: true, targetPages: wanted.map((p) => p.pageNo).join(',') })).screenshots.map((s) => [s.pageNum, s]));
  } catch (e) {
    for (const p of wanted) p.warnings.push(`the page could not be rendered for OCR: ${(e as Error).message}`);
    return;
  }
  for (const p of wanted) {
    const shot = shots.get(p.pageNo);
    if (!shot) { p.warnings.push('the page could not be rendered for OCR'); continue; }
    try {
      const text = (await input.ocrPage({ pageNo: p.pageNo, image: new Uint8Array(shot.imageBuffer), language: input.language ?? 'en', text: p.text }))?.trim();
      if (text) { p.text = text; p.method = 'ocr'; p.needsOcr = false; } else p.warnings.push('OCR returned no text');
    } catch (e) { p.warnings.push(`OCR failed: ${(e as Error).message}`); }
  }
}
