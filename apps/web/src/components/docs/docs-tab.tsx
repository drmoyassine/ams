import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocScopeKind, DocumentRow, ImportTargetInfo } from '@ams/shared';
import { useDocumentsApi, type DocumentsApi } from '../../lib/documents-api';
import { ActionsMenu } from '../accordion';
import { useAction } from '../../lib/use-action';
import { useConfirm } from '../confirm-dialog';
import { Button } from '../ui/button';
import { ImportPanel } from './import-panel';
import { ImportReportView } from './import-report';
import { ImportReview } from './import-review';
import { sizeAndPages, StatusChip, UploadedBy } from './parts';
import { UploadArea } from '../files';

/** What a custom row gets to work with. */
export interface DocsRowContext {
  api: DocumentsApi;
  canWrite: boolean;
  /** Reload the list. */
  refresh: () => void;
  /** Read the file again. */
  readAgain: (doc: DocumentRow) => void;
  /** Ask, then delete to the Trash (the Undo toast appears by itself). */
  remove: (doc: DocumentRow) => void;
  /** The ⋯ menu items every row has (Read again, Delete) for the rows that draw their own menu. */
  menu: (doc: DocumentRow) => { label: string; onSelect: () => void }[];
}

/**
 * What a place adds to the one document row (DRY: every Docs tab draws the same row). The standards add the role and authority
 * chips, the ⋯ menu's Edit details and Replace file, and the page text under the row.
 */
export interface DocsRowExtras {
  /** Small labels after the status chip. */
  chips?: ReactNode;
  /** More actions, in a ⋯ menu beside Open, Read again and Delete. */
  menu?: { label: string; onSelect: () => void }[];
  /** A section under the row, closed until the person opens it with the button named `detailsLabel`. */
  details?: ReactNode;
  detailsLabel?: string;
  /** Controlled open state (a link elsewhere may need to open the section); without these the row keeps its own. */
  open?: boolean;
  onToggle?: () => void;
  /** The row's DOM id, for links that scroll to it. */
  domId?: string;
}

export interface DocsTabProps {
  /** The place: a standards version (`framework_version`), Programs, the org chart, the glossary... */
  scopeKind: DocScopeKind;
  scopeId: string | null;
  /** The imports this place offers (a button each). Empty: no Import area. */
  targets: ImportTargetInfo[];
  /** May the person upload, delete and import here? (Reading needs only the place's read permission.) */
  canWrite: boolean;
  /** False when the place is fixed (a published version): the list stays, upload and import go. */
  editable?: boolean;
  /** Said instead of the upload area when `editable` is false. */
  fixedNote?: string;
  api?: DocumentsApi;
  /** Content above the list. */
  header?: ReactNode;
  /** Content under the list and the import buttons (the standards' Analysis panel: add and read the documents first, then analyse). */
  footer?: ReactNode;
  /** What this place adds to each row. */
  rowExtras?: (doc: DocumentRow, ctx: DocsRowContext) => DocsRowExtras | undefined;
  /** Told the list whenever it loads (the host may need the titles and the count). */
  onDocuments?: (docs: DocumentRow[]) => void;
  /** Extra controls beside the upload area (the standards' "+ Source"). */
  actions?: ReactNode;
  /** Where a failed readiness check wants to go (Add documents...). */
  onFix?: (where: 'docs' | 'sources' | 'version') => void;
  label?: string;
}

const active = (d: DocumentRow) => d.status === 'queued' || d.status === 'reading';

/**
 * The one Docs tab (TASK-075, docs/ai-import.md): the documents of a place with their type, size, pages, reading status and WHO
 * uploaded them and WHEN; drag-and-drop upload of many files with a state and a Retry each; open, read again and delete (to the
 * Trash, with Undo); an Import button per target with its readiness check and live progress; and the history of imports with a link
 * to each one's proposals (the review) and report. Shows only what the person may read; upload, delete and import need `canWrite`.
 */
export function DocsTab({ scopeKind, scopeId, targets, canWrite, editable = true, fixedNote, api: apiProp, header, footer, rowExtras, onDocuments, actions, onFix, label = 'Docs' }: DocsTabProps) {
  const api = useDocumentsApi(apiProp);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const scope = { kind: scopeKind, id: scopeId };
  const key = ['docs', scopeKind, scopeId];
  const list = useQuery({ queryKey: key, queryFn: () => api.list(scope), refetchInterval: (q) => (q.state.data?.some(active) ? 1500 : false) });
  const docs = list.data ?? [];
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'review'; runId: string } | { kind: 'report'; runId: string }>({ kind: 'list' });
  const [error, setError] = useState('');
  const run = useAction(setError);
  useEffect(() => { if (list.data) onDocuments?.(list.data); }, [list.data]);
  const refresh = useCallback(() => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['documents-library'] }); }, [qc, scopeKind, scopeId]);

  const readAgain = (d: DocumentRow) => { setError(''); void run(() => api.read(d.id)).then(refresh); };
  const remove = (d: DocumentRow) => {
    void confirm({
      title: `Delete ${d.name}?`, confirmLabel: 'Delete', tone: 'danger',
      message: `${d.name}${d.pageCount ? ` and its ${d.pageCount} page${d.pageCount === 1 ? '' : 's'}` : ''} will be deleted. You can restore it, with its file, from the Trash for 30 days.`,
    }).then((ok) => { if (ok) { setError(''); void run(() => api.remove(d.id)).then(refresh); } });
  };
  const menu = (d: DocumentRow) => (canWrite && editable ? [{ label: d.hasFile ? 'Read again' : 'Read', onSelect: () => readAgain(d) }, { label: 'Delete', onSelect: () => remove(d) }] : []);
  const ctx: DocsRowContext = { api, canWrite: canWrite && editable, refresh, readAgain, remove, menu };

  if (view.kind === 'review') return <ImportReview api={api} runId={view.runId} canWrite={canWrite && editable} onBack={() => { setView({ kind: 'list' }); refresh(); }} />;
  if (view.kind === 'report') return <ImportReportView api={api} runId={view.runId} onBack={() => setView({ kind: 'list' })} onReview={(runId) => setView({ kind: 'review', runId })} />;

  return (
    <section aria-label={label} className="space-y-3">
      {header}
      {canWrite && editable && (
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1"><UploadArea onUpload={(f) => api.upload(scope, f)} onSettled={refresh} /></div>
          {actions}
        </div>
      )}
      {!editable && fixedNote && <p className="text-xs text-muted-foreground">{fixedNote}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {list.isError && <p role="alert" className="text-sm text-red-700">The documents could not be loaded.</p>}
      <p className="text-sm text-muted-foreground" aria-live="polite">{list.data ? `${docs.length} ${docs.length === 1 ? 'document' : 'documents'}` : 'Loading…'}</p>
      {list.data && docs.length === 0 && <p className="text-sm text-muted-foreground">No documents yet.{canWrite && editable ? ' Drop files above to add some.' : ''}</p>}
      <ul aria-label="Documents" className="space-y-2">
        {docs.map((d) => (
          <li key={d.id} className="list-none">
            <DocumentRowCard doc={d} ctx={ctx} extras={rowExtras?.(d, ctx)} />
          </li>
        ))}
      </ul>
      <ImportPanel api={api} scope={scope} targets={targets} docs={docs} canImport={canWrite && editable} onFix={onFix ?? (() => undefined)}
        onReview={(runId) => setView({ kind: 'review', runId })} onReport={(runId) => setView({ kind: 'report', runId })} />
      {footer}
    </section>
  );
}

/** The document card every Docs tab shows: name (opens the file), kind, size, pages, status, who and when, and the actions. */
function DocumentRowCard({ doc, ctx, extras }: { doc: DocumentRow; ctx: DocsRowContext; extras: DocsRowExtras | undefined }) {
  const { api } = ctx;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = extras?.open ?? ownOpen;
  const toggle = extras?.onToggle ?? (() => setOwnOpen((o) => !o));
  return (
    <article aria-label={doc.name} id={extras?.domId} data-testid="doc-row" className="scroll-mt-4 flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg border border-border bg-background p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {doc.hasFile
            ? <a href={api.fileUrl(doc.id)} target="_blank" rel="noreferrer" dir="auto" className="min-w-0 font-medium break-all underline">{doc.name}</a>
            : <span dir="auto" className="min-w-0 font-medium break-all">{doc.name}</span>}
          <StatusChip doc={doc} />
          {extras?.chips}
        </div>
        <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
          <span>{doc.fileKind}</span>
          {sizeAndPages(doc) && <span>{sizeAndPages(doc)}</span>}
          <UploadedBy doc={doc} />
        </p>
        {doc.status === 'failed' && doc.readError && <p className="text-xs text-red-700" dir="auto">{doc.readError}</p>}
        {doc.status === 'needs_ocr' && <p className="text-xs text-amber-900">{doc.needsOcrPages} {doc.needsOcrPages === 1 ? 'page has' : 'pages have'} no readable text. If scanned pages are read by the AI (Settings → AI), read the file again after switching that on.</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {doc.hasFile && <a href={api.fileUrl(doc.id)} target="_blank" rel="noreferrer" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted" aria-label={`Open ${doc.name}`}>Open</a>}
        {extras?.details && <Button type="button" variant="outline" className="px-3 py-1.5" aria-expanded={open} aria-label={`${extras.detailsLabel ?? 'Details'} of ${doc.name}`} onClick={toggle}>{extras.detailsLabel ?? 'Details'} {open ? '▴' : '▾'}</Button>}
        {ctx.canWrite && (
          <>
            <Button type="button" variant="outline" className="px-3 py-1.5" disabled={active(doc)} aria-label={doc.status === 'not_read' ? `Read ${doc.name}` : `Read ${doc.name} again`} onClick={() => ctx.readAgain(doc)}>{doc.status === 'not_read' ? 'Read' : 'Read again'}</Button>
            <Button type="button" variant="ghost" className="px-3 py-1.5" aria-label={`Delete ${doc.name}`} onClick={() => ctx.remove(doc)}>Delete</Button>
          </>
        )}
        {extras?.menu && extras.menu.length > 0 && <ActionsMenu label={`More actions for ${doc.name}`} items={extras.menu} />}
      </div>
      {extras?.details && open && <div className="basis-full space-y-2 border-t border-border pt-3">{extras.details}</div>}
    </article>
  );
}
