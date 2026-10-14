// Small pieces the Docs tab, the import review and the Documents area share (TASK-075).
import type { DocStatus, DocumentRow, ImportRun, ImportRunStatus } from '@ams/shared';
import { formatBytes } from '../../lib/source-files';

const STATUS: Record<DocStatus, { label: string; cls: string }> = {
  queued: { label: 'Waiting', cls: 'bg-muted text-muted-foreground' },
  reading: { label: 'Reading', cls: 'bg-sky-50 text-sky-900' },
  read: { label: 'Read', cls: 'bg-emerald-50 text-emerald-900' },
  needs_ocr: { label: 'Needs OCR', cls: 'bg-amber-50 text-amber-900' },
  failed: { label: 'Failed', cls: 'bg-red-50 text-red-900' },
  not_read: { label: 'Not read', cls: 'bg-muted text-muted-foreground' },
};

/** Where reading a file stands, as a chip: Read / Needs OCR / Failed / Reading / Waiting. The long wording is its tooltip and its accessible name. */
export function StatusChip({ doc }: { doc: Pick<DocumentRow, 'status' | 'statusText' | 'name'> }) {
  const s = STATUS[doc.status];
  return (
    <span role="status" aria-label={`Reading status of ${doc.name}: ${doc.statusText}`} title={doc.statusText} data-status={doc.status}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

const RUN: Record<ImportRunStatus, { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'bg-muted text-muted-foreground' },
  running: { label: 'Running', cls: 'bg-sky-50 text-sky-900' },
  succeeded: { label: 'Finished', cls: 'bg-emerald-50 text-emerald-900' },
  failed: { label: 'Stopped', cls: 'bg-red-50 text-red-900' },
  cancelled: { label: 'Cancelled', cls: 'bg-muted text-muted-foreground' },
};
export function RunChip({ status }: { status: ImportRunStatus }) {
  const s = RUN[status];
  return <span className={`inline-flex shrink-0 rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

/** "13 Oct 2026", with the time as its tooltip. */
export function WhenText({ iso }: { iso: string }) {
  const d = new Date(iso);
  return <time dateTime={iso} title={d.toLocaleString('en-GB')}>{d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</time>;
}

/** "alo, 13 Oct 2026": who put a file here and when. */
export function UploadedBy({ doc }: { doc: Pick<DocumentRow, 'uploadedByName' | 'uploadedAt'> }) {
  return (
    <span data-testid="uploaded-by" className="min-w-0">
      Uploaded by <span dir="auto" className="font-medium">{doc.uploadedByName ?? 'someone who has left'}</span> on <WhenText iso={doc.uploadedAt} />
    </span>
  );
}

/** Size and pages in one line: "1.4 MB · 12 pages". */
export function sizeAndPages(doc: Pick<DocumentRow, 'size' | 'pageCount'>): string {
  return [doc.size !== null ? formatBytes(doc.size) : null, doc.pageCount ? `${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
}

const n = (x: number) => x.toLocaleString('en');
/** Tokens and, when prices are set in Settings -> AI, the cost so far. */
export function spendText(u: ImportRun['usage']): string {
  const tokens = `${n(u.inputTokens + u.outputTokens)} tokens`;
  return u.costUsd === null ? tokens : `${tokens}, $${u.costUsd.toFixed(2)}`;
}

/** "camelCase" and "snake_case" as words: "Degree level". */
export const humanize = (key: string) => {
  const s = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
