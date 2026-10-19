import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NodeAssignment } from '@ams/shared';
import { useTranslation } from '../../i18n';
import { useAction } from '../../lib/use-action';
import { useScopeApi, type ScopeApi } from '../../lib/scope-api';
import { ContentText } from '../content-text';
import { Dialog } from '../dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScopeText, sourceLabel } from './assignment-summary';

export interface OpsTarget { frameworkId: string; versionId: string; code: string; title: string; label: string; internal: boolean }

/**
 * Assign scope: where a standard applies. A level (Institution, Unit, Program, Course, or one the institution added) and, for
 * units and programs, either all of them or a list. Saving sets the requirement's OWN scope, which overrides what it inherits;
 * the dialog shows what it inherits and from where, and "Back to inherited" removes the override. Works on a published version
 * too: scope lives outside the fixed version.
 */
export function ScopeDialog({ target, assignment, api: apiProp, onClose }: { target: OpsTarget; assignment: NodeAssignment | undefined; api?: ScopeApi; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useScopeApi(apiProp);
  const qc = useQueryClient();
  const levels = useQuery({ queryKey: ['scope-levels'], queryFn: () => api.levels() });
  const items = useQuery({ queryKey: ['scope-items'], queryFn: () => api.items() });
  const own = assignment?.scope.own ?? null;
  const effective = assignment?.scope.effective ?? null;
  const inherited = own ? assignment?.scope.inherited ?? null : effective;
  // Start from what is set; failing that from what is inherited (a single level), so overriding begins at the current value.
  const start = own ?? (effective && effective.levels.length === 1 ? { levelKey: effective.levels[0]!.levelKey, itemIds: effective.levels[0]!.items.map((i) => i.id) } : null);
  const [levelKey, setLevelKey] = useState(start?.levelKey ?? '');
  const [mode, setMode] = useState<'all' | 'some'>(start && start.itemIds.length > 0 ? 'some' : 'all');
  const [chosen, setChosen] = useState<Set<string>>(new Set(start?.itemIds ?? []));
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction(setError);

  const active = useMemo(() => (levels.data ?? []).filter((l) => l.active || l.key === own?.levelKey), [levels.data, own?.levelKey]);
  const level = active.find((l) => l.key === (levelKey || active[0]?.key));
  const list = level?.kind === 'org_unit' ? items.data?.orgUnit : level?.kind === 'program' ? items.data?.program : undefined;
  const shown = (list ?? []).filter((i) => !filter || i.nameEn.toLowerCase().includes(filter.toLowerCase()) || (i.nameAr ?? '').includes(filter));
  const hasList = level?.kind === 'org_unit' || level?.kind === 'program';
  const target_ = { frameworkId: target.frameworkId, code: target.code };

  const refresh = () => qc.invalidateQueries({ queryKey: ['requirement-context'] });
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { const r = await act(fn); if (r !== undefined) { await refresh(); return true; } return false; } finally { setBusy(false); }
  };
  const save = async () => {
    if (!level) return;
    if (await run(() => api.setScope({ ...target_, levelKey: level.key, itemIds: hasList && mode === 'some' ? [...chosen] : [] }))) onClose();
  };
  const back = async () => { await run(() => api.clearScope(target_)); };
  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const canSave = !!level && (!hasList || mode === 'all' || chosen.size > 0);

  return (
    <Dialog labelledBy="scope-dialog-title" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="scope-dialog-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{t('ops.scope.title')}<span className="ms-2 text-base font-normal text-muted-foreground" dir="auto">{target.label}</span></h2>
        <Button type="button" variant="ghost" aria-label={t('common.close')} onClick={onClose}>✕</Button>
      </div>
      <p className="mb-3 text-sm text-muted-foreground"><ContentText>{target.title}</ContentText>. {t('ops.scope.intro')}</p>

      <section aria-label={t('ops.scope.current')} className="mb-3 rounded-md border border-border p-2 text-sm" data-testid="scope-current">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('ops.scope.current')}</p>
        {effective ? <p><ScopeText scope={effective} /> <span className="text-muted-foreground" data-testid="scope-source">({sourceLabel(effective.sources, target.internal, t)})</span></p> : <p className="text-muted-foreground">{t('ops.scope.none')}</p>}
        {own && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="scope-inherited">
            {inherited ? <>{t('ops.scope.wouldBe')} <ScopeText scope={inherited} /> ({sourceLabel(inherited.sources, target.internal, t)})</> : t('ops.scope.wouldBeNone')}
          </p>
        )}
        {own && <Button type="button" variant="outline" className="mt-2 px-3 py-1" disabled={busy} onClick={() => void back()}>{t('ops.backToInherited')}</Button>}
      </section>

      <div className="space-y-3">
        <label className="flex flex-col text-sm">{t('ops.scope.level')}
          <select aria-label={t('ops.scope.level')} className="rounded-md border border-border bg-background px-2 py-2 text-sm" value={level?.key ?? ''}
            onChange={(e) => { setLevelKey(e.target.value); setChosen(new Set()); setMode('all'); }}>
            {active.map((l) => <option key={l.key} value={l.key}>{l.labelEn}{l.active ? '' : ` (${t('ops.scope.inactive')})`}</option>)}
          </select>
        </label>

        {level?.kind === 'course' && <p className="text-sm text-muted-foreground" data-testid="no-courses">{t('ops.scope.noCourses')}</p>}
        {level && !hasList && level.kind !== 'course' && <p className="text-sm text-muted-foreground">{t('ops.scope.noList', { level: level.labelEn })}</p>}
        {hasList && (
          <fieldset className="space-y-2">
            <legend className="text-sm">{t('ops.scope.which')}</legend>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="scope-mode" checked={mode === 'all'} onChange={() => setMode('all')} /> {t('ops.scope.allOf', { level: level!.labelEn })}</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="scope-mode" checked={mode === 'some'} onChange={() => setMode('some')} /> {t('ops.scope.onlyThese')}</label>
            {mode === 'some' && (
              <div className="ms-6 space-y-2">
                {(list?.length ?? 0) > 8 && <Input aria-label={t('ops.scope.filter')} placeholder={t('ops.scope.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />}
                {list && list.length === 0 && <p className="text-sm text-muted-foreground">{t('ops.scope.emptyList', { level: level!.labelEn })}</p>}
                <ul className="max-h-56 space-y-1 overflow-y-auto" aria-label={t('ops.scope.items')}>
                  {shown.map((i) => (
                    <li key={i.id}>
                      <label className="flex items-start gap-2 text-sm">
                        <input type="checkbox" className="mt-1" checked={chosen.has(i.id)} onChange={() => toggle(i.id)} />
                        <span className="min-w-0"><ContentText>{i.nameEn}</ContentText>{i.nameAr && <> <ContentText className="text-muted-foreground">{i.nameAr}</ContentText></>}{i.detail && <span className="text-xs text-muted-foreground"> · <ContentText>{i.detail}</ContentText></span>}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </fieldset>
        )}
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button type="button" disabled={!canSave || busy} onClick={() => void save()}>{t('ops.scope.save')}</Button>
      </div>
    </Dialog>
  );
}
