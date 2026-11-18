// The only place ExcelJS and Papa Parse are imported (one import point per heavy library). Both load on first use so
// they stay out of the main bundle.
import { DATA_COLUMN_TYPE_LABELS, formatCell, type CellValue, type DataColumn, type DataRow } from '@ams/shared';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ARABIC = /[؀-ۿ]/;

/** A file name from a title, keeping Arabic letters. */
export const fileNameFor = (title: string, ext: string) => `${title.normalize('NFC').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'data'}.${ext}`;

/** Header text for a column: its name, with the unit when it has one. */
const header = (c: DataColumn) => (c.unit ? `${c.label} (${c.unit})` : c.label);

/**
 * An Excel workbook with the columns as headers, each column's rule as data validation (lists for choices, numbers,
 * whole numbers, dates), the given rows, and right-to-left when the titles are Arabic. With no rows it is the template.
 */
export async function toXlsx(title: string, columns: DataColumn[], rows: DataRow[]): Promise<Blob> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const rtl = ARABIC.test(title) || columns.some((c) => ARABIC.test(c.label));
  const ws = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1, rightToLeft: rtl }] });
  ws.columns = columns.map((c) => ({ header: header(c), key: c.key, width: Math.min(40, Math.max(12, header(c).length + 4)) }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow(Object.fromEntries(columns.map((c) => {
      const v = r[c.key];
      if (v === null || v === undefined) return [c.key, null];
      if (c.type === 'date' && typeof v === 'string') return [c.key, new Date(`${v}T00:00:00Z`)];
      if (c.type === 'yes_no') return [c.key, formatCell(c, v)];
      return [c.key, v];
    })));
  }
  const last = Math.max(rows.length + 1, 500);
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.type === 'date') col.numFmt = 'yyyy-mm-dd';
    const note = `${DATA_COLUMN_TYPE_LABELS[c.type]}${c.required ? ', required' : ''}`;
    ws.getCell(1, i + 1).note = note;
    const validation = c.type === 'choice' ? { type: 'list' as const, formulae: [`"${(c.choices ?? []).join(',').replace(/"/g, '""')}"`] }
      : c.type === 'yes_no' ? { type: 'list' as const, formulae: ['"Yes,No"'] }
        : c.type === 'integer' ? { type: 'whole' as const, operator: 'between' as const, formulae: [-1e12, 1e12] }
          : c.type === 'number' || c.type === 'percent' ? { type: 'decimal' as const, operator: 'between' as const, formulae: [-1e12, 1e12] }
            : c.type === 'date' ? { type: 'date' as const, operator: 'greaterThan' as const, formulae: [new Date(Date.UTC(1900, 0, 1))] }
              : null;
    if (!validation) return;
    for (let r = 2; r <= last; r++) {
      ws.getCell(r, i + 1).dataValidation = { ...validation, allowBlank: !c.required, showErrorMessage: true, errorTitle: c.label, error: `This cell takes: ${note}` };
    }
  });
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: XLSX_MIME });
}

/** CSV with a byte-order mark, so Excel opens Arabic text correctly. */
export async function toCsv(columns: DataColumn[], rows: DataRow[]): Promise<Blob> {
  const { default: Papa } = await import('papaparse');
  const csv = Papa.unparse({ fields: columns.map(header), data: rows.map((r) => columns.map((c) => formatCell(c, r[c.key]))) });
  return new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
}

export interface Imported {
  /** Rows keyed by column key, with what the file held (checked against the columns afterwards, like typed cells). */
  rows: Record<string, CellValue>[];
  /** Headers in the file that match no column (ignored). */
  ignored: string[];
  /** Columns the file has no header for. */
  missing: string[];
}

const norm = (s: string) => s.normalize('NFC').trim().toLowerCase();
function matchHeaders(columns: DataColumn[], headers: string[]) {
  const byName = new Map<string, DataColumn>();
  for (const c of columns) { byName.set(norm(c.label), c); byName.set(norm(header(c)), c); byName.set(norm(c.key), c); }
  const map = headers.map((h) => byName.get(norm(h)) ?? null);
  return {
    map,
    ignored: headers.filter((h, i) => h.trim() && !map[i]),
    missing: columns.filter((c) => !map.includes(c)).map((c) => c.label),
  };
}

function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error ?? new Error('could not read the file'));
    r.readAsArrayBuffer(file);
  });
}

/** An Excel cell as plain data: dates as yyyy-mm-dd, formulas as their result, rich text as its text. */
function cellValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { result?: unknown; richText?: { text: string }[]; text?: string; hyperlink?: string };
    if ('result' in o) return cellValue(o.result);
    if (o.richText) return o.richText.map((t) => t.text).join('');
    if (typeof o.text === 'string') return o.text;
    return null;
  }
  return v as CellValue;
}

/** Reads the first sheet of an .xlsx, or a .csv (comma, semicolon, tab or bar), matching headers to columns by name. */
export async function importSheet(file: File, columns: DataColumn[]): Promise<Imported> {
  const isCsv = /\.(csv|tsv|txt)$/i.test(file.name) || file.type.startsWith('text/');
  let headers: string[] = [];
  let body: CellValue[][] = [];
  if (isCsv) {
    const { default: Papa } = await import('papaparse');
    const text = new TextDecoder('utf-8').decode(await readBytes(file)).replace(/^\uFEFF/, '');
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy', delimitersToGuess: [',', ';', '\t', '|'] });
    [headers = [], ...body] = parsed.data as CellValue[][] as string[][];
  } else {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await readBytes(file));
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('the workbook has no sheets');
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const values = (row.values as unknown[]).slice(1).map(cellValue);
      if (n === 1) headers = values.map((v) => (v === null ? '' : String(v)));
      else body.push(values);
    });
  }
  if (!headers.length) throw new Error('the file is empty');
  const { map, ignored, missing } = matchHeaders(columns, headers.map(String));
  if (map.every((m) => !m)) throw new Error(`none of the headers match the columns (${columns.map((c) => c.label).join(', ')})`);
  const rows = body.map((cells) => {
    const r: Record<string, CellValue> = {};
    map.forEach((c, i) => { if (c) r[c.key] = cells[i] ?? null; });
    return r;
  }).filter((r) => Object.values(r).some((v) => v !== null && v !== ''));
  return { rows, ignored, missing };
}

/** Reads the named sheets of an .xlsx as rows keyed by their header text (formulas give their last computed value). */
export async function readSheets(file: File, names: string[]): Promise<Record<string, Record<string, string>[]>> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await readBytes(file));
  const out: Record<string, Record<string, string>[]> = {};
  for (const name of names) {
    const ws = wb.getWorksheet(name);
    if (!ws) continue;
    let headers: string[] = [];
    const rows: Record<string, string>[] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const values = (row.values as unknown[]).slice(1).map(cellValue).map((v) => (v === null || v === undefined ? '' : String(v).trim()));
      if (n === 1) { headers = values; return; }
      const r: Record<string, string> = {};
      headers.forEach((h, i) => { if (h) r[h] = values[i] ?? ''; });
      if (Object.values(r).some(Boolean)) rows.push(r);
    });
    out[name] = rows;
  }
  return out;
}

/** Hands the browser a file to save. */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Reads a .csv (comma, semicolon, tab or bar) as rows keyed by their header text, and the headers. */
export async function readCsvRows(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const { default: Papa } = await import('papaparse');
  const text = new TextDecoder('utf-8').decode(await readBytes(file)).replace(/^\uFEFF/, '');
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy', delimitersToGuess: [',', ';', '\t', '|'] });
  const [headers = [], ...body] = parsed.data as string[][];
  const rows = body.map((cells) => Object.fromEntries(headers.map((h, i) => [h.trim(), (cells[i] ?? '').trim()]))).filter((r) => Object.values(r).some(Boolean));
  return { headers: headers.map((h) => h.trim()), rows };
}

/** One sheet as a .csv (UTF-8 with a byte-order mark, so spreadsheet programs read Arabic correctly). */
export async function rowsToCsv(headers: readonly string[], rows: Record<string, unknown>[]): Promise<Blob> {
  const { default: Papa } = await import('papaparse');
  const text = Papa.unparse({ fields: [...headers], data: rows.map((r) => headers.map((h) => (r[h] === null || r[h] === undefined ? '' : String(r[h])))) });
  return new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' });
}

/** A column of a rich sheet: its header, how wide, how it looks, and what Excel checks as it is typed. */
export interface RichColumn {
  header: string;
  width?: number;
  /** Marked with * and a tinted header. */ required?: boolean;
  /** A grey column the person should leave as it is (an ID, a lookup). */ grey?: boolean;
  /** Long text: wrapped. */ wrap?: boolean;
  /** Right-to-left text (Arabic). */ rtl?: boolean;
  /** A dropdown from a range ("Lists!$A$2:$A$9"), or whole/decimal numbers between bounds. */
  check?: { list: string } | { whole: [number, number] } | { decimal: [number, number] };
  /** A note on the header (what to type, the codes it takes). */ note?: string;
  /** A formula for the given row number (a lookup shown beside the data). */
  formula?: (row: number) => string;
}
export interface RichSheet {
  name: string;
  state?: 'visible' | 'hidden';
  /** Text lines (a README): `#` starts a heading. */
  lines?: string[];
  columns?: RichColumn[];
  rows?: Record<string, unknown>[];
  /** Rows prepared (checks and formulas) below the data, for new entries. */
  spare?: number;
}

/**
 * A workbook of rich sheets (templates people fill in): headers frozen with the first column, required headers marked, dropdowns and
 * number checks on every row up to the spare ones, lookup formulas, wrapped and right-to-left text where asked, and README sheets of text.
 */
export async function richWorkbookXlsx(sheets: RichSheet[]): Promise<Blob> {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = book.addWorksheet(s.name, { state: s.state ?? 'visible', views: [{ state: 'frozen', ySplit: s.lines ? 0 : 1, xSplit: s.lines ? 0 : 1 }] });
    if (s.lines) {
      ws.columns = [{ width: 120 }];
      for (const line of s.lines) {
        const r = ws.addRow([line.replace(/^#+\s*/, '')]);
        r.getCell(1).alignment = { wrapText: true, vertical: 'top' };
        if (line.startsWith('#')) r.getCell(1).font = { bold: true, size: line.startsWith('##') ? 12 : 14 };
      }
      continue;
    }
    const cols = s.columns ?? [];
    ws.columns = cols.map((c) => ({ header: c.required ? `${c.header} *` : c.header, key: c.header, width: c.width ?? Math.min(48, Math.max(12, c.header.length + 4)) }));
    const head = ws.getRow(1);
    head.font = { bold: true };
    cols.forEach((c, i) => {
      const cell = head.getCell(i + 1);
      const fill = c.grey ? 'FFE5E7EB' : c.required ? 'FFFDE68A' : 'FFF3F4F6';
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.alignment = { vertical: 'middle', wrapText: true };
      if (c.grey) cell.note = 'Filled in by the system: leave it as it is (empty for a new row).';
      else if (c.note) cell.note = c.note;
    });
    const rows = s.rows ?? [];
    for (const r of rows) ws.addRow(Object.fromEntries(cols.map((c) => [c.header, r[c.header] ?? null])));
    const last = rows.length + 1 + (s.spare ?? 0);
    cols.forEach((c, i) => {
      const letter = ws.getColumn(i + 1).letter;
      const range = `${letter}2:${letter}${last}`;
      if (c.check) {
        const v = 'list' in c.check
          ? { type: 'list', allowBlank: true, formulae: [c.check.list], showErrorMessage: true, errorStyle: 'stop', errorTitle: c.header, error: `Pick ${c.header} from the list.` }
          : 'whole' in c.check
            ? { type: 'whole', operator: 'between', allowBlank: true, formulae: c.check.whole, showErrorMessage: true, errorTitle: c.header, error: `A whole number from ${c.check.whole[0]} to ${c.check.whole[1]}.` }
            : { type: 'decimal', operator: 'between', allowBlank: true, formulae: c.check.decimal, showErrorMessage: true, errorTitle: c.header, error: `A number from ${c.check.decimal[0]} to ${c.check.decimal[1]}.` };
        (ws as unknown as { dataValidations: { add: (a: string, v: unknown) => void } }).dataValidations.add(range, v);
      }
      for (let n = 2; n <= last; n += 1) {
        const cell = ws.getCell(n, i + 1);
        if (c.formula) cell.value = { formula: c.formula(n), result: (cell.value as string | null) ?? '' } as never;
        if (c.wrap || c.rtl) cell.alignment = { wrapText: !!c.wrap, vertical: 'top', ...(c.rtl ? { horizontal: 'right', readingOrder: 'rtl' } : {}) };
        if (c.grey) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      }
    });
  }
  return new Blob([await book.xlsx.writeBuffer()], { type: XLSX_MIME });
}
