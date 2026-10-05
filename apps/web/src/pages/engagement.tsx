import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ContentText } from '../components/content-text';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { useEngagementApi, type EngagementApi } from '../lib/engagement-api';
import { ApiError } from '../lib/framework-api';
import { useAction } from '../lib/use-action';
import { can, useMe } from '../lib/me';
import { MembersTab } from './engagement/members-tab';
import { RequirementsTab } from './engagement/requirements-tab';
import { RoadmapTab } from './engagement/roadmap-tab';
import { TemplateUpdatePanel } from './engagement/template-update';

const KEY_DATES = [
  ['submission_date', 'Submission date'], ['visit_date', 'Visit date'], ['decision_date', 'Decision date'], ['expiry_date', 'Accreditation expiry date'],
] as const;

function KeyDates({ api, id, dates, canEdit }: { api: EngagementApi; id: string; dates: Record<string, string | null>; canEdit: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const save = useMutation({
    mutationFn: (v: { key: string; value: string }) => act(() => api.update(id, { keyDates: { [v.key]: v.value || null } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engagement', id] }),
  });
  return (
    <fieldset className="flex flex-wrap items-end gap-4">
      <legend className="mb-1 text-sm font-medium">Key dates</legend>
      {KEY_DATES.map(([k, label]) => (
        <label key={k} className="flex flex-col gap-1 text-sm">{label}
          <Input aria-label={label} type="date" disabled={!canEdit} defaultValue={dates[k] ?? ''} onBlur={(e) => { if (e.target.value !== (dates[k] ?? '')) save.mutate({ key: k, value: e.target.value }); }} className="w-44" />
        </label>
      ))}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </fieldset>
  );
}

const TABS = [['roadmap', 'Roadmap'], ['requirements', 'Requirements'], ['members', 'Members']] as const;

export function EngagementPage({ id, api: override }: { id: string; api?: EngagementApi }) {
  const api = useEngagementApi(override);
  const qc = useQueryClient();
  const me = useMe(api);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('roadmap');
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const { data, isError, error: loadError } = useQuery({ queryKey: ['engagement', id], queryFn: () => api.get(id) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['engagement', id] });
  const advance = useMutation({ mutationFn: () => act(() => api.advance(id)), onSuccess: refresh });
  const canManage = can(me.data, 'engagement:manage');

  if (isError) return <p role="alert">{loadError instanceof ApiError ? loadError.message : 'Could not load the engagement.'}</p>;
  if (!data) return <p>Loading…</p>;
  const e = data.engagement;
  const active = e.status === 'active';
  const current = data.phases.find((p) => p.current);

  return (
    <section>
      <header className="mb-4">
        <h1 className="text-2xl font-semibold"><ContentText>{e.title}</ContentText></h1>
        <p className="text-sm text-muted-foreground">
          {e.accreditorShortName} {e.edition} · {e.kind} · review year {e.reviewYear} · lead <ContentText>{e.leadName}</ContentText>
          {!active && <span className="ms-2 rounded bg-muted px-2 py-0.5">{e.status}</span>}
        </p>
      </header>

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3" aria-label="Phases">
          {data.phases.map((p) => (
            <div key={p.type} aria-current={p.current ? 'step' : undefined} className={`rounded-md border px-3 py-2 text-sm ${p.current ? 'border-primary bg-muted font-medium' : 'border-border'}`}>
              <div>{p.name}</div>
              <div className="text-xs text-muted-foreground">{p.requiredDone}/{p.requiredTotal} required</div>
            </div>
          ))}
          {canManage && active && (
            <Button type="button" className="ms-auto" disabled={!data.canAdvance || advance.isPending} onClick={() => advance.mutate()}
              title={data.canAdvance ? undefined : 'Every required milestone of the current phase must be done or skipped'}>
              Advance to next phase
            </Button>
          )}
        </div>
        {current && !data.canAdvance && active && <p className="mt-2 text-xs text-muted-foreground">Advance becomes available when every required milestone in {current.name} is done or skipped.</p>}
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      </Card>

      <Card className="mb-4"><KeyDates api={api} id={id} dates={e.keyDates} canEdit={canManage && active} />
        <p className="mt-2 text-sm"><a className="underline" href={api.calendarUrl(id)} download>Download calendar (.ics)</a></p>
      </Card>

      <TemplateUpdatePanel api={api} engagementId={id} canManage={canManage && active} onApplied={refresh} />

      <div role="tablist" aria-label="Engagement sections" className="mb-4 flex gap-2 border-b border-border">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'}`}>{label}</button>
        ))}
      </div>
      {tab === 'roadmap' && <RoadmapTab api={api} detail={data} canManage={canManage && active} onChanged={refresh} />}
      {tab === 'requirements' && <RequirementsTab api={api} detail={data} canManage={canManage && active} />}
      {tab === 'members' && <MembersTab api={api} detail={data} me={me.data} onChanged={refresh} />}
    </section>
  );
}
