import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PROGRAM_SHEETS, sheetOfHeaders, type ProgramSheetKey, type ProgramsWorkbook, type UpsertProgramsResult } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { useProgramsApi, type ProgramsApi } from '../../lib/programs-api';
import { download, readCsvRows, readSheets, rowsToCsv, sheetsToXlsx } from '../../lib/sheet-io';
import { useAction } from '../../lib/use-action';

const KEYS = Object.keys(PROGRAM_SHEETS) as ProgramSheetKey[];
const empty = (): ProgramsWorkbook => ({ programs: [], peos: [], plos: [] });

/** Reads an .xlsx (sheets Programs, PEOs, PLOs) or one or more .csv files (each sheet's file, told apart by its headers). */
export async function readProgramFiles(files: File[]): Promise<{ workbook: ProgramsWorkbook; ignored: string[] }> {
  const wb = empty(); const ignored: string[] = [];
  for (const f of files) {
    if (/\.(csv|tsv|txt)$/i.test(f.name)) {
      const { headers, rows } = await readCsvRows(f);
      const k = sheetOfHeaders(headers);
      if (!k) { ignored.push(f.name); continue; }
      wb[k].push(...rows);
    } else {
      const sheets = await readSheets(f, KEYS.map((k) => PROGRAM_SHEETS[k].name));
      for (const k of KEYS) wb[k].push(...(sheets[PROGRAM_SHEETS[k].name] ?? []));
    }
  }
  return { workbook: wb, ignored };
}

async function save(wb: ProgramsWorkbook, format: 'xlsx' | 'csv', base: string) {
  if (format === 'xlsx') { download(await sheetsToXlsx(KEYS.map((k) => ({ name: PROGRAM_SHEETS[k].name, headers: PROGRAM_SHEETS[k].headers, rows: wb[k] }))), `${base}.xlsx`); return; }
  for (const k of KEYS) download(await rowsToCsv(PROGRAM_SHEETS[k].headers, wb[k]), `${base} - ${PROGRAM_SHEETS[k].name}.csv`);
}

const ACTION = { add: 'Add', update: 'Update', unchanged: 'No change', skip: 'Skipped' } as const;

/**
 * Programs as a workbook (the owner, 2026-11-16): download the template or every program (with PEOs and PLOs) as .xlsx or .csv, and import
 * one back. An import is previewed row by row first; applying adds and updates by Program code and never removes anything.
 */
export function ProgramsImportExport({ canWrite, api: override, onDone }: { canWrite: boolean; api?: ProgramsApi; onDone: () => void }) {
  const api = useProgramsApi(override);
  const qc = useQueryClient();
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [pending, setPending] = useState<{ workbook: ProgramsWorkbook; names: string; ignored: string[] } | null>(null);
  const [result, setResult] = useState<UpsertProgramsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await act(fn); } finally { setBusy(false); } };
  return (
    <Card>
      <section aria-label="Import and export programs" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-semibold">Import and export</h4>
          <Button type="button" variant="ghost" className="px-2 py-1" onClick={onDone}>Close</Button>
        </div>
        <p className="text-sm text-muted-foreground">One template with three sheets (Programs, PEOs, PLOs), as an Excel workbook or as three CSV files. Rows are matched by Program code: a match is updated, anything else is added, nothing is removed, and an empty cell leaves a field as it is.</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">Format
            <select aria-label="File format" className="h-9 rounded-md border border-border bg-background px-2 text-sm" value={format} onChange={(e) => setFormat(e.target.value as 'xlsx' | 'csv')}>
              <option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV (one file per sheet)</option>
            </select>
          </label>
          <Button type="button" variant="outline" className="px-3 py-1" disabled={busy} onClick={() => { void run(() => save(empty(), format, 'Programs template')); }}>Download the template</Button>
          <Button type="button" variant="outline" className="px-3 py-1" disabled={busy} onClick={() => { void run(async () => save(await api.exportAll(), format, 'Programs')); }}>Export all programs</Button>
        </div>
        {canWrite && (
          <label className="flex flex-wrap items-center gap-2 text-sm">Import a file
            <input aria-label="Programs file" type="file" multiple accept=".xlsx,.csv" className="text-sm" disabled={busy}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]; e.target.value = '';
                if (!files.length) return;
                void run(async () => {
                  const { workbook, ignored } = await readProgramFiles(files);
                  setPending({ workbook, names: files.map((f) => f.name).join(', '), ignored });
                  setResult(await api.upsert(workbook, false));
                });
              }} />
          </label>
        )}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {result && (
          <div className="space-y-2" role="region" aria-label={result.applied ? 'Import result' : 'Import preview'}>
            <p className="text-sm font-medium">{result.applied ? 'Imported' : `Preview of ${pending?.names ?? 'the file'}`}: {result.added} to add, {result.updated} to update, {result.unchanged} unchanged, {result.skipped} skipped.</p>
            {pending && pending.ignored.length > 0 && <p className="text-xs text-amber-800">Not a sheet of the template (ignored): {pending.ignored.join(', ')}.</p>}
            <div className="max-h-80 overflow-auto rounded-md border border-border">
              <table className="w-full text-sm" aria-label="Rows">
                <thead><tr className="text-start text-xs text-muted-foreground"><th className="px-2 py-1 text-start">Sheet</th><th className="px-2 py-1 text-start">Row</th><th className="px-2 py-1 text-start">Code</th><th className="px-2 py-1 text-start">What</th><th className="px-2 py-1 text-start">Note</th></tr></thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="px-2 py-1">{r.sheet}</td><td className="px-2 py-1">{r.row}</td><td className="px-2 py-1 font-mono">{r.code}</td>
                      <td className={`px-2 py-1 ${r.action === 'skip' ? 'text-red-800' : ''}`}>{ACTION[r.action]}</td><td className="px-2 py-1 text-xs">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!result.applied && pending && canWrite && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={busy || result.added + result.updated === 0} onClick={() => { void run(async () => { setResult(await api.upsert(pending.workbook, true)); setPending(null); await qc.invalidateQueries({ queryKey: ['programs'] }); await qc.invalidateQueries({ queryKey: ['program-outcomes'] }); }); }}>Apply</Button>
                <Button type="button" variant="ghost" onClick={() => { setPending(null); setResult(null); }}>Cancel</Button>
              </div>
            )}
          </div>
        )}
      </section>
    </Card>
  );
}
