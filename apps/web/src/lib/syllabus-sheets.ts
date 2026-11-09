// The syllabus workbook in the browser (TASK-126): reading an .xlsx into the rows the API takes, and writing a syllabus (or an empty template)
// as an .xlsx with the same six sheets. The conversion between rows and a syllabus lives in @ams/shared, so the import, the export and the
// API agree.
import { SYLLABUS_SHEETS, emptyWorkbook, type SheetKey, type SheetRow, type SyllabusWorkbook } from '@ams/shared';
import { readSheets } from './sheet-io';

const KEYS = Object.keys(SYLLABUS_SHEETS) as SheetKey[];

/** The rows of the workbook's six sheets (a missing sheet is empty). */
export async function readSyllabusWorkbook(file: File): Promise<SyllabusWorkbook> {
  const sheets = await readSheets(file, KEYS.map((k) => SYLLABUS_SHEETS[k].name));
  const wb = emptyWorkbook();
  for (const k of KEYS) wb[k] = (sheets[SYLLABUS_SHEETS[k].name] ?? []) as SheetRow[];
  return wb;
}

/** A workbook with the six sheets: the headers, a frozen first row, and the rows given (none for the template). */
export async function writeSyllabusWorkbook(wb: SyllabusWorkbook): Promise<Blob> {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  for (const k of KEYS) {
    const { name, headers } = SYLLABUS_SHEETS[k];
    const ws = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.min(48, Math.max(14, h.length + 4)) }));
    ws.getRow(1).font = { bold: true };
    for (const r of wb[k]) ws.addRow(r);
  }
  return new Blob([await book.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
