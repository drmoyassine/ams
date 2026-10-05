import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { ApiError, type FrameworkApi, type Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import type { Me } from '@ams/shared';

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Source documents and the page text that quote verification reads. File upload and OCR arrive with the compiler (M7). */
export function SourcesTab({ api, version, me }: { api: FrameworkApi; version: Version; me: Me | undefined }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const { data } = useQuery({ queryKey: ['documents', version.id], queryFn: () => api.documents(version.id) });
  const canWrite = version.status === 'draft' && can(me, 'framework:write');
  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await qc.invalidateQueries({ queryKey: ['documents', version.id] }); } catch (e) { if (e instanceof ApiError) setError(e.message); else throw e; } },
  });

  const addDoc = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    act.mutate(async () => {
      const title = String(f.get('title'));
      await api.addDocument(version.id, {
        title, role: String(f.get('role')) as 'standards', authority: String(f.get('authority')) as 'binding', language: String(f.get('language')),
        filePath: `manual/${title}`, sha256: await sha256Hex(title),
      });
      form.reset();
    });
  };
  const addPage = (docId: string) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    act.mutate(async () => { await api.addPage(docId, { pageNo: Number(f.get('pageNo')), text: String(f.get('text')), method: 'pdf_text' }); form.reset(); });
  };
  const select = 'rounded-md border border-border bg-background px-2 py-2 text-sm';

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <ul className="space-y-4">
        {(data ?? []).map((d) => (
          <li key={d.id} className="rounded border border-border p-3" data-testid="source-document">
            <p className="font-medium"><ContentText>{d.title}</ContentText> <span className="text-xs text-muted-foreground">{d.role} · {d.authority} · {d.pageCount ?? 0} pages</span></p>
            {canWrite && (
              <form onSubmit={addPage(d.id)} className="mt-2 space-y-2" aria-label={`Add page to ${d.title}`}>
                <div className="flex gap-2"><Input name="pageNo" type="number" min={1} required placeholder="Page" aria-label="Page number" className="w-24" /></div>
                <textarea name="text" required dir="auto" rows={3} aria-label="Page text" placeholder="Page text, as transcribed or extracted" className="w-full rounded-md border border-border p-2 text-sm" />
                <Button type="submit">Add page</Button>
              </form>
            )}
          </li>
        ))}
        {data?.length === 0 && <li className="text-sm text-muted-foreground">No source documents.</li>}
      </ul>
      {canWrite && (
        <form onSubmit={addDoc} className="space-y-2 rounded border border-dashed border-border p-3" aria-label="Add source document">
          <Input name="title" required placeholder="Document title" aria-label="Document title" dir="auto" />
          <div className="flex flex-wrap gap-2">
            <select name="role" aria-label="Role" className={select}>{['standards', 'policy_procedure', 'guidance', 'report_template', 'evidence_guidance', 'amendment', 'sample_report', 'correspondence', 'other'].map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}</select>
            <select name="authority" aria-label="Authority" className={select}><option value="binding">Binding</option><option value="interpretive">Interpretive</option><option value="informational">Informational</option></select>
            <Input name="language" defaultValue="en" aria-label="Language" className="w-20" />
          </div>
          <Button type="submit">Add document</Button>
        </form>
      )}
    </div>
  );
}
