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
import { can, useApi, useMe } from '../lib/me';

/**
 * Evidence requests (DEC-018): what others asked of me, to supply, and every request in the institution, to follow up.
 * A supplied file becomes evidence proposed on the item; a reviewer approves it.
 */
export function RequestsPage({ api: override, framework }: { api?: EvidenceApi; framework?: FrameworkApi }) {
  const api = useEvidenceApi(override);
  const me = useMe(useApi(framework));
  const qc = useQueryClient();
  const [tab, setTab] = useState<'mine' | 'all'>('mine');
  const [answering, setAnswering] = useState<EvidenceRequest | null>(null);
  const [error, setError] = useState('');
  const list = useQuery({ queryKey: ['evidence-requests', tab], queryFn: () => api.requests(tab === 'mine') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['evidence-requests'] });
  const open = (list.data ?? []).filter((r) => r.status === 'open').length;
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Requests</h1>
      <div role="tablist" aria-label="Requests" className="flex gap-1 border-b border-border">
        {([['mine', 'Asked of me'], ['all', 'All requests']] as const).map(([k, label]) => (
          <Button key={k} type="button" role="tab" aria-selected={tab === k} variant="ghost"
            className={`rounded-b-none ${tab === k ? 'border-b-2 border-primary font-medium' : ''}`} onClick={() => setTab(k)}>{label}</Button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {tab === 'mine'
          ? `Evidence others asked you for${open ? ` (${open} open)` : ''}. What you send is added as evidence and reviewed before it counts.`
          : 'Every request for evidence, open ones first. Ask for evidence from a standard’s ⋯ menu in the internal quality framework.'}
      </p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <Card>
        {list.data
          ? <RequestList requests={list.data} api={api} canManage={tab === 'all' && can(me.data, 'evidence:write')} showTarget setError={setError} onChange={refresh}
              {...(tab === 'mine' ? { onAnswer: setAnswering } : {})} />
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
      <div className="mb-3 flex items-center justify-between">
        <h2 id="form-answer-title" className="text-xl font-semibold">Fill in the form</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      {form.isError && <p role="alert" className="text-sm text-red-700">{(form.error as Error).message}</p>}
      {form.data && <DataFormView once form={{ ...form.data, message: request.message }} onSubmit={async (r) => { await api.answerWithForm(request.id, r); onAnswered(); }} />}
    </Modal>
  );
}
