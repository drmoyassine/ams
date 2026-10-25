// A report (/reports/$id, TASK-092): full width, one column — the header (what it is, its state, its words), then the
// section tree in template order, each section carrying its block's editor. Narrative, data table, attestation and
// appendix are edited here; the generated blocks (compliance matrix, evidence index, feedback response) render from the
// report's own data at export (TASK-093). No side panels: the evidence panel opens as a sheet inside the narrative.
// What a person may do mirrors the API: report:write saves content, report:manage renames and deletes a draft.
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReportDetail, ReportSection } from '@ams/shared';
import { ReadOnlyNote } from '../../components/read-only-note';
import { useConfirm } from '../../components/confirm-dialog';
import { AppendixEditor, type AppendixItem } from '../../components/reports/appendix-editor';
import { AttestationEditor } from '../../components/reports/attestation-editor';
import { DataTableEditor, type DatasetBindingView } from '../../components/reports/data-table-editor';
import { NarrativeEditor } from '../../components/reports/narrative-editor';
import { BottomSheet } from '../../components/bottom-sheet';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Chip } from '../../components/cycles/labels';
import { useTranslation } from '../../i18n';
import { useEvidenceApi } from '../../lib/evidence-api';
import { can, useApi, useMe } from '../../lib/me';
import { reportApi, useReportApi, type ReportApi } from '../../lib/report-api';
import type { EvidenceApi } from '../../lib/evidence-api';
import type { FrameworkApi } from '../../lib/framework-api';
import { useAction } from '../../lib/use-action';

const STATUS_TONE = { draft: 'neutral', internally_approved: 'info', submitted: 'good' } as const;
const SECTION_TONE = { draft: 'neutral', in_review: 'info', approved: 'good', returned: 'bad' } as const;

export function ReportPage({ id, onBack, api: reportOverride, evidence, framework }: {
  id: string; onBack?: () => void; api?: ReportApi; evidence?: EvidenceApi; framework?: FrameworkApi;
}) {
  const { t } = useTranslation();
  const api = useReportApi(reportOverride);
  const me = useMe(useApi(framework));
  const qc = useQueryClient();
  const confirm = useConfirm();
  const act = useAction((text) => setError({ at: at.current, text }));
  const q = useQuery({ queryKey: ['report', id], queryFn: () => api.get(id) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ at: string; text: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const at = useRef('');
  const report = q.data;
  const write = can(me.data, 'report:write');
  const manage = can(me.data, 'report:manage');

  const run = async (atKey: string, fn: () => Promise<ReportDetail>, notice?: string) => {
    at.current = atKey;
    setBusy(true); setError(null);
    const r = await act(fn);
    if (r) {
      qc.setQueryData(['report', id], r);
      if (notice) setError({ at: `notice:${atKey}`, text: notice });
    }
    setBusy(false);
  };

  const remove = async () => {
    if (!report) return;
    if (!(await confirm({ title: t('rep.deleteTitle', { name: report.title }), message: t('rep.deleteMessage'), confirmLabel: t('common.delete'), tone: 'danger' }))) return;
    at.current = '';
    setBusy(true); setError(null);
    const r = await act(() => api.remove(report.id));
    if (r) {
      void qc.invalidateQueries({ queryKey: ['reports'] });
      onBack?.();
    }
    setBusy(false);
  };

  if (q.isError) return <p role="alert" className="text-sm text-red-700">{(q.error as Error).message}</p>;
  if (!report) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  const pageError = error && !error.at.startsWith('notice:') ? error.text : '';
  const notice = error?.at.startsWith('notice:') ? error.text : '';
  const draft = report.status === 'draft';

  return (
    <div className="space-y-4" data-testid="report-page">
      {(onBack || report.engagementId) && (
        <p className="text-sm">
          {onBack
            ? <button type="button" className="underline" onClick={onBack}>{t('rep.back')}</button>
            : <Link to="/engagements/$id" params={{ id: report.engagementId! }} search={{ tab: 'reports' }} className="underline">{t('rep.back')}</Link>}
        </p>
      )}
      <header className="space-y-2">
        <div className="flex flex-wrap items-start gap-2">
          <h1 className="min-w-0 flex-1 break-words text-xl font-semibold sm:text-2xl" dir="auto" data-testid="report-title">{report.title}</h1>
          <Chip tone={STATUS_TONE[report.status]} testId="report-status">{t(`rep.status.${report.status}`)}</Chip>
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('rep.template')}:</dt><dd className="min-w-0 break-words" dir="auto">{report.templateName}</dd></div>
          {report.subjectName && <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('rep.about')}:</dt><dd className="min-w-0 break-words" dir="auto">{report.subjectName}</dd></div>}
          {report.round > 1 && <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('rep.round')}:</dt><dd>{report.round}</dd></div>}
          <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('rep.words')}:</dt>
            <dd data-testid="total-words">{report.wordCount}{report.wordLimit !== null ? ` / ${report.wordLimit}` : ''}</dd></div>
          <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('rep.progress')}:</dt>
            <dd data-testid="section-progress">{t('rep.approvedOf', { approved: report.approvedSections, count: report.sectionCount })}</dd></div>
        </dl>
        {report.requiresAttestation && !report.sections.some((s) => s.blockType === 'attestation') && (
          <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="attestation-missing">{t('rep.attestationMissing')}</p>
        )}
        <ReadOnlyNote show={me.isSuccess && !write && !manage} />
        {manage && draft && (
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('rep.actions')}>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setRenaming(true)}>{t('common.rename')}</Button>
            <Button type="button" variant="ghost" className="text-red-700" disabled={busy} onClick={() => void remove()}>{t('common.delete')}</Button>
          </div>
        )}
        {renaming && (
          <RenameRow initial={report.title} busy={busy} onCancel={() => setRenaming(false)} onSave={(title) => void run('', () => api.rename(report.id, title)).then(() => setRenaming(false))} />
        )}
        {pageError && <p role="alert" className="text-sm text-red-700">{pageError}</p>}
        {notice && <p role="status" className="text-sm text-emerald-800" data-testid="notice">{notice}</p>}
      </header>

      <section aria-label={t('rep.sections')} className="space-y-3">
        {report.sections.map((s) => <SectionNode key={s.id} section={s} depth={0} report={report} api={api} evidence={evidence} write={write} busy={busy} run={run} act={act} />)}
      </section>
    </div>
  );
}

type Run = (atKey: string, fn: () => Promise<ReportDetail>, notice?: string) => Promise<void>;

function SectionNode({ section, depth, report, api, evidence, write, busy, run, act }: {
  section: ReportSection; depth: number; report: ReportDetail; api: ReturnType<typeof reportApi>;
  evidence?: EvidenceApi; write: boolean; busy: boolean; run: Run; act: ReturnType<typeof useAction>;
}) {
  const { t } = useTranslation();
  const ev = useEvidenceApi(evidence);
  const [picking, setPicking] = useState(false);
  const indent = depth > 0 ? 'border-s border-border ps-4' : '';

  const refreshDataset = async () => {
    const binding = (section.datasetBinding ?? {}) as { evidenceItemId?: string; columnMap?: Record<string, string> };
    if (!binding.evidenceItemId) throw new Error(t('rep.bindingWithoutItem'));
    const detail = await ev.get(binding.evidenceItemId);
    const version = detail.versions[detail.versions.length - 1];
    if (!version) throw new Error(t('rep.datasetNoVersion'));
    const data = await ev.versionData(version.id);
    const map = binding.columnMap ?? null;
    const rows = data.rows.map((r) => Object.fromEntries((section.columns ?? []).map((c) => {
      const source = map ? map[c.key] ?? c.key : c.key;
      const v = r[source];
      return [c.key, v === undefined || v === null ? null : typeof v === 'number' ? v : String(v)];
    })));
    return { rows, datasetVersionId: version.id };
  };

  const pickVersion = () => { setPicking(true); return openPicker(); };

  return (
    <div className={`space-y-1 ${indent}`} data-testid={`section-${section.key}`} id={`section-${section.id}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className={`${depth === 0 ? 'text-base font-semibold' : 'text-sm font-medium'}`} dir="auto">{section.title}</h2>
        <Chip tone={SECTION_TONE[section.status]} testId={`section-status-${section.key}`}>{t(`rep.section.${section.status}`)}</Chip>
        <span className="text-xs text-muted-foreground">
          {section.ownerName ? <span dir="auto">{section.ownerName}</span> : section.ownerUnresolved ? t('rep.ownerUnresolved') : t('rep.noOwner')}
        </span>
        {section.requirements.map((r) => (
          <span key={r.requirementId} className="rounded bg-muted px-1 text-xs text-muted-foreground" title={r.title} dir="auto">{r.code}</span>
        ))}
      </div>
      {section.blockType === 'narrative' && (
        <NarrativeEditor section={section} canWrite={write} busy={busy} evidence={ev}
          onSave={(c) => run(section.id, () => api.saveContent(report.id, section.id, { narrative: c }))} />
      )}
      {section.blockType === 'data_table' && (
        <DataTableEditor section={section} canWrite={write} busy={busy}
          binding={(section.datasetBinding as DatasetBindingView | null) ?? null}
          onSave={(c) => run(section.id, () => api.saveContent(report.id, section.id, { data_table: c }))}
          onRefresh={() => refreshDataset()} />
      )}
      {section.blockType === 'attestation' && (
        <AttestationEditor section={section} canWrite={write} busy={busy}
          letterUrl={`/api/reports/${report.id}/sections/${section.id}/letter`}
          onSave={(c) => run(section.id, () => api.saveContent(report.id, section.id, { attestation: c }))}
          onUpload={(f) => run(section.id, () => api.uploadLetter(report.id, section.id, f))} />
      )}
      {section.blockType === 'appendix' && (
        <AppendixEditor section={section} canWrite={write} busy={busy} picker={() => pickVersion()}
          onSave={(c: { items: AppendixItem[] }) => run(section.id, () => api.saveContent(report.id, section.id, { appendix: c }))} />
      )}
      {section.blockType !== 'narrative' && section.blockType !== 'data_table' && section.blockType !== 'attestation' && section.blockType !== 'appendix' && (
        <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground" data-testid="generated-block">
          {t('rep.generatedNote', { block: t(`rep.block.${section.blockType}`) })}
        </p>
      )}
      {picking && <EvidencePicker onPick={(v) => { setPicking(false); resolvePicker(v); }} ev={ev} act={act} />}
    </div>
  );
}

// One appendix picker at a time: openPicker's promise answers when a version is chosen or the sheet closes.
let pickerResolve: ((v: { evidenceVersionId: string; title: string } | null) => void) | null = null;
const openPicker = () => new Promise<{ evidenceVersionId: string; title: string } | null>((resolve) => { pickerResolve = resolve; });
const resolvePicker = (v: { evidenceVersionId: string; title: string } | null) => { pickerResolve?.(v); pickerResolve = null; };

/** Picks one evidence item's latest version for the appendix (the versions are checked server-side). */
function EvidencePicker({ onPick, ev, act }: {
  onPick: (v: { evidenceVersionId: string; title: string } | null) => void;
  ev: ReturnType<typeof useEvidenceApi>; act: ReturnType<typeof useAction>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ id: string; title: string; versionId: string }[]>([]);
  const search = async () => {
    const items = await act(() => ev.list(query.trim() || undefined)) ?? [];
    setFound(items.filter((i) => i.latest).map((i) => ({ id: i.id, title: i.title, versionId: i.latest!.id })));
  };
  // The picker loads the library once; later searches are explicit.
  useEffect(() => { void search(); }, []);
  return (
    <BottomSheet labelledBy="appendix-picker-title" onClose={() => onPick(null)}>
      <h2 id="appendix-picker-title" className="mb-2 text-lg font-semibold">{t('rep.pickEvidence')}</h2>
      <div className="mb-2 flex gap-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t('rep.searchEvidence')} placeholder={t('rep.searchEvidence')} data-testid="appendix-search" />
        <Button type="button" variant="outline" onClick={() => void search()}>{t('common.search')}</Button>
      </div>
      <ul className="space-y-1">
        {found.map((f) => (
          <li key={f.id}>
            <button type="button" className="w-full truncate rounded-md border border-border p-2 text-start text-sm hover:bg-muted" dir="auto"
              data-testid={`pick-${f.id}`} onClick={() => onPick({ evidenceVersionId: f.versionId, title: f.title })}>{f.title}</button>
          </li>
        ))}
      </ul>
    </BottomSheet>
  );
}

function RenameRow({ initial, busy, onSave, onCancel }: { initial: string; busy: boolean; onSave: (title: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(initial);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="rename-row">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('rep.reportName')} className="max-w-md" dir="auto" data-testid="rename-input" />
      <Button type="button" disabled={busy || !title.trim()} onClick={() => onSave(title.trim())}>{t('common.save')}</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>{t('common.cancel')}</Button>
    </div>
  );
}
