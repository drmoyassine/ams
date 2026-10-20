import { useQuery } from '@tanstack/react-query';
import { DataFormView } from '../components/data-form';
import { Card } from '../components/ui/card';
import { useEvidenceApi, type EvidenceApi } from '../lib/evidence-api';

/** A dataset's form for a signed-in person (DEC-020). */
export function AnswerFormPage({ itemId, api: override }: { itemId: string; api?: EvidenceApi }) {
  const api = useEvidenceApi(override);
  const form = useQuery({ queryKey: ['form-questions', itemId], queryFn: () => api.formQuestions(itemId), retry: false });
  return (
    <section className="mx-auto max-w-2xl space-y-4">
      {form.isLoading && <p>Loading…</p>}
      {form.isError && <Card><p role="alert" className="text-sm">This form is not taking responses.</p></Card>}
      {form.data && <DataFormView form={form.data} onSubmit={(r) => api.submitResponse(itemId, r)} />}
    </section>
  );
}

/** The page a public form link opens (DEC-020): no sign-in, only this form. */
export function PublicFormPage({ token, api: override }: { token: string; api?: EvidenceApi }) {
  const api = useEvidenceApi(override);
  const form = useQuery({ queryKey: ['form-link', token], queryFn: () => api.formByLink(token), retry: false });
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      {form.isLoading && <p>Loading…</p>}
      {form.isError && <Card><p role="alert" className="text-sm">This form is closed or the link is no longer valid.</p></Card>}
      {form.data && (
        <>
          <DataFormView form={form.data} onSubmit={(r) => api.submitByFormLink(token, r)} />
          <p className="text-xs text-muted-foreground">Your answers are kept by the institution and reviewed by its staff.</p>
        </>
      )}
    </main>
  );
}
