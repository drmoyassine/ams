import { useState, type FormEvent } from 'react';
import type { EvidenceRequest } from '@ams/shared';
import type { EvidenceApi } from '../lib/evidence-api';
import { ContentText } from './content-text';
import { Modal } from './link-evidence-dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** Where a one-time link opens (DEC-018). */
export const responseUrl = (token: string) => `${window.location.origin}/respond/${token}`;

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** The state a request is in, in plain words: requested, overdue, supplied, cancelled. */
export function RequestStatus({ r }: { r: EvidenceRequest }) {
  const [label, cls] = r.status === 'supplied' ? ['Supplied', 'bg-emerald-50 text-emerald-900']
    : r.status === 'cancelled' ? ['Cancelled', 'bg-muted text-muted-foreground']
      : r.overdue ? ['Overdue', 'bg-red-50 text-red-900'] : ['Requested', 'bg-amber-50 text-amber-900'];
  return <span className={`rounded px-1.5 text-xs ${cls}`}>{label}</span>;
}

/** A one-time link, shown once, with a copy button. */
export function LinkBox({ token, email, expiresAt }: { token: string; email: string; expiresAt: string | null }) {
  const url = responseUrl(token);
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm" data-testid="response-link">
      <p>Send this link to <strong>{email}</strong>. It works once{expiresAt ? ` and until ${shortDate(expiresAt)}` : ''}; it will not be shown again.</p>
      <div className="flex gap-2">
        <Input readOnly aria-label="One-time link" value={url} onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" onClick={() => { void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => undefined); }}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
    </div>
  );
}

/** Ask a person for evidence on an item: what is needed, from whom (email), by when, and a note. */
export function RequestEvidenceDialog({ api, title, requirementId, initialWhat = '', onDone, onClose }: {
  api: EvidenceApi; title: string; requirementId: string; /** Pre-fills "What is needed", e.g. with the title of evidence to update. */ initialWhat?: string; onDone: () => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<{ request: EvidenceRequest; linkToken: string | null } | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    setBusy(true); setError('');
    try {
      const out = await api.request(requirementId, {
        title: text('title'), assigneeEmail: text('email'), ...(text('message') ? { message: text('message') } : {}), ...(text('due') ? { dueDate: text('due') } : {}),
      });
      setIssued(out);
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal labelledBy="request-evidence-title" onClose={onClose}>
      <div className="mb-1 flex items-center justify-between">
        <h2 id="request-evidence-title" className="text-xl font-semibold">Request evidence</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground"><ContentText>{title}</ContentText></p>
      {issued ? (
        <div className="space-y-3">
          {issued.linkToken
            ? <LinkBox token={issued.linkToken} email={issued.request.assigneeEmail} expiresAt={issued.request.linkExpiresAt} />
            : <p className="text-sm">Requested from <strong>{issued.request.assigneeName ?? issued.request.assigneeEmail}</strong>. It is in their requests in the AMS.</p>}
          <div className="flex justify-end"><Button type="button" onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="Request evidence">
          <label className="flex flex-col text-sm">What is needed<Input name="title" aria-label="What is needed" required dir="auto" defaultValue={initialWhat} placeholder="e.g. Graduate survey report 2025" /></label>
          <label className="flex flex-col text-sm">Ask (email)<Input name="email" type="email" aria-label="Ask (email)" required dir="ltr" /></label>
          <p className="-mt-2 text-xs text-muted-foreground">Someone with an AMS account answers in the AMS; anyone else gets a one-time link.</p>
          <label className="flex flex-col text-sm">Due date (optional)<Input name="due" type="date" aria-label="Due date" /></label>
          <label className="flex flex-col text-sm">Message (optional)
            <textarea name="message" aria-label="Message" rows={3} dir="auto" className="rounded-md border border-border p-2 text-sm" />
          </label>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Request'}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** The person asked uploads the file, with an optional note on what it is. */
export function AnswerRequestDialog({ request, onAnswer, onClose }: {
  request: Pick<EvidenceRequest, 'title' | 'message'>; onAnswer: (file: File, note: string) => Promise<unknown>; onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) { setError('Choose the file.'); return; }
    setBusy(true); setError('');
    try { await onAnswer(file, note.trim()); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal labelledBy="answer-title" onClose={onClose}>
      <div className="mb-4 flex items-center justify-between">
        <h2 id="answer-title" className="text-xl font-semibold">Supply evidence</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <AnswerForm request={request} file={file} setFile={setFile} note={note} setNote={setNote} error={error} busy={busy} onSubmit={submit} onCancel={onClose} />
    </Modal>
  );
}

/** The answer form, shared by the AMS dialog and the one-time link page. */
export function AnswerForm({ request, file, setFile, note, setNote, error, busy, onSubmit, onCancel }: {
  request: Pick<EvidenceRequest, 'title' | 'message'>; file: File | null; setFile: (f: File | null) => void; note: string; setNote: (s: string) => void;
  error: string; busy: boolean; onSubmit: (e: FormEvent) => void; onCancel?: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-3" aria-label="Supply evidence">
      <div className="text-sm">
        <p className="font-medium"><ContentText>{request.title}</ContentText></p>
        {request.message && <p className="whitespace-pre-line text-muted-foreground"><ContentText>{request.message}</ContentText></p>}
      </div>
      <label className="flex flex-col text-sm">File<input aria-label="File" type="file" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      {file && <p className="text-xs text-muted-foreground">{file.name}</p>}
      <label className="flex flex-col text-sm">Note (optional)
        <textarea aria-label="Note" rows={3} dir="auto" value={note} onChange={(e) => setNote(e.target.value)} className="rounded-md border border-border p-2 text-sm" placeholder="What this is, and anything the reviewer should know" />
      </label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send'}</Button>
      </div>
    </form>
  );
}

/**
 * Requests with who was asked, the due date and the state. Whoever may add evidence can cancel an open request or
 * issue a new link for it (the old one stops working).
 */
export function RequestList({ requests, api, canManage, onChange, setError, showTarget = false, onAnswer }: {
  requests: EvidenceRequest[]; api: EvidenceApi; canManage: boolean; onChange: () => void; setError: (m: string) => void; showTarget?: boolean;
  onAnswer?: (r: EvidenceRequest) => void;
}) {
  const [renewed, setRenewed] = useState<{ id: string; token: string; email: string; expiresAt: string | null } | null>(null);
  const act = (fn: () => Promise<unknown>) => { setError(''); fn().then(onChange, (e: Error) => setError(e.message)); };
  if (requests.length === 0) return <p className="text-sm text-muted-foreground">No requests.</p>;
  return (
    <ul className="space-y-2">
      {requests.map((r) => (
        <li key={r.id} className="rounded-md border border-border p-2 text-sm" data-testid="evidence-request">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium"><ContentText>{r.title}</ContentText></span>
            <RequestStatus r={r} />
            {r.dataItemId
              ? <span className="rounded bg-muted px-1.5 text-xs">Form</span>
              : showTarget && <span className="text-xs text-muted-foreground"><ContentText>{`Internal ${r.internalCode ?? ''}${r.internalTitle ? ` · ${r.internalTitle}` : ''}`}</ContentText></span>}
          </div>
          <p className="text-xs text-muted-foreground">
            {r.assigneeName ?? r.assigneeEmail}{r.assigneeHasAccount ? '' : ' (one-time link)'}
            {r.dueDate ? ` · due ${r.dueDate}` : ''}{r.requestedByName ? ` · asked by ${r.requestedByName}` : ''}
            {r.suppliedAt ? ` · supplied ${shortDate(r.suppliedAt)}` : ''}
          </p>
          {r.message && <p className="mt-1 whitespace-pre-line"><ContentText>{r.message}</ContentText></p>}
          {r.suppliedNote && <p className="mt-1 text-xs">Note: <ContentText>{r.suppliedNote}</ContentText></p>}
          {renewed?.id === r.id && <div className="mt-2"><LinkBox token={renewed.token} email={renewed.email} expiresAt={renewed.expiresAt} /></div>}
          <div className="mt-1 flex flex-wrap gap-2">
            {onAnswer && r.status === 'open' && <Button type="button" className="px-2 py-1 text-xs" onClick={() => onAnswer(r)}>{r.dataItemId ? 'Fill in the form' : 'Supply evidence'}</Button>}
            {canManage && r.status === 'open' && !r.assigneeHasAccount && (
              <Button type="button" variant="outline" className="px-2 py-1 text-xs" onClick={() => act(async () => {
                const out = await api.newRequestLink(r.id);
                setRenewed({ id: r.id, token: out.linkToken!, email: r.assigneeEmail, expiresAt: out.request.linkExpiresAt });
              })}>New link</Button>
            )}
            {canManage && r.status === 'open' && (
              <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => { if (window.confirm(`Cancel the request "${r.title}"?`)) act(() => api.cancelRequest(r.id)); }}>Cancel request</Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Ask people to fill in a data item's form: one request each; those without an account get a one-time link. */
export function RequestFormDialog({ api, item, onDone, onClose }: {
  api: EvidenceApi; item: { id: string; title: string }; onDone: () => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<{ request: EvidenceRequest; linkToken: string | null }[] | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const emails = text('emails').split(/[\s,;،]+/).filter(Boolean);
    setBusy(true); setError('');
    try {
      setIssued(await api.requestForm(item.id, { assigneeEmails: emails, ...(text('message') ? { message: text('message') } : {}), ...(text('due') ? { dueDate: text('due') } : {}) }));
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal labelledBy="request-form-title" onClose={onClose}>
      <div className="mb-1 flex items-center justify-between">
        <h2 id="request-form-title" className="text-xl font-semibold">Ask people to fill in the form</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground"><ContentText>{item.title}</ContentText></p>
      {issued ? (
        <div className="space-y-3">
          {issued.filter((i) => !i.linkToken).length > 0 && (
            <p className="text-sm">In their requests in the AMS: <strong>{issued.filter((i) => !i.linkToken).map((i) => i.request.assigneeName ?? i.request.assigneeEmail).join(', ')}</strong>.</p>
          )}
          {issued.filter((i) => i.linkToken).map((i) => <LinkBox key={i.request.id} token={i.linkToken!} email={i.request.assigneeEmail} expiresAt={i.request.linkExpiresAt} />)}
          <div className="flex justify-end"><Button type="button" onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="Ask people to fill in the form">
          <label className="flex flex-col text-sm">Ask (email addresses)
            <textarea name="emails" aria-label="Ask (email addresses)" rows={3} required dir="ltr" className="rounded-md border border-border p-2 text-sm" placeholder="One or more, separated by commas or new lines" />
          </label>
          <p className="-mt-2 text-xs text-muted-foreground">Each person gets their own request and answers once. People with an AMS account answer in the AMS; anyone else gets a one-time link.</p>
          <label className="flex flex-col text-sm">Due date (optional)<Input name="due" type="date" aria-label="Due date" /></label>
          <label className="flex flex-col text-sm">Message (optional)
            <textarea name="message" aria-label="Message" rows={3} dir="auto" className="rounded-md border border-border p-2 text-sm" />
          </label>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send requests'}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
