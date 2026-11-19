import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ACADEMIC_SHEETS, ACADEMIC_SHEET_ORDER, academicSheetOfHeaders, emptyAcademicWorkbook, type AcademicExport, type AcademicWorkbook, type UpsertAcademicResult } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { useAcademicApi, type AcademicApi } from '../../lib/academic-api';
import { academicWorkbookSheets } from '../../lib/academic-template';
import { download, readCsvRows, readSheets, richWorkbookXlsx, rowsToCsv } from '../../lib/sheet-io';
import { useAction } from '../../lib/use-action';

/** A row with its headers as the template names them (without the * that marks a required column). */
const clean = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/\s*\*\s*$/, ''), v]));

/** Reads an .xlsx (the workbook's sheets; "Placement" is the Study plan of older files) or one or more .csv files (each told apart by its headers). */
export async function readAcademicFiles(files: File[]): Promise<{ workbook: AcademicWorkbook; ignored: string[] }> {
  const wb = emptyAcademicWorkbook(); const ignored: string[] = [];
  for (const f of files) {
    if (/\.(csv|tsv|txt)$/i.test(f.name)) {
      const { headers, rows } = await readCsvRows(f);
      const k = academicSheetOfHeaders(headers);
      if (!k) { ignored.push(f.name); continue; }
      wb[k].push(...rows.map(clean));
    } else {
      const sheets = await readSheets(f, [...ACADEMIC_SHEET_ORDER.map((k) => ACADEMIC_SHEETS[k].name), 'Placement']);
      for (const k of ACADEMIC_SHEET_ORDER) wb[k].push(...(sheets[ACADEMIC_SHEETS[k].name] ?? []).map(clean));
      if (!(sheets['Study plan'] ?? []).length) wb.studyPlan.push(...(sheets['Placement'] ?? []).map(clean));
    }
  }
  return { workbook: wb, ignored };
}

async function save(data: AcademicExport, format: 'xlsx' | 'csv', base: string) {
  if (format === 'xlsx') { download(await richWorkbookXlsx(academicWorkbookSheets(data)), `${base}.xlsx`); return; }
  for (const k of ACADEMIC_SHEET_ORDER) download(await rowsToCsv(ACADEMIC_SHEETS[k].headers, data[k]), `${base} - ${ACADEMIC_SHEETS[k].name}.csv`);
}

const ACTION = { add: 'Add', update: 'Update', unchanged: 'No change', skip: 'Skipped', draft: 'Into the draft' } as const;

/**
 * The academic workbook (DEC-045): ONE template for programs, PEOs, PLOs, courses, the study plan and course content, as .xlsx or CSV. An import
 * is previewed row by row (programs first, so courses may name programs added in the same file); programs, outcomes, course records and the study
 * plan change at once, course content goes into each course's draft. Nothing is removed. Both the Programs and the Courses tabs open it.
 */
export function AcademicImportExport({ canWrite, api: override, onDone }: { canWrite: boolean; api?: AcademicApi; onDone: () => void }) {
  const api = useAcademicApi(override);
  const qc = useQueryClient();
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [pending, setPending] = useState<{ workbook: AcademicWorkbook; names: string; ignored: string[] } | null>(null);
  const [result, setResult] = useState<UpsertAcademicResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await act(fn); } finally { setBusy(false); } };
  const empty = (all: AcademicExport): AcademicExport => ({ ...emptyAcademicWorkbook(), lists: all.lists });
  return (
    <Card>
      <section aria-label="Import and export" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-semibold">Import and export</h4>
          <Button type="button" variant="ghost" className="px-2 py-1" onClick={onDone}>Close</Button>
        </div>
        <p className="text-sm text-muted-foreground">One workbook for programs (with PEOs and PLOs), courses, the study plan and course content (CLOs, outline, materials, assessments, rubrics), as Excel or as one CSV file per sheet. Programs and course records change at once; course content goes into each course's draft for approval. Nothing is removed.</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">Format
            <select aria-label="File format" className="h-9 rounded-md border border-border bg-background px-2 text-sm" value={format} onChange={(e) => setFormat(e.target.value as 'xlsx' | 'csv')}>
              <option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV (one file per sheet)</option>
            </select>
          </label>
          <Button type="button" variant="outline" className="px-3 py-1" disabled={busy} onClick={() => { void run(async () => save(empty(await api.exportAll()), format, 'Academic template')); }}>Download the template</Button>
          <Button type="button" variant="outline" className="px-3 py-1" disabled={busy} onClick={() => { void run(async () => save(await api.exportAll(), format, 'Academic workbook')); }}>Export everything</Button>
        </div>
        {canWrite && (
          <label className="flex flex-wrap items-center gap-2 text-sm">Import a file
            <input aria-label="Workbook file" type="file" multiple accept=".xlsx,.csv" className="text-sm" disabled={busy}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]; e.target.value = '';
                if (!files.length) return;
                void run(async () => {
                  const { workbook, ignored } = await readAcademicFiles(files);
                  setPending({ workbook, names: files.map((f) => f.name).join(', '), ignored });
                  setResult(await api.upsert(workbook, false));
                });
              }} />
          </label>
        )}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {result && (
          <div className="space-y-2" role="region" aria-label={result.applied ? 'Import result' : 'Import preview'}>
            <p className="text-sm font-medium">{result.applied ? 'Imported' : `Preview of ${pending?.names ?? 'the file'}`}: {result.added} to add, {result.updated} to update, {result.drafted} into drafts, {result.unchanged} unchanged, {result.skipped} skipped.</p>
            {pending && pending.ignored.length > 0 && <p className="text-xs text-amber-800">Not a sheet of the template (ignored): {pending.ignored.join(', ')}.</p>}
            <div className="max-h-80 overflow-auto rounded-md border border-border">
              <table className="w-full text-sm" aria-label="Rows">
                <thead><tr className="text-xs text-muted-foreground"><th className="px-2 py-1 text-start">Sheet</th><th className="px-2 py-1 text-start">Row</th><th className="px-2 py-1 text-start">Code</th><th className="px-2 py-1 text-start">What</th><th className="px-2 py-1 text-start">Note</th></tr></thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="px-2 py-1">{r.sheet}</td><td className="px-2 py-1">{r.row || ''}</td><td className="px-2 py-1 font-mono">{r.code}</td>
                      <td className={`px-2 py-1 ${r.action === 'skip' ? 'text-red-800' : ''}`}>{ACTION[r.action]}</td><td className="px-2 py-1 text-xs">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!result.applied && pending && canWrite && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={busy || result.added + result.updated + result.drafted === 0} onClick={() => {
                  void run(async () => {
                    setResult(await api.upsert(pending.workbook, true)); setPending(null);
                    for (const key of ['programs', 'courses', 'syllabus', 'program-outcomes', 'syllabi']) await qc.invalidateQueries({ queryKey: [key] });
                  });
                }}>Apply</Button>
                <Button type="button" variant="ghost" onClick={() => { setPending(null); setResult(null); }}>Cancel</Button>
              </div>
            )}
          </div>
        )}
      </section>
    </Card>
  );
}
