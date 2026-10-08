import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EvidenceRequest } from '@ams/shared';
import { DataFormView } from '../components/data-form';
import { AnswerRequestDialog, RequestList } from '../components/evidence-requests';
import { Modal } from '../components/link-evidence-dialog';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { useEvidenceApi, type EvidenceApi } from '../lib/evidence-api';
import { type FrameworkApi } from '../lib/framework-api';

/**
 * My requests (DEC-018): what others asked of me, to supply. A supplied file becomes evidence proposed on the item; a
 * reviewer approves it. Every request in the institution is followed up under Evidence → Requests.
 */
export function RequestsPage({ api: override }: { api?: EvidenceApi; framework?: FrameworkApi }) {
  const api = useEvidenceApi(override);
  const qc = useQueryClient();
  const [answering, setAnswering] = useState<EvidenceRequest | null>(null);
  const [error, setError] = useState('');
  const list = useQuery({ queryKey: ['evidence-requests', 'mine'], queryFn: () => api.requests(true) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['evidence-requests'] });
  const open = (list.data ?? []).filter((r) => r.status === 'open').length;
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold sm:text-2xl">My requests</h1>
      <p className="text-sm text-muted-foreground">
        {`Evidence others asked you for${open ? ` (${open} open)` : ''}. What you send is added as evidence and reviewed before it counts.`}
      </p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <Card>
        {list.data
          ? <RequestList requests={list.data} api={api} canManage={false} showTarget setError={setError} onChange={refresh} onAnswer={setAnswering} />
          : <p className="text-sm">Loading…</p>}
      </Card>
      {answering?.dataItemId && <FormAnswerDialog request={answering} api={api} onAnswered={refresh} onClose={() => setAnswering(null)} />}
      {answering && !answering.dataItemId && (
        <AnswerRequestDialog request={answering} onClose={() => setAnswering(null)}
          onAnswer={async (file, note) => { await api.answerRequest(answering.id, file, note || undefined); refresh(); }} />
      )}
    </section>
  );
}

/** A form request, answered in the AMS: the form, filled in once. */
function FormAnswerDialog({ request, api, onAnswered, onClose }: { request: EvidenceRequest; api: EvidenceApi; onAnswered: () => void; onClose: () => void }) {
  const form = useQuery({ queryKey: ['request-form', request.id], queryFn: () => api.formOfRequest(request.id) });
  return (
    <Modal labelledBy="form-answer-title" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="form-answer-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">Fill in the form</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      {form.isError && <p role="alert" className="text-sm text-red-700">{(form.error as Error).message}</p>}
      {form.data && <DataFormView once form={{ ...form.data, message: request.message }} onSubmit={async (r) => { await api.answerWithForm(request.id, r); onAnswered(); }} />}
    </Modal>
  );
}
