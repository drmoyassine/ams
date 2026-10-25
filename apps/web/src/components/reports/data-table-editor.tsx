// The data_table editor (TASK-092, PRD 10.3): the template's columns, filled by hand (typed, pasted from a sheet, or a
// CSV file) — or rows drawn from a bound dataset: the template names the evidence item, the report stores the version it
// took and the refresh pulls the dataset's current data; a bound section's rows are read-only here. Columns map to the
// dataset grid's shape so the same sheet component serves both.
import { useRef, useState } from 'react';
import Papa from 'papaparse';
import type { DataColumn, ReportSection } from '@ams/shared';
import { DataGrid, type DraftRow } from '../data-grid';
import { Button } from '../ui/button';
import { useTranslation } from '../../i18n';

/** The template's column (key, label, type text|number|date|enum, options) as the dataset grid reads it. */
export function asGridColumns(columns: { key: string; label: string; type: string; options?: string[] }[]): DataColumn[] {
  return columns.map((c) => ({
    key: c.key, label: c.label,
    type: c.type === 'enum' ? 'choice' : c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : 'text',
    ...(c.type === 'enum' ? { choices: c.options ?? [] } : {}),
  })) as DataColumn[];
}

const toRows = (content: unknown): DraftRow[] => {
  const { rows } = (content ?? {}) as { rows?: Record<string, unknown>[] };
  return (rows ?? []).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])));
};

export interface DatasetBindingView { evidenceItemId: string; datasetVersionId: string | null }

export function DataTableEditor({ section, binding, canWrite, busy, error, onSave, onRefresh }: {
  section: ReportSection;
  /** Set when the template binds this table to a dataset's evidence item. */
  binding: DatasetBindingView | null; canWrite: boolean; busy: boolean; error?: string | null;
  onSave: (content: { rows: Record<string, string | number | null>[]; datasetVersionId: string | null }) => Promise<void>;
  /** Pulls the bound dataset's current data; resolves to the rows and the version they came from. */
  onRefresh: () => Promise<{ rows: Record<string, string | number | null>[]; datasetVersionId: string }>;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<DraftRow[]>(() => toRows(section.content));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const columns = asGridColumns(section.columns ?? []);
  const bound = binding !== null;
  const editRows = bound || !canWrite;

  const save = async () => {
    setSaving(true);
    try {
      const clean = rows.filter((r) => Object.values(r).some((v) => (v ?? '').trim()));
      const stored = clean.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => {
        const type = columns.find((c) => c.key === k)?.type;
        const trimmed = (v ?? '').trim();
        return [k, trimmed === '' ? null : type === 'number' && trimmed !== '' && !Number.isNaN(Number(trimmed)) ? Number(trimmed) : trimmed];
      })));
      await onSave({ rows: stored, datasetVersionId: binding?.datasetVersionId ?? null });
      setDirty(false);
    } finally { setSaving(false); }
  };

  const refresh = async () => {
    setSaving(true); setNotice('');
    try {
      const pulled = await onRefresh();
      setRows(toRows({ rows: pulled.rows }));
      await onSave({ rows: pulled.rows, datasetVersionId: pulled.datasetVersionId });
      setNotice(t('rep.datasetRefreshed'));
      setDirty(false);
    } catch (e) {
      setNotice((e as Error).message);
    } finally { setSaving(false); }
  };

  const importCsv = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = Papa.parse<string[]>(String(reader.result), { skipEmptyLines: true });
      const table = parsed.data;
      if (!table.length) return;
      const byLabel = new Map(columns.map((c) => [c.label.trim().toLowerCase(), c.key]));
      const first = table[0]!.map((h) => byLabel.get(h.trim().toLowerCase()));
      const headered = first.every((k) => k !== undefined);
      const body = headered ? table.slice(1) : table;
      const start = headered ? first as (string | undefined)[] : columns.map((c) => c.key);
      const next = body.map((cells) => Object.fromEntries(start.map((k, j) => [k ?? columns[j]!.key, cells[j] ?? ''])));
      setRows(next.map((r) => r as DraftRow));
      setDirty(true);
    };
    reader.readAsText(f);
  };

  return (
    <div className="space-y-2" data-testid="data-table-editor">
      {bound && (
        <div className="flex flex-wrap items-center gap-2" data-testid="dataset-binding">
          <span className="text-sm text-muted-foreground">{t('rep.boundToDataset')}</span>
          {canWrite && section.status === 'draft' && (
            <Button type="button" variant="outline" disabled={saving || busy} onClick={() => void refresh()} data-testid="refresh-dataset">
              {t('rep.refreshDataset')}
            </Button>
          )}
          {notice && <span role="status" className="text-xs text-emerald-800">{notice}</span>}
        </div>
      )}
      <DataGrid columns={columns} rows={rows} readOnly={editRows} onChange={(next) => { setRows(next); setDirty(true); }} />
      {!editRows && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!dirty || saving || busy} onClick={() => void save()} data-testid="save-table">{saving ? t('common.saving') : t('common.save')}</Button>
          <Button type="button" variant="outline" disabled={saving || busy} onClick={() => file.current?.click()} data-testid="import-csv">{t('rep.importCsv')}</Button>
          <input ref={file} type="file" accept=".csv,text/csv" className="hidden" aria-label={t('rep.importCsv')}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importCsv(f); e.target.value = ''; }} />
          <span className="text-xs text-muted-foreground">{t('rep.pasteHint')}</span>
          {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
        </div>
      )}
    </div>
  );
}
