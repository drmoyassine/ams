// Import and export for data evidence: what goes out as Excel or CSV comes back the same, Arabic included.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { validateRows, type DataColumn } from '@ams/shared';
import { importSheet, toCsv, toXlsx } from './sheet-io';

const columns: DataColumn[] = [
  { key: 'program', label: 'البرنامج', type: 'text', required: true },
  { key: 'year', label: 'Year', type: 'choice', required: false, choices: ['2023-24', '2024-25'] },
  { key: 'retention', label: 'Retention', type: 'percent', unit: '%', required: false },
  { key: 'census', label: 'Census date', type: 'date', required: false },
  { key: 'online', label: 'Online', type: 'yes_no', required: false },
];
const rows = [
  { program: 'هندسة ميكانيكية', year: '2024-25', retention: 82.5, census: '2024-10-15', online: false },
  { program: 'BS Civil', year: '2023-24', retention: 79, census: null, online: true },
];
const asFile = async (b: Blob, name: string) => new File([await b.arrayBuffer()], name, { type: b.type });

describe('sheet import and export', () => {
  it('round-trips through Excel, with a right-to-left sheet and validation', async () => {
    const xlsx = await toXlsx('الاستبقاء', columns, rows);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await xlsx.arrayBuffer());
    const ws = wb.worksheets[0]!;
    expect(ws.views[0]?.rightToLeft).toBe(true);
    expect(ws.getCell('C1').value).toBe('Retention (%)');
    expect(ws.getCell('B2').dataValidation).toMatchObject({ type: 'list', formulae: ['"2023-24,2024-25"'] });
    const back = await importSheet(await asFile(xlsx, 'r.xlsx'), columns);
    expect(back.ignored).toEqual([]);
    expect(validateRows(columns, back.rows)).toEqual({ rows, issues: [] });
  });

  it('round-trips through CSV with a byte-order mark', async () => {
    const csv = await toCsv(columns, rows);
    const back = await importSheet(await asFile(csv, 'r.csv'), columns);
    expect(validateRows(columns, back.rows)).toEqual({ rows, issues: [] });
  });

  it('reads semicolon CSV, matches headers by name and reports the rest', async () => {
    const file = new File(['Year;البرنامج;Notes\n2024-25;هندسة;x\n'], 'semi.csv', { type: 'text/csv' });
    const back = await importSheet(file, columns);
    expect(back.rows).toEqual([{ year: '2024-25', program: 'هندسة' }]);
    expect(back.ignored).toEqual(['Notes']);
    expect(back.missing).toEqual(['Retention', 'Census date', 'Online']);
  });

  it('refuses a file whose headers match nothing', async () => {
    await expect(importSheet(new File(['a,b\n1,2\n'], 'x.csv', { type: 'text/csv' }), columns)).rejects.toThrow(/none of the headers match/);
  });
});
