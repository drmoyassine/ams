import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ContentText } from '../components/content-text';
import { Dialog } from '../components/dialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { ApiError, type FrameworkApi, type StandardFromFiles } from '../lib/framework-api';
import { fileKind, formatBytes, isReadableKind } from '../lib/source-files';
import { FileDrop } from '../components/files';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILES = 40;
const select = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm';
const NEW_ACCREDITOR = '';

export type FileStatus = 'waiting' | 'uploading' | 'saved' | 'failed';
interface UploadRow { key: string; file: File; documentId: string; title: string; status: FileStatus; error: string }

const STATUS_TEXT: Record<FileStatus, string> = { waiting: 'Waiting', uploading: 'Uploading…', saved: 'Saved', failed: 'Not saved' };
const STATUS_CLS: Record<FileStatus, string> = {
  waiting: 'bg-muted text-muted-foreground', uploading: 'bg-sky-50 text-sky-900', saved: 'bg-emerald-50 text-emerald-900', failed: 'bg-red-50 text-red-900',
};
const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
const messageOf = (e: unknown) => (e instanceof ApiError ? e.message : 'The connection was lost before the file was saved.');

/**
 * "Create from files": the owner's main way to add an external standard. Name the accreditor and the standard, drop the
 * accreditor's documents, and the system creates the draft, saves each file to it and starts the analysis. Nothing is
 * created until "Create and analyse"; after that the draft and its files are kept whatever happens next (a file that did
 * not upload can be retried; an analysis that cannot start, for want of AI settings, can be started later from the Docs tab).
 */
export function CreateFromFilesDialog({ api, onClose, onOpenVersion }: { api: FrameworkApi; onClose: () => void; onOpenVersion?: (versionId: string) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const open = onOpenVersion ?? ((id: string) => { void navigate({ to: '/settings/versions/$versionId', params: { versionId: id }, search: { tab: 'docs' } }); });
  const standards = useQuery({ queryKey: ['frameworks'], queryFn: () => api.frameworks() });
  const limits = useQuery({ queryKey: ['source-limits'], queryFn: () => api.sourceLimits() });
  const maxBytes = limits.data?.maxFileBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = limits.data?.maxFiles ?? DEFAULT_MAX_FILES;
  const accreditors = [...new Map((standards.data ?? []).map((f) => [f.accreditorId, { id: f.accreditorId, name: f.accreditorName, shortName: f.accreditorShortName }])).values()];

  const [accreditorId, setAccreditorId] = useState<string | null>(null); // null: nothing chosen yet (existing ones, else new)
  const [accName, setAccName] = useState('');
  const [accShort, setAccShort] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'institution' | 'program' | 'both'>('institution');
  const [edition, setEdition] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<'form' | 'working' | 'result'>('form');
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [created, setCreated] = useState<StandardFromFiles | null>(null);
  const [rows, setRowsState] = useState<UploadRow[]>([]);
  const rowsRef = useRef<UploadRow[]>([]);
  const [analysis, setAnalysis] = useState<{ state: 'idle' | 'starting' | 'started' | 'failed'; message: string }>({ state: 'idle', message: '' });

  const chosen = accreditorId ?? (accreditors[0]?.id ?? NEW_ACCREDITOR);
  const isNew = chosen === NEW_ACCREDITOR;
  const tooBig = files.filter((f) => f.size > maxBytes);
  const empty = files.filter((f) => f.size === 0);
  const valid = (isNew ? accName.trim() && accShort.trim() : true) && name.trim() && edition.trim() && files.length > 0 && tooBig.length === 0 && empty.length === 0 && files.length <= maxFiles;
  const busy = phase === 'working' && (rows.some((r) => r.status === 'uploading' || r.status === 'waiting') || analysis.state === 'starting' || !created);

  const setRows = (next: UploadRow[]) => { rowsRef.current = next; setRowsState(next); };
  const patch = (key: string, p: Partial<UploadRow>) => setRows(rowsRef.current.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const addFiles = (list: File[]) => {
    setFiles((cur) => {
      const next = [...cur];
      for (const f of list) if (!next.some((x) => sameFile(x, f))) next.push(f);
      return next;
    });
  };

  const startAnalysis = async (versionId: string) => {
    setAnalysis({ state: 'starting', message: '' });
    try {
      await api.startAnalysis(versionId);
      setAnalysis({ state: 'started', message: '' });
      void qc.invalidateQueries({ queryKey: ['frameworks'] });
      open(versionId);
      onClose();
      return true;
    } catch (e) {
      setAnalysis({ state: 'failed', message: e instanceof ApiError ? e.message : 'The analysis could not be started.' });
      return false;
    }
  };

  /** Uploads the rows that are not saved yet, one at a time; when every file is saved, starts the analysis. */
  const upload = async (made: StandardFromFiles, keys: string[]) => {
    for (const key of keys) {
      const row = rowsRef.current.find((r) => r.key === key);
      if (!row || row.status === 'saved') continue;
      patch(key, { status: 'uploading', error: '' });
      try {
        await api.uploadSourceFile(row.documentId, row.file);
        patch(key, { status: 'saved' });
      } catch (e) {
        patch(key, { status: 'failed', error: messageOf(e) });
      }
    }
    setPhase('result');
    if (rowsRef.current.every((r) => r.status === 'saved') && analysis.state !== 'started') await startAnalysis(made.version.id);
  };

  const create = async () => {
    setError(''); setIssues([]);
    setPhase('working');
    let made: StandardFromFiles;
    try {
      made = await api.createStandardFromFiles({
        ...(isNew ? { accreditor: { name: accName.trim(), shortName: accShort.trim() } } : { accreditorId: chosen }),
        name: name.trim(), scope, edition: edition.trim(), files: files.map((f) => ({ name: f.name, size: f.size })),
      });
    } catch (e) {
      // Nothing was created (one transaction): back to the form with the reason.
      setPhase('form');
      if (e instanceof ApiError) { setError(e.message); setIssues(e.issues); } else setError('The connection was lost. Nothing was created; try again.');
      return;
    }
    setCreated(made);
    void qc.invalidateQueries({ queryKey: ['frameworks'] });
    setRows(made.documents.map((d, i) => ({ key: d.id, file: files[i]!, documentId: d.id, title: d.title, status: 'waiting' as const, error: '' })));
    await upload(made, made.documents.map((d) => d.id));
  };

  const guardedClose = () => { if (!busy) onClose(); };
  const failed = rows.filter((r) => r.status === 'failed');
  const saved = rows.filter((r) => r.status === 'saved').length;

  return (
    <Dialog labelledBy="from-files-title" onClose={guardedClose} size="lg">
      <div className="mb-4 flex items-start justify-between gap-2">
        <h2 id="from-files-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">Create from files</h2>
        <Button type="button" variant="ghost" aria-label="Close" disabled={busy} onClick={guardedClose}>✕</Button>
      </div>

      {phase === 'form' && (
        <form className="space-y-4" aria-label="Create from files" onSubmit={(e) => { e.preventDefault(); if (valid) void create(); }}>
          <p className="text-sm text-muted-foreground">Add the accreditor's documents (the standards, handbooks, guides, spreadsheets). They are read and analysed in the background: the requirements are drafted for you to review, and links to your own standards are proposed.</p>
          <fieldset className="space-y-3">
            <legend className="mb-1 font-medium">The standard</legend>
            <label className="flex flex-col text-sm">Accreditor
              <select aria-label="Accreditor" value={chosen} onChange={(e) => setAccreditorId(e.target.value)} className={select}>
                {accreditors.map((a) => <option key={a.id} value={a.id}>{a.shortName} · {a.name}</option>)}
                <option value={NEW_ACCREDITOR}>A new accreditor…</option>
              </select>
            </label>
            {isNew && (
              <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
                <label className="flex flex-col text-sm">Accreditor name<Input aria-label="Accreditor name" value={accName} onChange={(e) => setAccName(e.target.value)} dir="auto" required /></label>
                <label className="flex flex-col text-sm">Short name<Input aria-label="Accreditor short name" value={accShort} onChange={(e) => setAccShort(e.target.value)} dir="auto" required /></label>
              </div>
            )}
            <label className="flex flex-col text-sm">Standard name<Input aria-label="Standard name" value={name} onChange={(e) => setName(e.target.value)} dir="auto" required /></label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col text-sm">Scope
                <select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className={select}>
                  <option value="institution">Institutional</option><option value="program">Programmatic</option><option value="both">Institutional and programmatic</option>
                </select>
              </label>
              <label className="flex flex-col text-sm">Edition<Input aria-label="Edition" value={edition} onChange={(e) => setEdition(e.target.value)} placeholder="e.g. 2027 or 2027-28" dir="auto" required /></label>
            </div>
            <p className="text-xs text-muted-foreground">Not sure of the name, scope or edition? Give your best guess: the analysis can suggest them later, and the name and scope can be changed in the standard's details.</p>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-1 font-medium">The files</legend>
            <FileDrop onFiles={addFiles} label="Drop files here" note={`Up to ${formatBytes(maxBytes)} each, ${maxFiles} files at most. Arabic or English.`} />
            {files.length > 0 && (
              <ul aria-label="Chosen files" className="divide-y divide-border rounded-md border border-border">
                {files.map((f) => (
                  <li key={`${f.name}-${f.size}-${f.lastModified}`} className="flex items-start gap-2 px-3 py-2" data-testid="chosen-file">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm break-words [overflow-wrap:anywhere]"><ContentText>{f.name}</ContentText></span>
                      <span className="block text-xs text-muted-foreground">{fileKind(f.name)} · {formatBytes(f.size)}</span>
                      {f.size > maxBytes && <span role="alert" className="block text-xs text-red-700">This file is larger than {formatBytes(maxBytes)}. Remove it, or split it into smaller files.</span>}
                      {f.size === 0 && <span role="alert" className="block text-xs text-red-700">This file is empty.</span>}
                      {f.size > 0 && f.size <= maxBytes && !isReadableKind(f.name) && <span className="block text-xs text-amber-800">This kind of file may not be readable.</span>}
                    </span>
                    <Button type="button" variant="ghost" className="shrink-0 px-2 py-1" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x !== f))}>Remove</Button>
                  </li>
                ))}
              </ul>
            )}
            {files.length > maxFiles && <p role="alert" className="text-xs text-red-700">At most {maxFiles} files at a time; remove {files.length - maxFiles}.</p>}
          </fieldset>

          {error && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              <p>{error}</p>
              {issues.length > 0 && <ul className="mt-1 list-disc space-y-1 ps-5">{issues.map((i, n) => <li key={n}>{i.message}</li>)}</ul>}
              <p className="mt-1 text-xs">Nothing was created.</p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!valid}>Create and analyse</Button>
          </div>
        </form>
      )}

      {phase !== 'form' && (
        <div className="space-y-4" aria-live="polite">
          {created ? (
            <section aria-label="What was created" className="rounded-md border border-border bg-muted/30 p-3 text-sm" data-testid="created-summary">
              <p className="font-medium">Created</p>
              <ul className="mt-1 list-disc space-y-0.5 ps-5">
                <li>Accreditor <ContentText>{created.accreditor.name}</ContentText> ({created.accreditor.created ? 'new' : 'already in the library'})</li>
                <li>Standard <ContentText>{created.framework.name}</ContentText></li>
                <li>Draft edition <ContentText>{created.version.edition}</ContentText> with {created.documents.length} source{created.documents.length === 1 ? '' : 's'}</li>
              </ul>
            </section>
          ) : <p role="status">Creating the standard…</p>}
          {rows.length > 0 && (
            <ul aria-label="Upload progress" className="divide-y divide-border rounded-md border border-border">
              {rows.map((r) => (
                <li key={r.key} className="flex flex-wrap items-start gap-2 px-3 py-2" data-testid="upload-row">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm break-words [overflow-wrap:anywhere]"><ContentText>{r.file.name}</ContentText></span>
                    <span className="block text-xs text-muted-foreground">{fileKind(r.file.name)} · {formatBytes(r.file.size)}</span>
                    {r.error && <span role="alert" className="block text-xs text-red-700">{r.error}</span>}
                  </span>
                  <span role="status" aria-label={`Status of ${r.file.name}`} className={`rounded px-2 py-0.5 text-xs ${STATUS_CLS[r.status]}`}>{STATUS_TEXT[r.status]}</span>
                  {r.status === 'failed' && created && <Button type="button" variant="outline" className="px-2 py-1" aria-label={`Retry ${r.file.name}`} onClick={() => void upload(created, [r.key])}>Retry</Button>}
                </li>
              ))}
            </ul>
          )}
          {created && phase === 'working' && <p className="text-sm text-muted-foreground">Saving the files. Please keep this window open until it is done.</p>}
          {analysis.state === 'starting' && <p role="status" className="text-sm">Starting the analysis…</p>}
          {analysis.state === 'failed' && (
            <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p>The analysis did not start: {analysis.message}</p>
              <p className="mt-1 text-xs">The draft and the {saved} saved file{saved === 1 ? '' : 's'} are kept. Fix this, then press Analyse documents on the draft's Docs tab.</p>
            </div>
          )}
          {phase === 'result' && failed.length > 0 && (
            <p role="alert" className="text-sm text-red-700">{failed.length} of {rows.length} file{rows.length === 1 ? '' : 's'} could not be saved. Retry them here, or add them later under Docs. The analysis starts once every file is saved, or you can start it with the files that were.</p>
          )}
          {phase === 'result' && created && (
            <div className="flex flex-wrap justify-end gap-2">
              {analysis.state === 'failed' && saved > 0 && <Button type="button" variant="outline" onClick={() => void startAnalysis(created.version.id)}>Try the analysis again</Button>}
              {failed.length > 0 && analysis.state !== 'started' && saved > 0 && analysis.state !== 'failed' && <Button type="button" variant="outline" onClick={() => void startAnalysis(created.version.id)}>Analyse the saved files</Button>}
              <Button type="button" onClick={() => { onClose(); open(created.version.id); }}>Open the draft</Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
