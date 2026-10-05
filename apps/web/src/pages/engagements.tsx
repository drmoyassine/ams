import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ContentText } from '../components/content-text';
import { Card } from '../components/ui/card';
import { useEngagementApi, type EngagementApi } from '../lib/engagement-api';
import { can, useMe } from '../lib/me';

const STATUS = { active: 'Active', closed: 'Closed', withdrawn: 'Withdrawn' } as const;
const PHASE = { eligibility: 'Eligibility', self_study: 'Self-study', review: 'Review', decision: 'Decision', maintenance: 'Maintenance' } as const;

export function EngagementsPage({ api: override }: { api?: EngagementApi }) {
  const api = useEngagementApi(override);
  const me = useMe(api);
  const { data, isPending, isError } = useQuery({ queryKey: ['engagements'], queryFn: () => api.list() });
  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Engagements</h1>
        {can(me.data, 'engagement:create') && (
          <Link to="/engagements/new" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">New engagement</Link>
        )}
      </div>
      {isError && <p role="alert">Could not load engagements.</p>}
      {!isPending && data?.length === 0 && (
        <Card><p className="text-muted-foreground">No engagements yet. An engagement runs one accreditation cycle for an institution or a program, from eligibility to maintenance.</p></Card>
      )}
      {data && data.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Engagements">
          {data.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div>
                <Link to="/engagements/$id" params={{ id: e.id }} className="font-medium underline-offset-2 hover:underline"><ContentText>{e.title}</ContentText></Link>
                <p className="text-sm text-muted-foreground">
                  {e.accreditorShortName} · {e.kind} · review year {e.reviewYear} · lead <ContentText>{e.leadName}</ContentText>
                </p>
              </div>
              <div className="flex items-center gap-2 text-sm">
                {e.currentPhase && <span className="rounded border border-border px-2 py-0.5">{PHASE[e.currentPhase]}</span>}
                <span className="rounded bg-muted px-2 py-0.5">{STATUS[e.status]}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
