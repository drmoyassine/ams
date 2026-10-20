import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DATA_COLUMN_TYPES, DATA_COLUMN_TYPE_LABELS, formatCell, keyFromLabel, validateRows,
  type CellValue, type DataColumn, type DataColumnType, type DatasetSpec, type EvidenceItem,
} from '@ams/shared';
import type { EvidenceApi } from '../lib/evidence-api';
import { ApiError } from '../lib/framework-api';
import { download, fileNameFor, importSheet, toCsv, toXlsx } from '../lib/sheet-io';
import { DataGrid, type DraftRow } from './data-grid';
import { FormTab, ResponsesTab } from './form-tabs';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';

interface ColumnDraft { key: string | null; label: string; type: DataColumnType; unit: string; required: boolean; choices: string; help: string }

const toDraft = (c: DataColumn): ColumnDraft => ({ key: c.key, label: c.label, type: c.type, unit: c.unit ?? '', required: c.required, choices: (c.choices ?? []).join(', '), help: c.help ?? '' });
const toDraftRow = (columns: DataColumn[], r: Record<string, CellValue>): DraftRow =>
  Object.fromEntries(columns.map((c) => [c.key, formatCell(c, r[c.key] ?? null)]));

/** The dataset's columns and grain: name, type, unit, required, and the choices of a choice column. What the data means is the item's definition. */
function ColumnsEditor({ spec, onSave, onCancel }: { spec: DatasetSpec; onSave: (s: { grain: string; columns: DataColumn[] }) => Promise<void>; onCancel?: () => void }) {
  const [grain, setGrain] = useState(spec.grain ?? '');
  const [cols, setCols] = useState<ColumnDraft[]>(spec.columns.length ? spec.columns.map(toDraft) : [{ key: null, label: '', type: 'text', unit: '', required: false, choices: '', help: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const patch = (i: number, p: Partial<ColumnDraft>) => setCols((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const move = (i: number, d: -1 | 1) => setCols((cs) => { const n = [...cs]; [n[i], n[i + d]] = [n[i + d]!, n[i]!]; return n; });
  const save = async () => {
    const named = cols.filter((c) => c.label.trim());
    const taken = named.flatMap((c) => (c.key ? [c.key] : []));
    const columns: DataColumn[] = named.map((c, i) => {
      const key = c.key ?? keyFromLabel(c.label, taken, i + 1);
      if (!c.key) taken.push(key);
      const choices = c.choices.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean);
      return { key, label: c.label.trim(), type: c.type, required: c.required, ...(c.unit.trim() ? { unit: c.unit.trim() } : {}), ...(c.type === 'choice' ? { choices } : {}), ...(c.help.trim() ? { help: c.help.trim() } : {}) };
    });
    setBusy(true); setError('');
    try { await onSave({ grain: grain.trim(), columns }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section aria-label="Dataset columns" className="space-y-3">
      <label className="flex flex-col text-sm">One row is
        <Input aria-label="One row is" dir="auto" value={grain} onChange={(e) => setGrain(e.target.value)} placeholder="e.g. one program in one academic year" />
      </label>
      <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[44rem] text-sm" aria-label="Columns">
        <thead><tr className="text-start text-xs text-muted-foreground">
          <th className="text-start font-normal">Column</th><th className="text-start font-normal">Type</th><th className="text-start font-normal">Unit</th>
          <th className="font-normal">Required</th><th className="text-start font-normal">Choices</th><th className="text-start font-normal">Help (shown in the form)</th><th />
        </tr></thead>
        <tbody>
          {cols.map((c, i) => (
            <tr key={i} data-testid="column-row">
              <td className="pe-2 py-1"><Input aria-label={`Column ${i + 1} name`} dir="auto" value={c.label} onChange={(e) => patch(i, { label: e.target.value })} /></td>
              <td className="pe-2">
                <select aria-label={`Column ${i + 1} type`} value={c.type} onChange={(e) => patch(i, { type: e.target.value as DataColumnType })} className="h-9 rounded-md border border-border bg-background px-2">
                  {DATA_COLUMN_TYPES.map((t) => <option key={t} value={t}>{DATA_COLUMN_TYPE_LABELS[t]}</option>)}
                </select>
              </td>
              <td className="pe-2"><Input aria-label={`Column ${i + 1} unit`} className="w-24" dir="auto" value={c.unit} onChange={(e) => patch(i, { unit: e.target.value })} /></td>
              <td className="text-center"><input type="checkbox" aria-label={`Column ${i + 1} required`} checked={c.required} onChange={(e) => patch(i, { required: e.target.checked })} /></td>
              <td className="pe-2">{c.type === 'choice' && <Input aria-label={`Column ${i + 1} choices`} dir="auto" placeholder="Comma-separated" value={c.choices} onChange={(e) => patch(i, { choices: e.target.value })} />}</td>
              <td className="pe-2"><Input aria-label={`Column ${i + 1} help`} dir="auto" value={c.help} onChange={(e) => patch(i, { help: e.target.value })} /></td>
              <td className="whitespace-nowrap">
                <Button type="button" variant="ghost" className="px-1" aria-label={`Move column ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
                <Button type="button" variant="ghost" className="px-1" aria-label={`Move column ${i + 1} down`} disabled={i === cols.length - 1} onClick={() => move(i, 1)}>↓</Button>
                <Button type="button" variant="ghost" className="px-1" aria-label={`Remove column ${i + 1}`} onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))}>✕</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <Button type="button" variant="outline" onClick={() => setCols((cs) => [...cs, { key: null, label: '', type: 'text', unit: '', required: false, choices: '', help: '' }])}>+ Column</Button>
      <p className="text-xs text-muted-foreground">Data already saved keeps the columns it was saved with; changes apply to the next version.</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save columns'}</Button>
      </div>
    </section>
  );
}

/**
 * Dataset evidence: its columns, and the latest data in an online sheet to type, paste or import into. Saving checks
 * every cell and keeps the result as the next version; earlier versions stay as they were.
 */
export function DatasetPanel({ item, api, canWrite }: { item: EvidenceItem; api: EvidenceApi; canWrite: boolean }) {
  const qc = useQueryClient();
  const spec = useQuery({ queryKey: ['data-definition', item.id], queryFn: () => api.dataDefinition(item.id) });
  const latestId = item.latest?.rowCount !== null && item.latest?.rowCount !== undefined ? item.latest.id : null;
  const saved = useQuery({ queryKey: ['version-data', latestId], queryFn: () => api.versionData(latestId!), enabled: !!latestId });
  const columns = spec.data?.columns ?? [];
  const [editingDef, setEditingDef] = useState(false);
  const [view, setView] = useState<'sheet' | 'form' | 'responses'>('sheet');
  const form = useQuery({ queryKey: ['data-form', item.id], queryFn: () => api.form(item.id) });
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [serverIssues, setServerIssues] = useState<Map<string, string>>(new Map());

  // Load the saved rows into the sheet (unless there are unsaved edits).
  useEffect(() => {
    if (dirty || !spec.data) return;
    setRows((saved.data?.rows ?? []).map((r) => toDraftRow(spec.data.columns, r)));
  }, [saved.data, spec.data, dirty]);

  const check = useMemo(() => validateRows(columns, rows), [columns, rows]);
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['evidence-item', item.id] }), qc.invalidateQueries({ queryKey: ['evidence'] }),
    qc.invalidateQueries({ queryKey: ['data-definition', item.id] }),
  ]);
  const change = (next: DraftRow[]) => { setRows(next); setDirty(true); setServerIssues(new Map()); setInfo(''); };

  const save = async () => {
    setBusy(true); setError(''); setInfo('');
    try {
      const v = await api.saveData(item.id, { rows, ...(notes.trim() ? { notes: notes.trim() } : {}) });
      setDirty(false); setNotes('');
      setInfo(`Saved as version ${v.versionNo} (${v.rowCount} row${v.rowCount === 1 ? '' : 's'}).`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError) {
        setServerIssues(new Map(e.issues.flatMap((i) => { const m = /^rows\.(\d+)\.(.+)$/.exec(i.path); return m ? [[`${m[1]}:${m[2]}`, i.message] as const] : []; })));
      }
    } finally { setBusy(false); }
  };
  const doImport = async (file: File | undefined) => {
    if (!file) return;
    setError(''); setInfo('');
    try {
      const out = await importSheet(file, columns);
      change(out.rows.map((r) => toDraftRow(columns, r)));
      setInfo([
        `Imported ${out.rows.length} row${out.rows.length === 1 ? '' : 's'} from ${file.name}; check them and save.`,
        out.ignored.length ? `Ignored columns: ${out.ignored.join(', ')}.` : '',
        out.missing.length ? `Not in the file: ${out.missing.join(', ')}.` : '',
      ].filter(Boolean).join(' '));
    } catch (e) { setError((e as Error).message); }
  };
  const exportAs = async (kind: 'xlsx' | 'csv') => {
    const data = validateRows(columns, rows).rows;
    download(kind === 'xlsx' ? await toXlsx(item.title, columns, data) : await toCsv(columns, data), fileNameFor(item.title, kind));
  };

  if (!spec.data) return <Card><p className="text-sm">Loading…</p></Card>;
  const defining = editingDef || (canWrite && columns.length === 0);
  return (
    <Card>
      <section aria-label="Dataset" className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-semibold">Dataset</h3>
          {spec.data.grain && <span className="text-sm text-muted-foreground" dir="auto">· one row is {spec.data.grain}</span>}
          {canWrite && !defining && <Button type="button" variant="ghost" className="ms-auto" onClick={() => setEditingDef(true)}>Edit columns</Button>}
        </div>
        {defining && (
          <ColumnsEditor spec={spec.data} onCancel={columns.length ? () => setEditingDef(false) : undefined}
            onSave={async (s) => {
              await api.saveDataDefinition(item.id, { columns: s.columns, grain: s.grain || null });
              setEditingDef(false);
              await refresh();
            }} />
        )}
        {!defining && columns.length === 0 && <p className="text-sm text-muted-foreground">No columns are defined yet.</p>}
        {!defining && columns.length > 0 && (
          <div role="tablist" aria-label="Views" className="flex gap-1 border-b border-border">
            {([['sheet', 'Sheet'], ['form', 'Form'], ['responses', `Responses${form.data?.pending ? ` (${form.data.pending} new)` : ''}`]] as const).map(([k, label]) => (
              <Button key={k} type="button" role="tab" aria-selected={view === k} variant="ghost"
                className={`rounded-b-none ${view === k ? 'border-b-2 border-primary font-medium' : ''}`} onClick={() => setView(k)}>{label}</Button>
            ))}
          </div>
        )}
        {!defining && columns.length > 0 && view === 'form' && <FormTab item={item} api={api} canWrite={canWrite} />}
        {!defining && columns.length > 0 && view === 'responses' && (
          <ResponsesTab item={item} api={api} canWrite={canWrite} columns={columns}
            onAdded={() => { setDirty(false); void refresh(); void qc.invalidateQueries({ queryKey: ['version-data'] }); }} />
        )}
        {!defining && columns.length > 0 && view === 'sheet' && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {canWrite && (
                <label className="inline-flex cursor-pointer items-center rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
                  Import Excel or CSV
                  <input aria-label="Import Excel or CSV" type="file" accept=".xlsx,.csv,.tsv,.txt" className="sr-only" onChange={(e) => { void doImport(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              )}
              <Button type="button" variant="outline" onClick={() => void toXlsx(item.title, columns, []).then((b) => download(b, fileNameFor(`${item.title} template`, 'xlsx')))}>Template</Button>
              <Button type="button" variant="outline" onClick={() => void exportAs('xlsx')}>Export Excel</Button>
              <Button type="button" variant="outline" onClick={() => void exportAs('csv')}>Export CSV</Button>
              <span className="ms-auto text-sm text-muted-foreground" data-testid="sheet-status">
                {check.rows.length} row{check.rows.length === 1 ? '' : 's'}
                {check.issues.length ? <span className="text-red-700"> · {check.issues.length} cell{check.issues.length === 1 ? ' needs' : 's need'} attention</span> : null}
                {dirty ? ' · unsaved changes' : item.latest?.rowCount !== null && item.latest ? ` · version ${item.latest.versionNo}` : ''}
              </span>
            </div>
            <DataGrid columns={columns} rows={rows} readOnly={!canWrite} onChange={change} serverIssues={serverIssues} />
            {info && <p role="status" className="text-sm">{info}</p>}
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            {canWrite && dirty && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Input aria-label="Note for this version" placeholder="Note for this version (optional)" className="w-72" dir="auto" value={notes} onChange={(e) => setNotes(e.target.value)} />
                <Button type="button" variant="ghost" onClick={() => { setDirty(false); setServerIssues(new Map()); setError(''); setInfo(''); }}>Discard changes</Button>
                <Button type="button" disabled={busy || check.issues.length > 0 || check.rows.length === 0} onClick={() => void save()}>{busy ? 'Saving…' : 'Save as new version'}</Button>
              </div>
            )}
          </>
        )}
      </section>
    </Card>
  );
}
