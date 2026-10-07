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

/** Hands the browser a file to save. */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
