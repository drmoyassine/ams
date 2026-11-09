// The Syllabi tab of Quality Management: one card per course with its approved version, the version in progress and the flag.
// Opening the tab also tells the next level of the line about flags that have gone unfixed past their days.
import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AccordionCard } from '../accordion';
import { Input } from '../ui/input';
import { useSyllabusApi, type SyllabusApi } from '../../lib/syllabus-api';
import { SyllabusImport } from './syllabus-import';
import { LINE, StatusChip } from './syllabus-panels';

const FILTERS = [['all', 'All'], ['flagged', 'With errors'], ['mine', 'Needs my attention']] as const;
type Filter = (typeof FILTERS)[number][0];
const chip = 'rounded px-1.5 py-0.5 text-xs';

export function SyllabiList({ api: override }: { api?: SyllabusApi }) {
  const api = useSyllabusApi(override);
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const [text, setText] = useState('');
  useEffect(() => { void api.escalate().catch(() => undefined); }, [api]);
  const list = useQuery({ queryKey: ['syllabi', filter], queryFn: () => api.list({ flagged: filter === 'flagged', mine: filter === 'mine' }) });
  const shown = (list.data ?? []).filter((r) => !text.trim() || `${r.code} ${r.titleEn}`.toLowerCase().includes(text.trim().toLowerCase()));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Each course has one syllabus, approved by its Dean. A syllabus with errors needs its coordinator at once and goes up the line while it is unfixed.</p>
      <SyllabusImport api={api} />
      <div className="flex flex-wrap items-center gap-3">
        <Input aria-label="Search syllabi" placeholder="Search by code or title" value={text} onChange={(e) => setText(e.target.value)} className="w-full sm:w-64" />
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
          {FILTERS.map(([k, name]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={`rounded-full border px-3 py-1 text-xs ${filter === k ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>{name}</button>)}
        </div>
      </div>
      <ul className="space-y-2" aria-label="Syllabi">
        {shown.map((r) => (
          <li key={r.courseId}>
            <AccordionCard label={`Syllabus: ${r.code}`} title={`${r.code} · ${r.titleEn}`} strong open={false} menuLabel={`Actions for ${r.code}`} menu={[]}
              subtitle={[r.unitName, r.coordinatorName ? `coordinator ${r.coordinatorName}` : 'no coordinator named'].filter(Boolean).join(' · ')}
              onToggle={() => { void navigate({ to: '/courses/$id/syllabus', params: { id: r.courseId } }); }}
              meta={(
                <span className="flex flex-wrap items-center gap-1.5">
                  {r.openStatus && <StatusChip status={r.openStatus} />}
                  {r.currentVersionNo !== null ? <span className={`${chip} bg-emerald-50 text-emerald-900`}>Approved v{r.currentVersionNo}</span> : <span className={`${chip} bg-muted`}>Not approved</span>}
                  {r.errorCount > 0 && <span className={`${chip} bg-red-100 text-red-900`} data-testid="errors-chip">{r.errorCount} error{r.errorCount === 1 ? '' : 's'}{r.escalationLevel > 0 ? ` · with ${LINE[r.escalationLevel]}` : ''}</span>}
                  {r.warningCount > 0 && <span className={`${chip} bg-amber-100 text-amber-900`}>{r.warningCount} warning{r.warningCount === 1 ? '' : 's'}</span>}
                  {r.needsMyAttention && <span className={`${chip} bg-red-600 text-white`}>Needs you</span>}
                </span>
              )} />
          </li>
        ))}
        {list.data && shown.length === 0 && <li className="text-sm text-muted-foreground">{filter === 'all' && !text ? 'No courses yet.' : 'Nothing matches.'}</li>}
      </ul>
    </div>
  );
}
