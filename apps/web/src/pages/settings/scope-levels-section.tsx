// Settings -> Organization -> Institution -> Scope levels (TASK-086): the short list of levels a standard's scope can be at
// (Assign scope in Quality Management). Institution, Unit, Program and Course to start with; add a custom level, rename (English and
// Arabic), move up or down, deactivate. A level is never deleted, so a scope that names it keeps its meaning. Course is a
// placeholder until course records exist: it can be chosen, and its list says "No courses yet". Same pattern as the unit types.
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScopeLevel } from '@ams/shared';
import { ReadOnlyNote } from '../../components/read-only-note';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useTranslation } from '../../i18n';
import type { SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';

const KEY = ['scope-levels'] as const;

function LevelRow({ level, index, count, editable, busy, onSave, onMove, onToggle }: {
  level: ScopeLevel; index: number; count: number; editable: boolean; busy: boolean;
  onSave: (labelEn: string, labelAr: string) => void; onMove: (dir: -1 | 1) => void; onToggle: () => void;
}) {
  const { t } = useTranslation();
  const [en, setEn] = useState(level.labelEn);
  const [ar, setAr] = useState(level.labelAr ?? '');
  const dirty = en.trim() !== level.labelEn || ar.trim() !== (level.labelAr ?? '');
  const what = level.kind === 'course' ? t('scopeLevels.noCourses') : level.kind === 'org_unit' ? t('scopeLevels.units', { count: level.itemCount }) : level.kind === 'program' ? t('scopeLevels.programs', { count: level.itemCount }) : level.kind === 'institution' ? t('scopeLevels.wholeInstitution') : t('scopeLevels.noList');
  return (
    <li className={`flex flex-wrap items-end gap-2 rounded-md border border-border p-2 ${level.active ? '' : 'opacity-70'}`} data-testid="scope-level-row">
      <label className="flex min-w-32 flex-1 flex-col text-xs">{t('scopeLevels.nameEn')}
        <Input aria-label={t('scopeLevels.nameOf', { name: level.labelEn, lang: 'English' })} value={en} onChange={(e) => setEn(e.target.value)} disabled={!editable} />
      </label>
      <label className="flex min-w-32 flex-1 flex-col text-xs">{t('scopeLevels.nameAr')}
        <Input aria-label={t('scopeLevels.nameOf', { name: level.labelEn, lang: 'Arabic' })} dir="auto" value={ar} onChange={(e) => setAr(e.target.value)} disabled={!editable} />
      </label>
      <span className="pb-2 text-xs text-muted-foreground" data-testid="scope-level-what">{what}{level.active ? '' : ` · ${t('scopeLevels.inactive')}`}</span>
      {editable && (
        <span className="flex items-center gap-1">
          <Button type="button" variant="outline" className="px-2 py-1" disabled={!dirty || !en.trim() || busy} onClick={() => onSave(en.trim(), ar.trim())} aria-label={t('scopeLevels.save', { name: level.labelEn })}>{t('common.save')}</Button>
          <Button type="button" variant="ghost" className="px-2 py-1" disabled={index === 0 || busy} onClick={() => onMove(-1)} aria-label={t('scopeLevels.up', { name: level.labelEn })}>↑</Button>
          <Button type="button" variant="ghost" className="px-2 py-1" disabled={index === count - 1 || busy} onClick={() => onMove(1)} aria-label={t('scopeLevels.down', { name: level.labelEn })}>↓</Button>
          <Button type="button" variant="ghost" className="px-2 py-1" disabled={busy} onClick={onToggle} aria-label={t(level.active ? 'scopeLevels.deactivate' : 'scopeLevels.reactivate', { name: level.labelEn })}>{level.active ? t('scopeLevels.deactivateShort') : t('scopeLevels.reactivateShort')}</Button>
        </span>
      )}
    </li>
  );
}

export function ScopeLevelsSection({ api, canEdit }: { api: SettingsApi; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: [...KEY], queryFn: () => api.scopeLevels() });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [en, setEn] = useState('');
  const [ar, setAr] = useState('');
  const act = useAction(setError);
  const levels = data ?? [];
  const run = async (fn: () => Promise<unknown>) => {
    setError(''); setBusy(true);
    try { const r = await act(fn); await qc.invalidateQueries({ queryKey: [...KEY] }); return r; } finally { setBusy(false); }
  };
  const move = (i: number, dir: -1 | 1) => {
    const ids = levels.map((l) => l.id);
    const [x] = ids.splice(i, 1);
    ids.splice(i + dir, 0, x!);
    void run(() => api.reorderScopeLevels(ids));
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!en.trim()) return;
    void run(() => api.createScopeLevel({ labelEn: en.trim(), ...(ar.trim() ? { labelAr: ar.trim() } : {}) })).then((r) => { if (r) { setEn(''); setAr(''); } });
  };
  return (
    <Card>
      <h3 className="mb-1 text-lg font-semibold">{t('scopeLevels.title')}</h3>
      <p className="mb-3 text-sm text-muted-foreground">{t('scopeLevels.intro')}</p>
      <ReadOnlyNote show={!canEdit} className="mb-3" />
      {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      <ul className="space-y-2" aria-label={t('scopeLevels.title')}>
        {levels.map((l, i) => (
          <LevelRow key={`${l.id}:${l.labelEn}:${l.labelAr ?? ''}:${l.active}`} level={l} index={i} count={levels.length} editable={canEdit} busy={busy}
            onSave={(labelEn, labelAr) => void run(() => api.updateScopeLevel(l.id, { labelEn, labelAr: labelAr || null }))}
            onMove={(d) => move(i, d)} onToggle={() => void run(() => api.updateScopeLevel(l.id, { active: !l.active }))} />
        ))}
        {data && levels.length === 0 && <li className="text-sm text-muted-foreground">{t('common.loading')}</li>}
      </ul>
      {canEdit && (
        <form onSubmit={add} className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3" aria-label={t('scopeLevels.add')}>
          <label className="flex min-w-32 flex-1 flex-col text-xs">{t('scopeLevels.newEn')}<Input aria-label={t('scopeLevels.newEn')} value={en} onChange={(e) => setEn(e.target.value)} /></label>
          <label className="flex min-w-32 flex-1 flex-col text-xs">{t('scopeLevels.newAr')}<Input aria-label={t('scopeLevels.newAr')} dir="auto" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
          <Button type="submit" disabled={!en.trim() || busy}>{t('scopeLevels.add')}</Button>
        </form>
      )}
    </Card>
  );
}
