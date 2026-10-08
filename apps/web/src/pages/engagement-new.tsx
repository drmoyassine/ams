import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { useEngagementApi, type EngagementApi } from '../lib/engagement-api';
import { ApiError } from '../lib/framework-api';
import { useMe } from '../lib/me';

const KEY_DATES = [
  ['submission_date', 'Submission date'], ['visit_date', 'Visit date'], ['decision_date', 'Decision date'], ['expiry_date', 'Accreditation expiry date'],
] as const;

/** The one-screen wizard (PRD 8.1): subject, published framework version, kind, review year, key dates and the lead. */
export function NewEngagementPage({ api: override, onCreated }: { api?: EngagementApi; onCreated?: (id: string) => void }) {
  const api = useEngagementApi(override);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe(api);
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.programs() });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.users() });
  const frameworks = useQuery({ queryKey: ['frameworks'], queryFn: () => api.frameworks() });
  const published = useQuery({
    queryKey: ['published-versions', frameworks.data?.map((f) => f.id)],
    enabled: !!frameworks.data,
    queryFn: async () => (await Promise.all(frameworks.data!.map(async (f) => (await api.versions(f.id)).filter((v) => v.status === 'published').map((v) => ({ ...v, framework: f }))))).flat(),
  });

  const [subjectType, setSubjectType] = useState<'program' | 'institution'>('program');
  const [subjectId, setSubjectId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [kind, setKind] = useState<'initial' | 'reaffirmation'>('initial');
  const [reviewYear, setReviewYear] = useState(String(new Date().getFullYear() + 1));
  const [dates, setDates] = useState<Record<string, string>>({});
  const [leadId, setLeadId] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fit = (published.data ?? []).filter((v) => v.framework.scope === 'both' || v.framework.scope === subjectType);
  const create = useMutation({
    mutationFn: async () => {
      setError(null);
      try {
        const keyDates = Object.fromEntries(Object.entries(dates).filter(([, v]) => v));
        const r = await api.create({
          frameworkVersionId: versionId, subjectType, subjectId: subjectType === 'institution' ? me.data?.institutionId ?? '' : subjectId, kind,
          reviewYear: Number(reviewYear), leadUserId: leadId, ...(Object.keys(keyDates).length ? { keyDates } : {}), ...(title ? { title } : {}),
        });
        await qc.invalidateQueries({ queryKey: ['engagements'] });
        if (onCreated) onCreated(r.engagement.id); else await navigate({ to: '/engagements/$id', params: { id: r.engagement.id } });
      } catch (e) {
        if (e instanceof ApiError) setError(e.issues.length ? `${e.message}: ${e.issues.map((i) => `${i.path} ${i.message}`).join('; ')}` : e.message); else throw e;
      }
    },
  });
  const ready = !!versionId && !!leadId && Number(reviewYear) > 1989 && (subjectType === 'institution' || !!subjectId);
  const submit = (e: FormEvent) => { e.preventDefault(); if (ready) create.mutate(); };
  const field = 'flex flex-col gap-1 text-sm';
  const select = 'rounded-md border border-border bg-background px-3 py-2 text-sm';

  return (
    <section className="max-w-2xl">
      <h1 className="mb-4 text-xl font-semibold sm:text-2xl">New engagement</h1>
      <Card>
        <form onSubmit={submit} className="flex flex-col gap-4" aria-label="New engagement">
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <legend className="mb-1 font-medium">Subject</legend>
            <label><input type="radio" name="subject" checked={subjectType === 'program'} onChange={() => { setSubjectType('program'); setVersionId(''); }} /> A program</label>
            <label><input type="radio" name="subject" checked={subjectType === 'institution'} onChange={() => { setSubjectType('institution'); setVersionId(''); }} /> The institution</label>
          </fieldset>
          {subjectType === 'program' && (
            <label className={field}>Program
              <select aria-label="Program" className={select} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">Choose a program</option>
                {(programs.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nameEn}</option>)}
              </select>
            </label>
          )}
          <label className={field}>Framework version (published only)
            <select aria-label="Framework version" className={select} value={versionId} onChange={(e) => setVersionId(e.target.value)}>
              <option value="">Choose a framework version</option>
              {fit.map((v) => <option key={v.id} value={v.id}>{v.framework.accreditorShortName} — {v.framework.name} ({v.edition})</option>)}
            </select>
          </label>
          <div className="flex gap-4">
            <label className={field}>Kind
              <select aria-label="Kind" className={select} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="initial">Initial accreditation</option>
                <option value="reaffirmation">Reaffirmation</option>
              </select>
            </label>
            <label className={field}>Review year
              <Input aria-label="Review year" type="number" value={reviewYear} onChange={(e) => setReviewYear(e.target.value)} className="w-28" />
            </label>
          </div>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-medium">Key dates (any you already know; dates that depend on them are worked out for you)</legend>
            {KEY_DATES.map(([k, label]) => (
              <label key={k} className={field}>{label}
                <Input aria-label={label} type="date" value={dates[k] ?? ''} onChange={(e) => setDates({ ...dates, [k]: e.target.value })} />
              </label>
            ))}
          </fieldset>
          <label className={field}>Engagement lead (required)
            <select aria-label="Engagement lead" className={select} value={leadId} onChange={(e) => setLeadId(e.target.value)}>
              <option value="">Choose the lead</option>
              {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.fullName} ({u.email})</option>)}
            </select>
          </label>
          <label className={field}>Title (optional)
            <Input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Generated from the framework, year and subject" />
          </label>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div><Button type="submit" disabled={!ready || create.isPending}>Create engagement</Button></div>
        </form>
      </Card>
    </section>
  );
}
