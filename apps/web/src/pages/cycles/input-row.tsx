// One input of a stage: what it reads and whether that is there. A missing input is flagged, never blocking. It points at an output of an
// earlier stage (a link to it), at the previous run's output (a link to that cycle), or is something the stage owner picks: a document,
// an evidence item or a requirement (a picker).
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { CycleInput, CycleRefKind, CycleStage } from '@ams/shared';
import { Dialog } from '../../components/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Chip, OUTPUT_TONE, fieldCls, outputStateLabels, refKindLabels, selectCls } from '../../components/cycles/labels';
import type { CycleApis } from '../../components/cycles/directory';
import { useTranslation } from '../../i18n';
import { useDocumentsApi } from '../../lib/documents-api';
import { useEvidenceApi } from '../../lib/evidence-api';
import { useApi } from '../../lib/me';
import type { T } from '../settings/quality-management/labels';
import { pickLabels } from '../settings/quality-management/labels';
import { DialogTitle } from './dialogs';
import type { CycleEnv } from './env';

const small = 'px-3 py-1';
const FITS: Record<string, CycleRefKind[]> = { document: ['document'], evidence: ['evidence_item'], requirement: ['requirement'], any: ['document', 'evidence_item', 'requirement'] };

export function InputRow({ input, stage, env }: { input: CycleInput; stage: CycleStage; env: CycleEnv }) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const { cycle, busy, run, api } = env;
  const [picking, setPicking] = useState(false);
  const states = outputStateLabels(t);
  const refLabels = refKindLabels(t);
  const draft = cycle.status === 'draft';
  // The owner (or anyone who may work the stage) picks while the stage is open; a completed or skipped stage no longer changes.
  const canPick = cycle.status === 'active' && stage.canWork && (stage.status === 'not_started' || stage.status === 'in_progress');
  const from = input.outputId && input.outputCycleId === cycle.id ? cycle.stages.find((s) => s.outputs.some((o) => o.id === input.outputId)) : undefined;
  return (
    <li data-testid="input-row" data-satisfied={input.satisfied} className="space-y-1 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 break-words text-sm font-medium" dir="auto">{input.name}</p>
        {input.satisfied
          ? <Chip tone="good" testId="input-state">{t('qmc.in.ready')}</Chip>
          : <Chip tone={input.required ? 'warn' : 'neutral'} testId="input-state">{input.required ? t('qmc.in.missing') : t('qmc.in.notYet')}</Chip>}
        {!input.required && <span className="text-xs text-muted-foreground">{t('qmc.in.optional')}</span>}
        {draft && env.manage && <Button type="button" variant="ghost" className={`${small} ms-auto text-red-700`} disabled={busy} aria-label={t('qmc.in.removeNamed', { name: input.name })} onClick={() => void run(() => api.deleteInput(input.id), { at: stage.id })}>{t('common.remove')}</Button>}
      </div>

      {input.source === 'stage_output' && (
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          {input.outputName
            ? (
              <>
                <span>{t('qmc.in.fromStage')}</span>
                {from ? <button type="button" className="break-words text-start underline" dir="auto" onClick={() => env.focusStage(from.id)}>{input.outputStageName}</button> : <span dir="auto">{input.outputStageName}</span>}
                <span dir="auto">→ {input.outputName}</span>
                {input.outputState && <Chip tone={OUTPUT_TONE[input.outputState]}>{states[input.outputState]}</Chip>}
              </>
            )
            : <span>{t('qmc.in.noOutput')}</span>}
        </p>
      )}
      {input.source === 'previous_cycle' && (
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          {input.previousMissing
            ? <span data-testid="previous-missing">{t('qmc.in.noPrevious')}</span>
            : (
              <>
                <span>{t('qmc.in.fromPrevious')}</span>
                <span dir="auto">{input.outputStageName} → {input.outputName}</span>
                {input.outputState && <Chip tone={OUTPUT_TONE[input.outputState]}>{states[input.outputState]}</Chip>}
                {input.outputCycleId && <Link className="underline" to="/quality-management/cycles/$id" params={{ id: input.outputCycleId }}>{t('qmc.in.openPrevious')}</Link>}
              </>
            )}
        </p>
      )}
      {input.source === 'pick' && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {input.refId
            ? <span className="min-w-0 break-words" dir="auto" data-testid="pick-value"><span className="text-muted-foreground">{refLabels[input.refKind ?? 'document']}: </span>{input.refName ?? t('qmc.in.unnamed')}</span>
            : <span className="text-muted-foreground">{t('qmc.in.pickHint', { kind: input.pickKind ? pickLabels(t)[input.pickKind] : '' })}</span>}
          {canPick && <Button type="button" variant="outline" className={small} disabled={busy} aria-label={t(input.refId ? 'qmc.in.changeNamed' : 'qmc.in.pickNamed', { name: input.name })} onClick={() => setPicking(true)}>{input.refId ? t('qmc.in.change') : t('qmc.in.pick')}</Button>}
          {canPick && input.refId && <Button type="button" variant="ghost" className={small} disabled={busy} aria-label={t('qmc.in.clearNamed', { name: input.name })} onClick={() => void run(() => api.setPick(input.id, { refKind: null, refId: null }), { at: stage.id })}>{t('qmc.in.clear')}</Button>}
        </div>
      )}
      {picking && (
        <PickDialog input={input} apis={env.apis} onClose={() => setPicking(false)}
          onPick={(refKind, refId) => { setPicking(false); void run(() => api.setPick(input.id, { refKind, refId }), { at: stage.id }); }} />
      )}
    </li>
  );
}

interface Choice { id: string; name: string }

/** Chooses what fills a picked input: a document, an evidence item or a requirement of the institution's own framework. */
function PickDialog({ input, apis, onPick, onClose }: { input: CycleInput; apis: CycleApis; onPick: (kind: CycleRefKind, id: string) => void; onClose: () => void }) {
  const { t, } = useTranslation();
  const refLabels = refKindLabels(t as unknown as T);
  const kinds = FITS[input.pickKind ?? 'any']!;
  const [kind, setKind] = useState<CycleRefKind>(kinds[0]!);
  const [q, setQ] = useState('');
  const documents = useDocumentsApi(apis.documents);
  const evidence = useEvidenceApi(apis.evidence);
  const framework = useApi(apis.framework);
  const choices = useQuery({
    queryKey: ['cycle-pick', kind, kind === 'requirement' ? '' : q],
    queryFn: async (): Promise<Choice[]> => {
      if (kind === 'document') return (await documents.library({ ...(q ? { q } : {}) })).items.filter((d) => d.source === 'import').map((d) => ({ id: d.id, name: d.name }));
      if (kind === 'evidence_item') return (await evidence.list(q || undefined)).map((e) => ({ id: e.id, name: e.title }));
      const qf = await framework.qualityFramework();
      const v = [...qf.versions].reverse().find((x) => x.status === 'published') ?? qf.versions[qf.versions.length - 1];
      return v ? (await framework.requirements(v.id)).map((r) => ({ id: r.id, name: `${r.code} ${r.title}` })) : [];
    },
  });
  const needle = q.trim().toLowerCase();
  const shown = (choices.data ?? []).filter((c) => kind !== 'requirement' || !needle || c.name.toLowerCase().includes(needle)).slice(0, 50);
  return (
    <Dialog labelledBy="pick-title" onClose={onClose}>
      <DialogTitle id="pick-title" onClose={onClose}>{t('qmc.pick.title', { name: input.name })}</DialogTitle>
      <div className="space-y-3">
        {kinds.length > 1 && (
          <label className={fieldCls}>{t('qmc.pick.kind')}
            <select aria-label={t('qmc.pick.kind')} className={selectCls} value={kind} onChange={(e) => { setKind(e.target.value as CycleRefKind); setQ(''); }}>
              {kinds.map((k) => <option key={k} value={k}>{refLabels[k]}</option>)}
            </select>
          </label>
        )}
        <label className={fieldCls}>{t('common.search')}<Input aria-label={t('common.search')} dir="auto" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></label>
        {choices.isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
        {choices.isError && <p role="alert" className="text-sm text-red-700">{(choices.error as Error).message}</p>}
        {choices.isSuccess && shown.length === 0 && <p className="text-sm text-muted-foreground">{t('qmc.pick.none')}</p>}
        <ul className="max-h-72 space-y-1 overflow-y-auto" aria-label={t('qmc.pick.list')}>
          {shown.map((c) => (
            <li key={c.id}><button type="button" className="w-full break-words rounded-md border border-border px-3 py-2 text-start text-sm hover:bg-muted" dir="auto" onClick={() => onPick(kind, c.id)}>{c.name}</button></li>
          ))}
        </ul>
        <div className="flex justify-end"><Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button></div>
      </div>
    </Dialog>
  );
}
