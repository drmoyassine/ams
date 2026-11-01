import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OutcomesWorkbook, OutcomesWorkbookResult } from '@ams/shared';
import { useFilePicker } from '../../components/files';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { readSheets } from '../../lib/sheet-io';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useAction } from '../../lib/use-action';

/** The workbook's rows as the API takes them (headers of the Integrated Assessment Plan: Programs, PEOs, PLOs). */
export function workbookRows(sheets: Record<string, Record<string, string>[]>, source: string): Omit<OutcomesWorkbook, 'apply'> {
  const g = (r: Record<string, string>, ...names: string[]) => names.map((n) => r[n]).find((v) => v && v.trim()) ?? null;
  return {
    source,
    programs: (sheets.Programs ?? []).filter((r) => g(r, 'Program Title')).map((r) => ({
      programId: g(r, 'Program_ID'), title: g(r, 'Program Title')!, mission: g(r, 'Mission Statement'), vision: g(r, 'Vision Statement', 'Vision'), school: g(r, 'School'),
    })),
    peos: (sheets.PEOs ?? []).filter((r) => g(r, 'PEO_ID') && g(r, 'PEO Text') && g(r, 'related_Program')).map((r) => ({ id: g(r, 'PEO_ID')!, text: g(r, 'PEO Text')!, program: g(r, 'related_Program')! })),
    plos: (sheets.PLOs ?? []).filter((r) => g(r, 'PLO_ID') && g(r, 'PLO Text') && g(r, 'related_Program')).map((r) => ({ id: g(r, 'PLO_ID')!, text: g(r, 'PLO Text')!, program: g(r, 'related_Program')! })),
  };
}

function Summary({ r }: { r: OutcomesWorkbookResult }) {
  const verb = r.applied ? '' : 'would be ';
  return (
    <div className="space-y-1 text-sm" role="status">
      <p>{r.unitsCreated.length} unit{r.unitsCreated.length === 1 ? '' : 's'} {verb}created{r.unitsCreated.length ? `: ${r.unitsCreated.join(', ')}` : ''}.</p>
      <p>{r.programsCreated.length} program{r.programsCreated.length === 1 ? '' : 's'} {verb}created, {r.programsUpdated.length} {verb}completed (empty fields filled).</p>
      <p>{r.outcomesCreated} PEO{r.outcomesCreated === 1 ? '' : 's'} and PLOs {verb}added as drafts; {r.outcomesUnchanged} already recorded.</p>
      {r.skipped.length > 0 && (
        <details>
          <summary>{r.skipped.length} row{r.skipped.length === 1 ? '' : 's'} left alone</summary>
          <ul className="ms-4 list-disc">{r.skipped.map((s, i) => <li key={i}>{s.sheet} · {s.row}: {s.reason}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

/**
 * "Load from workbook" on the Programs list: reads the Programs, PEOs and PLOs sheets of the Integrated Assessment Plan in the browser,
 * shows what would happen, and applies on a second click. Additive: nothing recorded is overwritten.
 */
export function WorkbookLoader({ api: override, onDone }: { api?: OutcomesApi; onDone: () => void }) {
  const api = useOutcomesApi(override);
  const qc = useQueryClient();
  const [rows, setRows] = useState<Omit<OutcomesWorkbook, 'apply'> | null>(null);
  const [preview, setPreview] = useState<OutcomesWorkbookResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const picker = useFilePicker({
    kind: 'data', label: 'Workbook file',
    onFiles: ([file]) => {
      if (!file) return;
      setError(null); setPreview(null); setBusy(true);
      void readSheets(file, ['Programs', 'PEOs', 'PLOs'])
        .then(async (sheets) => {
          const r = workbookRows(sheets, file.name.replace(/\.xlsx$/i, ''));
          if (!r.programs.length && !r.peos.length && !r.plos.length) { setError('No Programs, PEOs or PLOs sheet with rows was found in this workbook.'); return; }
          setRows(r);
          const p = await act(() => api.loadWorkbook({ ...r, apply: false }));
          if (p) setPreview(p);
        })
        .catch((e: unknown) => setError(`The workbook could not be read: ${(e as Error).message}`))
        .finally(() => setBusy(false));
    },
  });
  const apply = async () => {
    if (!rows) return;
    setBusy(true);
    const r = await act(() => api.loadWorkbook({ ...rows, apply: true }));
    setBusy(false);
    if (r) { setPreview(r); await qc.invalidateQueries(); }
  };
  return (
    <Card aria-label="Load from workbook" className="space-y-3">
      {picker.input}
      <p className="text-sm text-muted-foreground">Reads the Programs, PEOs and PLOs sheets of the Integrated Assessment Plan workbook. Missing schools and programs are created, empty mission and code fields filled, new PEOs and PLOs added as drafts. Nothing already recorded is changed.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={picker.open}>Choose workbook</Button>
        {preview && !preview.applied && <Button type="button" disabled={busy} onClick={() => void apply()}>Load it</Button>}
        <Button type="button" variant="ghost" onClick={onDone}>{preview?.applied ? 'Done' : 'Close'}</Button>
      </div>
      {busy && <p className="text-sm text-muted-foreground">Reading…</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {preview && <Summary r={preview} />}
    </Card>
  );
}
