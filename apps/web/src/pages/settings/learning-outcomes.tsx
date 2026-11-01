import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OutcomeLevel } from '@ams/shared';
import { LinkChip, OutcomeList, patchOf } from '../../components/outcomes/outcome-list';
import { ReadOnlyNote } from '../../components/read-only-note';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useConfirm } from '../../components/confirm-dialog';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useAction } from '../../lib/use-action';
import type { AssessmentApi } from '../../lib/assessment-api';
import { BenchmarksCard, IloRotationCard } from './ilo-rotation';

/**
 * Settings -> Organization -> Learning outcomes (TASK-112): the institution's learning outcomes (ILOs, which every program's PLOs link
 * to) and the CLO-PLO mapping levels (DEC-036).
 */
export function LearningOutcomesSection({ api: override, assessment, canEdit }: { api?: OutcomesApi; assessment?: AssessmentApi; canEdit: boolean }) {
  const api = useOutcomesApi(override);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const ilos = useQuery({ queryKey: ['ilos'], queryFn: () => api.ilos() });
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ilos'] }); void qc.invalidateQueries({ queryKey: ['program-outcomes'] }); } });
  return (
    <div className="space-y-6">
      <Card>
        <h3 className="mb-1 text-lg font-semibold">Institutional learning outcomes</h3>
        <p className="mb-3 text-sm text-muted-foreground">What every graduate achieves, whatever the program. Each program links its PLOs to them. Keep one approved list with fixed numbering.</p>
        <ReadOnlyNote show={!canEdit} className="mb-3" />
        {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
        <OutcomeList label="ILO" items={ilos.data ?? []} canWrite={canEdit} codeHint="ILO1" empty="No institutional learning outcomes yet."
          onAdd={(d) => run.mutate(() => api.createOutcome({ kind: 'ilo', ...patchOf(d), code: d.code, textEn: d.textEn }))}
          onSave={(id, d) => run.mutate(() => api.updateOutcome(id, patchOf(d)))}
          onDelete={(o) => { void confirm({ title: `Delete ${o.code}?`, message: 'The draft and its links to PLOs are deleted.', confirmLabel: 'Delete', tone: 'danger' }).then((ok) => { if (ok) run.mutate(() => api.deleteOutcome(o.id)); }); }} />
      </Card>
      <IloRotationCard {...(assessment ? { api: assessment } : {})} canEdit={canEdit} />
      <LevelsCard api={api} canEdit={canEdit} />
      <BenchmarksCard {...(assessment ? { api: assessment } : {})} canEdit={canEdit} />
    </div>
  );
}

function LevelsCard({ api, canEdit }: { api: OutcomesApi; canEdit: boolean }) {
  const levels = useQuery({ queryKey: ['outcome-levels'], queryFn: () => api.levels() });
  if (!levels.data) return <Card><p className="text-sm text-muted-foreground">Loading…</p></Card>;
  return <LevelsForm key={JSON.stringify(levels.data)} api={api} canEdit={canEdit} initial={levels.data} />;
}

function LevelsForm({ api, canEdit, initial }: { api: OutcomesApi; canEdit: boolean; initial: OutcomeLevel[] }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState(initial.map((l) => ({ ...l, aliasText: l.aliases.join(', ') })));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const act = useAction(setError);
  const save = useMutation({
    mutationFn: async () => {
      setError(null); setSaved(false);
      const r = await act(() => api.setLevels(rows.map(({ aliasText, ...l }) => ({ ...l, aliases: aliasText.split(',').map((a) => a.trim()).filter(Boolean) }))));
      if (r) { setSaved(true); await qc.invalidateQueries({ queryKey: ['outcome-levels'] }); }
    },
  });
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : patch.mastery ? { ...r, mastery: false } : r)));
  return (
    <Card>
      <h3 className="mb-1 text-lg font-semibold">Mapping levels</h3>
      <p className="mb-3 text-sm text-muted-foreground">How strongly a course outcome develops a program outcome, lowest first. Aliases are read as the level when maps are imported (e.g. D for Developed). One level counts as mastery for the coverage checks.</p>
      <table className="w-full text-sm" aria-label="Mapping levels">
        <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1">Code</th><th>Name</th><th>Aliases</th><th>Mastery</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="py-1 pe-2"><Input aria-label={`Level ${i + 1} code`} className="w-16" value={r.code} disabled={!canEdit} onChange={(e) => set(i, { code: e.target.value })} /></td>
              <td className="pe-2"><Input aria-label={`Level ${i + 1} name`} value={r.name} disabled={!canEdit} onChange={(e) => set(i, { name: e.target.value })} /></td>
              <td className="pe-2"><Input aria-label={`Level ${i + 1} aliases`} className="w-24" value={r.aliasText} disabled={!canEdit} onChange={(e) => set(i, { aliasText: e.target.value })} /></td>
              <td><LinkChip label={r.mastery ? 'Mastery' : 'Set as mastery'} title="The level a PLO must reach somewhere in the curriculum" on={r.mastery} disabled={!canEdit} onToggle={() => set(i, { mastery: true })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" className="px-3 py-1" disabled={rows.length >= 6} onClick={() => setRows([...rows, { code: '', name: '', aliases: [], mastery: false, aliasText: '' }])}>Add level</Button>
          {rows.length > 1 && <Button type="button" variant="ghost" className="px-3 py-1" onClick={() => setRows(rows.slice(0, -1))}>Remove last</Button>}
          <Button type="button" onClick={() => save.mutate()}>Save levels</Button>
          {saved && <span role="status" className="text-sm text-emerald-700">Saved</span>}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </Card>
  );
}
