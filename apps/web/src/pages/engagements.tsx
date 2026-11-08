import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AccordionCard } from '../components/accordion';
import { PageHeader } from '../components/page-header';
import { Card } from '../components/ui/card';
import { useEngagementApi, type EngagementApi } from '../lib/engagement-api';
import { can, useMe } from '../lib/me';

const STATUS = { active: 'Active', closed: 'Closed', withdrawn: 'Withdrawn' } as const;
const PHASE = { eligibility: 'Eligibility', self_study: 'Self-study', review: 'Review', decision: 'Decision', maintenance: 'Maintenance' } as const;

export function EngagementsPage({ api: override }: { api?: EngagementApi }) {
  const api = useEngagementApi(override);
  const navigate = useNavigate();
  const me = useMe(api);
  const { data, isPending, isError } = useQuery({ queryKey: ['engagements'], queryFn: () => api.list() });
  return (
    <section className="space-y-4">
      <PageHeader title="Accreditation"
        action={can(me.data, 'engagement:create') && <Link to="/engagements/new" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">New engagement</Link>} />
      {isError && <p role="alert">Could not load engagements.</p>}
      {!isPending && data?.length === 0 && (
        <Card><p className="text-muted-foreground">No engagements yet. An engagement runs one accreditation cycle for an institution or a program, from eligibility to maintenance.</p></Card>
      )}
      {data && data.length > 0 && (
        <ul className="space-y-2" aria-label="Accreditation">
          {data.map((e) => (
            <li key={e.id}>
              {/* A row opens its engagement: the card chrome of the evidence and standards lists, without a body. */}
              <AccordionCard label={`Accreditation: ${e.title}`} title={e.title} strong open={false} menuLabel={`Actions for ${e.title}`} menu={[]}
                onToggle={() => { void navigate({ to: '/engagements/$id', params: { id: e.id } }); }}
                subtitle={`${e.accreditorShortName} · ${e.kind} · review year ${e.reviewYear} · lead ${e.leadName}`}
                meta={(
                  <span className="flex items-center gap-2 text-sm">
                    {e.currentPhase && <span className="rounded border border-border px-2 py-0.5">{PHASE[e.currentPhase]}</span>}
                    <span className="rounded bg-muted px-2 py-0.5">{STATUS[e.status]}</span>
                  </span>
                )} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
