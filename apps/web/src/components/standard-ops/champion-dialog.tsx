import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NodeAssignment, ScopeItemKind } from '@ams/shared';
import { useTranslation } from '../../i18n';
import { useAction } from '../../lib/use-action';
import { useScopeApi, type ScopeApi } from '../../lib/scope-api';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { ContentText } from '../content-text';
import { Dialog } from '../dialog';
import { Button } from '../ui/button';
import { ChampionText, ScopeText } from './assignment-summary';
import type { OpsTarget } from './scope-dialog';

const select = 'w-full rounded-md border border-border bg-background px-2 py-2 text-sm';

/**
 * Assign champion: who answers for a standard. An overall champion and, optionally, one per unit or program of its scope. Each
 * choice is saved at once as the requirement's OWN champion, overriding what it inherits (from its parent, or, for an external
 * requirement, from the mapped IQF items when they agree; otherwise the dialog says one is needed). "Back to inherited" removes
 * every own champion. Works on a published version too.
 */
export function ChampionDialog({ target, assignment, api: apiProp, settings, onClose }: { target: OpsTarget; assignment: NodeAssignment | undefined; api?: ScopeApi; settings?: SettingsApi; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useScopeApi(apiProp);
  const settingsApi = useSettingsApi(settings);
  const people = useQuery({ queryKey: ['people'], queryFn: () => settingsApi.people() });
  const items = useQuery({ queryKey: ['scope-items'], queryFn: () => api.items() });
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction(setError);
  const [overall, setOverall] = useState('');
  const [itemPick, setItemPick] = useState('');
  const [itemPerson, setItemPerson] = useState('');
  const target_ = { frameworkId: target.frameworkId, code: target.code };

  const own = assignment?.champion.own ?? [];
  const ownOverall = own.find((c) => c.itemKind === null);
  const ownItems = own.filter((c) => c.itemKind !== null);
  const effOverall = assignment?.champion.effective.find((c) => c.itemKind === null);
  const effItems = assignment?.champion.effective.filter((c) => c.itemKind !== null) ?? [];
  const inheritedOverall = own.length > 0 ? assignment?.champion.inherited.find((c) => c.itemKind === null) : undefined;
  const scope = assignment?.scope.effective ?? null;

  // The units or programs a per-item champion can be set for: those the scope lists; every one at the level when it says "all".
  const candidates = (() => {
    const out: { key: string; kind: ScopeItemKind; id: string; name: string }[] = [];
    for (const l of scope?.levels ?? []) {
      const kind: ScopeItemKind | null = l.kind === 'org_unit' ? 'org_unit' : l.kind === 'program' ? 'program' : null;
      if (!kind) continue;
      const source = l.all ? (kind === 'org_unit' ? items.data?.orgUnit : items.data?.program) ?? [] : l.items;
      for (const i of source) out.push({ key: `${kind}:${i.id}`, kind, id: i.id, name: i.nameEn });
    }
    const taken = new Set(ownItems.map((c) => `${c.itemKind}:${c.itemId}`));
    return out.filter((c, i) => !taken.has(c.key) && out.findIndex((o) => o.key === c.key) === i);
  })();

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { const r = await act(fn); if (r !== undefined) { await qc.invalidateQueries({ queryKey: ['requirement-context'] }); return true; } return false; } finally { setBusy(false); }
  };
  const personName = (id: string) => people.data?.find((p) => p.id === id)?.fullName;
  const peopleSelect = (label: string, value: string, onChange: (v: string) => void) => (
    <select aria-label={label} className={select} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('ops.champion.choose')}</option>
      {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
    </select>
  );

  return (
    <Dialog labelledBy="champion-dialog-title" onClose={onClose} size="lg">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="champion-dialog-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{t('ops.champion.title')}<span className="ms-2 text-base font-normal text-muted-foreground" dir="auto">{target.label}</span></h2>
        <Button type="button" variant="ghost" aria-label={t('common.close')} onClick={onClose}>✕</Button>
      </div>
      <p className="mb-3 text-sm text-muted-foreground"><ContentText>{target.title}</ContentText>. {t('ops.champion.intro')}</p>

      <section aria-label={t('ops.champion.current')} className="mb-3 rounded-md border border-border p-2 text-sm" data-testid="champion-current">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('ops.champion.current')}</p>
        {effOverall ? <p data-testid="champion-overall"><ChampionText c={effOverall} internal={target.internal} /></p> : <p className="text-muted-foreground">{t('ops.champion.none')}</p>}
        {effOverall?.needsOne && <p className="text-xs text-muted-foreground">{t('ops.champion.needsOneWhy')}</p>}
        {effItems.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs" aria-label={t('ops.champion.perItem')}>
            {effItems.map((c) => <li key={`${c.itemKind}:${c.itemId}`}><ContentText>{c.itemName}</ContentText>: <ChampionText c={c} internal={target.internal} /></li>)}
          </ul>
        )}
        {own.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="champion-inherited">
            {inheritedOverall ? <>{t('ops.champion.wouldBe')} <ChampionText c={inheritedOverall} internal={target.internal} /></> : t('ops.champion.wouldBeNone')}
          </p>
        )}
        {own.length > 0 && <Button type="button" variant="outline" className="mt-2 px-3 py-1" disabled={busy} onClick={() => void run(() => api.clearChampion({ ...target_, all: 'true' }))}>{t('ops.backToInherited')}</Button>}
      </section>

      <div className="space-y-4">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('ops.champion.overall')}</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-48 flex-1 text-sm">{t('ops.champion.person')}
              {peopleSelect(t('ops.champion.overallPerson'), overall || ownOverall?.userId || '', setOverall)}
            </label>
            <Button type="button" disabled={busy || !(overall || ownOverall?.userId) || (overall || ownOverall?.userId) === ownOverall?.userId} onClick={() => void run(() => api.setChampion({ ...target_, userId: overall })).then((ok) => { if (ok) setOverall(''); })}>{t('ops.champion.set')}</Button>
            {ownOverall && <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(() => api.clearChampion(target_))}>{t('common.remove')}</Button>}
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('ops.champion.perItem')}</h3>
          <p className="text-xs text-muted-foreground">{t('ops.champion.perItemHint')} {scope && <ScopeText scope={scope} />}</p>
          {ownItems.length > 0 && (
            <ul className="space-y-1" aria-label={t('ops.champion.ownItems')}>
              {ownItems.map((c) => (
                <li key={`${c.itemKind}:${c.itemId}`} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1"><ContentText>{assignment?.champion.effective.find((e) => e.itemId === c.itemId)?.itemName ?? c.itemId}</ContentText>: <ContentText>{c.userName ?? personName(c.userId)}</ContentText></span>
                  <Button type="button" variant="ghost" className="px-2 py-1" disabled={busy} onClick={() => void run(() => api.clearChampion({ ...target_, itemKind: c.itemKind!, itemId: c.itemId! }))}>{t('common.remove')}</Button>
                </li>
              ))}
            </ul>
          )}
          {candidates.length > 0 ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-40 flex-1 text-sm">{t('ops.champion.item')}
                <select aria-label={t('ops.champion.item')} className={select} value={itemPick} onChange={(e) => setItemPick(e.target.value)}>
                  <option value="">{t('ops.champion.chooseItem')}</option>
                  {candidates.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                </select>
              </label>
              <label className="min-w-40 flex-1 text-sm">{t('ops.champion.person')}{peopleSelect(t('ops.champion.itemPerson'), itemPerson, setItemPerson)}</label>
              <Button type="button" disabled={busy || !itemPick || !itemPerson} onClick={() => {
                const [kind, id] = itemPick.split(':') as [ScopeItemKind, string];
                void run(() => api.setChampion({ ...target_, userId: itemPerson, itemKind: kind, itemId: id })).then((ok) => { if (ok) { setItemPick(''); setItemPerson(''); } });
              }}>{t('ops.champion.addItem')}</Button>
            </div>
          ) : <p className="text-xs text-muted-foreground">{scope ? t('ops.champion.noItems') : t('ops.champion.noScope')}</p>}
        </div>
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <div className="mt-4 flex justify-end"><Button type="button" variant="outline" onClick={onClose}>{t('common.done')}</Button></div>
    </Dialog>
  );
}
