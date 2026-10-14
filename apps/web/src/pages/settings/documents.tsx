import { useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { DOC_STATUSES, DOC_STATUS_LABEL, type DocumentFilters } from '@ams/shared';
import { sizeAndPages, StatusChip, UploadedBy } from '../../components/docs';
import { useDocumentsApi, type DocumentsApi } from '../../lib/documents-api';

const field = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm';

/**
 * Settings -> Documents (TASK-075): every document the person may see across the institution, uploads and standards' sources
 * (never evidence), with who put each there and when, where it is used (a link to that place's Docs tab), and filters by place,
 * uploader, date range, type, status and name. Read-only: the links are the only actions; uploading and deleting happen in each
 * place's own Docs tab.
 */
export function DocumentsPage({ api: apiProp }: { api?: DocumentsApi } = {}) {
  const api = useDocumentsApi(apiProp);
  const router = useRouter();
  const [f, setF] = useState<DocumentFilters>({});
  const [text, setText] = useState('');
  // The name search waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setF((x) => { const next = { ...x }; delete next.q; return text.trim() ? { ...next, q: text.trim() } : next; }), 250);
    return () => clearTimeout(t);
  }, [text]);
  const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as DocumentFilters;
  const q = useQuery({ queryKey: ['documents-library', clean], queryFn: () => api.library(clean), placeholderData: (prev) => prev });
  const data = q.data;
  const set = <K extends keyof DocumentFilters>(k: K, v: DocumentFilters[K] | '') => setF((x) => ({ ...x, [k]: v === '' ? undefined : v }));
  const filtered = Object.keys(clean).length > 0;
  const go = (e: React.MouseEvent, href: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    router.history.push(href);
  };

  return (
    <section aria-label="Documents" className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">Documents</h2>
        <p className="text-sm text-muted-foreground">Everything uploaded for the AI to read, in every place, and where each is used. Evidence files are not listed here: they stay in the Evidence library. To add or remove a document, open the place it is used.</p>
      </header>
      <form role="search" aria-label="Filter documents" onSubmit={(e) => e.preventDefault()} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="flex flex-col text-sm sm:col-span-2 xl:col-span-1">Search by name
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} dir="auto" className={field} placeholder="File name" />
        </label>
        <label className="flex flex-col text-sm">Place
          <select value={f.place ?? ''} onChange={(e) => set('place', e.target.value)} className={field}>
            <option value="">Everywhere</option>
            {(data?.places ?? []).map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-sm">Uploaded by
          <select value={f.uploadedBy ?? ''} onChange={(e) => set('uploadedBy', e.target.value)} className={field}>
            <option value="">Anyone</option>
            {(data?.uploaders ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-sm">Type
          <select value={f.fileKind ?? ''} onChange={(e) => set('fileKind', e.target.value)} className={field}>
            <option value="">Any type</option>
            {(data?.fileKinds ?? []).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-sm">Status
          <select value={f.status ?? ''} onChange={(e) => set('status', e.target.value as DocumentFilters['status'] | '')} className={field}>
            <option value="">Any status</option>
            {DOC_STATUSES.map((s) => <option key={s} value={s}>{DOC_STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-sm">Uploaded from
          <input type="date" value={f.from ?? ''} onChange={(e) => set('from', e.target.value)} className={field} />
        </label>
        <label className="flex flex-col text-sm">Uploaded until
          <input type="date" value={f.to ?? ''} onChange={(e) => set('to', e.target.value)} className={field} />
        </label>
        {filtered && <div className="flex items-end"><button type="button" className="text-sm underline" onClick={() => { setF({}); setText(''); }}>Clear the filters</button></div>}
      </form>
      {q.isError && <p role="alert" className="text-sm text-red-700">The documents could not be loaded.</p>}
      <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
        {data ? `${data.total} ${data.total === 1 ? 'document' : 'documents'}${filtered ? ' match' : ''}${data.truncated ? ` (the first ${data.items.length} are shown; narrow the filters)` : ''}` : 'Loading…'}
      </p>
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">{filtered ? 'No document matches these filters.' : 'No documents have been uploaded yet.'}</p>}
      <ul aria-label="All documents" className="space-y-2">
        {data?.items.map((d) => (
          <li key={d.id} data-testid="library-row" className="flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg border border-border bg-background p-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {d.hasFile
                  ? <a href={api.fileUrl(d.id)} target="_blank" rel="noreferrer" dir="auto" className="min-w-0 font-medium break-all underline">{d.name}</a>
                  : <span dir="auto" className="min-w-0 font-medium break-all">{d.name}</span>}
                <StatusChip doc={d} />
              </div>
              <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                <span>{d.fileKind}</span>{sizeAndPages(d) && <span>{sizeAndPages(d)}</span>}<UploadedBy doc={d} />
              </p>
            </div>
            <p className="min-w-0 text-sm break-words sm:max-w-xs">
              Used in <a href={d.place.href} onClick={(e) => go(e, d.place.href)} className="font-medium underline" aria-label={`${d.name} is used in ${d.place.label}. Open it`}><span dir="auto">{d.place.label}</span></a>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
