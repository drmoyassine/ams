import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ContentText } from '../components/content-text';
import { AnswerForm } from '../components/evidence-requests';
import { Card } from '../components/ui/card';
import { useEvidenceApi, type EvidenceApi } from '../lib/evidence-api';

/**
 * The page a one-time link opens (DEC-018): no sign-in, only this request. One answer, then the link stops working.
 */
export function RespondPage({ token, api: override }: { token: string; api?: EvidenceApi }) {
  const api = useEvidenceApi(override);
  const req = useQuery({ queryKey: ['response-link', token], queryFn: () => api.requestByLink(token), retry: false });
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) { setError('Choose the file.'); return; }
    setBusy(true); setError('');
    try { await api.answerByLink(token, file, note.trim() || undefined); setSent(true); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      {req.isLoading && <p>Loading…</p>}
      {req.isError && !sent && (
        <Card><p role="alert" className="text-sm">This link has been used, has expired or is not valid. Ask the person who sent it for a new one.</p></Card>
      )}
      {sent && <Card><p role="status" className="text-sm">Thank you. Your file was received; you can close this page.</p></Card>}
      {req.data && !sent && (
        <>
          <div>
            <p className="text-sm text-muted-foreground"><ContentText>{req.data.institutionName}</ContentText></p>
            <h1 className="text-2xl font-semibold">Evidence requested</h1>
            <p className="text-sm text-muted-foreground">
              {req.data.requestedByName ? <>Asked by <ContentText>{req.data.requestedByName}</ContentText> · </> : null}
              For <ContentText>{`${req.data.internalCode}${req.data.internalTitle ? ` · ${req.data.internalTitle}` : ''}`}</ContentText>
              {req.data.dueDate ? ` · due ${req.data.dueDate}` : ''}
            </p>
          </div>
          <Card>
            <AnswerForm request={req.data} file={file} setFile={setFile} note={note} setNote={setNote} error={error} busy={busy} onSubmit={(e) => void submit(e)} />
          </Card>
          <p className="text-xs text-muted-foreground">This link works once. What you send is kept by the institution as evidence and reviewed by its staff.</p>
        </>
      )}
    </main>
  );
}
