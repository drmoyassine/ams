import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card } from '../../components/ui/card';
import { ReadOnlyNote } from '../../components/read-only-note';
import { can, useMe } from '../../lib/me';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';
import { Coverage, CurriculumMap } from './program-outcomes';

/**
 * Settings -> Organization -> Curriculum map: pick a program, see its PLO x course map (built from the CLO-PLO links and their levels)
 * and its coverage checks. A cell opens the course's CLOs to map them to the PLO at a level.
 */
export function CurriculumMapPage({ api: override, outcomes }: { api?: SettingsApi; outcomes?: OutcomesApi }) {
  const api = useSettingsApi(override);
  const oapi = useOutcomesApi(outcomes);
  const qc = useQueryClient();
  const me = useMe(api);
  const canWrite = can(me.data, 'program:write');
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.programs() });
  const active = (programs.data ?? []).filter((p) => p.active).sort((a, b) => a.nameEn.localeCompare(b.nameEn));
  const [picked, setPicked] = useState('');
  const programId = picked || active[0]?.id || '';
  const key = ['program-outcomes', programId];
  const data = useQuery({ queryKey: key, queryFn: () => oapi.programOutcomes(programId), enabled: !!programId });
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['courses'] }); },
  });
  const v = data.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Curriculum map</h3>
          <p className="text-sm text-muted-foreground">Which courses introduce, reinforce and master each program learning outcome, from the links of their CLOs.</p>
          <ReadOnlyNote show={!!me.data && !canWrite} />
        </div>
        <label className="flex min-w-0 flex-col gap-1 text-xs">Program
          <select aria-label="Program" className="w-full min-w-0 max-w-full rounded-md border border-border bg-background px-2 py-1 text-sm sm:w-80" value={programId} onChange={(e) => setPicked(e.target.value)}>
            {active.length === 0 && <option value="">No programs yet</option>}
            {active.map((p) => <option key={p.id} value={p.id}>{p.code ? `${p.code} · ` : ''}{p.nameEn}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!programId ? <p className="text-sm text-muted-foreground">{programs.isError ? 'Could not load programs.' : programs.data ? 'Add a program first.' : 'Loading…'}</p>
        : !v ? <p className="text-sm text-muted-foreground">{data.isError ? 'Could not load the map.' : 'Loading…'}</p> : (
          <>
            <Card><CurriculumMap v={v} canWrite={canWrite} api={oapi} run={(fn) => run.mutate(fn)} /></Card>
            <Card><Coverage v={v} /></Card>
          </>
        )}
    </div>
  );
}
