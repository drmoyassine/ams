import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
import { can } from '../lib/me';
import { useOutcomesApi, type OutcomesApi } from '../lib/outcomes-api';
import { useSettingsApi, type SettingsApi } from '../lib/settings-api';
import type { AssessmentApi } from '../lib/assessment-api';
import { ProgramAssessmentCard } from './settings/program-assessment';
import { ProgramReviewCard, ReviewHeatmap } from './settings/program-review';

/**
 * Quality Management -> Programs: each program's assessment of learning (plan, attainment, results, actions) and its review against
 * the rubric, with the review across every program on top. This is the year's quality work; the program and its outcomes are set up
 * in Settings -> Organization -> Programs.
 */
export function ProgramQualityTab({ me, settings, outcomes, assessment }: { me: Me | undefined; settings?: SettingsApi; outcomes?: OutcomesApi; assessment?: AssessmentApi }) {
  const api = useSettingsApi(settings);
  const oapi = useOutcomesApi(outcomes);
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.programs() });
  const active = (programs.data ?? []).filter((p) => p.active).sort((a, b) => a.nameEn.localeCompare(b.nameEn));
  const [picked, setPicked] = useState('');
  const programId = picked || active[0]?.id || '';
  const v = useQuery({ queryKey: ['program-outcomes', programId], queryFn: () => oapi.programOutcomes(programId), enabled: !!programId });
  const canWrite = can(me, 'program:write');
  return (
    <div className="space-y-5">
      <ReviewHeatmap {...(outcomes ? { api: outcomes } : {})} onOpen={(id) => { setPicked(id); document.getElementById('program-quality')?.scrollIntoView?.({ block: 'start' }); }} />
      <div id="program-quality" className="space-y-4">
        <label className="flex min-w-0 flex-col gap-1 text-xs">Program
          <select aria-label="Program" className="w-full min-w-0 max-w-full rounded-md border border-border bg-background px-2 py-1 text-sm sm:w-80" value={programId} onChange={(e) => setPicked(e.target.value)}>
            {active.length === 0 && <option value="">No programs yet</option>}
            {active.map((p) => <option key={p.id} value={p.id}>{p.code ? `${p.code} · ` : ''}{p.nameEn}</option>)}
          </select>
        </label>
        {!programId ? <p className="text-sm text-muted-foreground">{programs.isError ? 'Could not load programs.' : programs.data ? 'Add a program first.' : 'Loading…'}</p>
          : !v.data ? <p className="text-sm text-muted-foreground">{v.isError ? 'Could not load the program.' : 'Loading…'}</p> : (
            <>
              <ProgramAssessmentCard key={`a-${programId}`} programId={programId} outcomes={v.data} canWrite={canWrite} {...(assessment ? { api: assessment } : {})} />
              <ProgramReviewCard key={`r-${programId}`} programId={programId} canWrite={canWrite} {...(outcomes ? { api: outcomes } : {})} />
            </>
          )}
      </div>
    </div>
  );
}
