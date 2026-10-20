// Settings -> Organization -> Institution -> Academic calendar (TASK-081): the institution's years ("AY2026-27") and terms ("Fall 2026")
// that cycle plans recur against ("every term", "every year"). Add, edit (English and Arabic names, dates), switch off, move up or down,
// delete. Active years never overlap each other, nor terms: the server says which one a date clashes with. Same pattern as Scope levels.
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ACADEMIC_TERM_KINDS, type AcademicTerm, type AcademicTermKind } from '@ams/shared';
import { useConfirm } from '../../components/confirm-dialog';
import { ReadOnlyNote } from '../../components/read-only-note';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useTranslation } from '../../i18n';
import type { SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';

const KEY = ['academic-terms'] as const;

function TermRow({ term, index, count, editable, busy, onSave, onMove, onToggle, onDelete }: {
  term: AcademicTerm; index: number; count: number; editable: boolean; busy: boolean;
  onSave: (patch: { name: string; nameAr: string | null; startDate: string; endDate: string }) => void; onMove: (dir: -1 | 1) => void; onToggle: () => void; onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(term.name);
  const [ar, setAr] = useState(term.nameAr ?? '');
  const [start, setStart] = useState(term.startDate);
  const [end, setEnd] = useState(term.endDate);
  const dirty = name.trim() !== term.name || ar.trim() !== (term.nameAr ?? '') || start !== term.startDate || end !== term.endDate;
  const valid = !!name.trim() && !!start && !!end && end >= start;
  return (
    <li className={`space-y-2 rounded-md border border-border p-2 ${term.active ? '' : 'opacity-70'}`} data-testid="calendar-row" data-kind={term.kind}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-32 flex-1 flex-col text-xs">{t('calendar.nameEn')}
          <Input aria-label={t('calendar.nameOf', { name: term.name, lang: 'English' })} value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} />
        </label>
        <label className="flex min-w-32 flex-1 flex-col text-xs">{t('calendar.nameAr')}
          <Input aria-label={t('calendar.nameOf', { name: term.name, lang: 'Arabic' })} dir="auto" value={ar} onChange={(e) => setAr(e.target.value)} disabled={!editable} />
        </label>
        <label className="flex min-w-32 flex-col text-xs">{t('calendar.start')}
          <Input type="date" aria-label={t('calendar.startOf', { name: term.name })} value={start} onChange={(e) => setStart(e.target.value)} disabled={!editable} />
        </label>
        <label className="flex min-w-32 flex-col text-xs">{t('calendar.end')}
          <Input type="date" aria-label={t('calendar.endOf', { name: term.name })} value={end} onChange={(e) => setEnd(e.target.value)} disabled={!editable} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {!term.active && <span className="me-2 text-xs text-muted-foreground">{t('calendar.inactive')}</span>}
        {editable && (
          <>
            <Button type="button" variant="outline" className="px-2 py-1" disabled={!dirty || !valid || busy} aria-label={t('calendar.save', { name: term.name })}
              onClick={() => onSave({ name: name.trim(), nameAr: ar.trim() || null, startDate: start, endDate: end })}>{t('common.save')}</Button>
            <Button type="button" variant="ghost" className="px-2 py-1" disabled={index === 0 || busy} onClick={() => onMove(-1)} aria-label={t('calendar.up', { name: term.name })}>↑</Button>
            <Button type="button" variant="ghost" className="px-2 py-1" disabled={index === count - 1 || busy} onClick={() => onMove(1)} aria-label={t('calendar.down', { name: term.name })}>↓</Button>
            <Button type="button" variant="ghost" className="px-2 py-1" disabled={busy} onClick={onToggle} aria-label={t(term.active ? 'calendar.deactivate' : 'calendar.reactivate', { name: term.name })}>{t(term.active ? 'calendar.deactivateShort' : 'calendar.reactivateShort')}</Button>
            <Button type="button" variant="ghost" className="px-2 py-1 text-red-700" disabled={busy} onClick={onDelete} aria-label={t('calendar.delete', { name: term.name })}>{t('common.delete')}</Button>
          </>
        )}
      </div>
    </li>
  );
}

export function AcademicCalendarSection({ api, canEdit }: { api: SettingsApi; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isError } = useQuery({ queryKey: [...KEY], queryFn: () => api.academicTerms() });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<AcademicTermKind>('term');
  const [name, setName] = useState('');
  const [ar, setAr] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const act = useAction(setError);
  const all = data ?? [];
  const run = async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setError(''); setBusy(true);
    try { const r = await act(fn); await qc.invalidateQueries({ queryKey: [...KEY] }); return r; } finally { setBusy(false); }
  };
  // Moving swaps a row with its neighbour of the same kind; the whole list is sent in its new order.
  const move = (id: string, dir: -1 | 1) => {
    const ids = all.map((x) => x.id);
    const me = all.find((x) => x.id === id)!;
    const group = all.filter((x) => x.kind === me.kind);
    const other = group[group.indexOf(me) + dir];
    if (!other) return;
    const a = ids.indexOf(id); const b = ids.indexOf(other.id);
    ids[a] = other.id; ids[b] = id;
    void run(() => api.reorderAcademicTerms(ids));
  };
  const remove = async (x: AcademicTerm) => {
    if (!(await confirm({ title: t('calendar.deleteTitle', { name: x.name }), message: t('calendar.deleteMessage'), confirmLabel: t('common.delete'), tone: 'danger' }))) return;
    await run(() => api.deleteAcademicTerm(x.id));
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !start || !end) return;
    void run(() => api.createAcademicTerm({ name: name.trim(), kind, startDate: start, endDate: end, ...(ar.trim() ? { nameAr: ar.trim() } : {}) })).then((r) => { if (r) { setName(''); setAr(''); setStart(''); setEnd(''); } });
  };
  const kindLabel = (k: AcademicTermKind) => (k === 'year' ? t('calendar.kind.year') : t('calendar.kind.term'));
  return (
    <Card>
      <h3 className="mb-1 text-lg font-semibold">{t('calendar.title')}</h3>
      <p className="mb-3 max-w-prose text-sm text-muted-foreground">{t('calendar.intro')}</p>
      <ReadOnlyNote show={!canEdit} className="mb-3" />
      {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      {isError && <p role="alert" className="mb-2 text-sm text-red-700">{t('calendar.loadFailed')}</p>}
      {data && all.length === 0 && <p className="mb-3 rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground" data-testid="calendar-empty">{t('calendar.empty')}</p>}
      {ACADEMIC_TERM_KINDS.map((k) => {
        const group = all.filter((x) => x.kind === k);
        if (group.length === 0) return null;
        return (
          <section key={k} className="mb-3" aria-label={kindLabel(k)}>
            <h4 className="mb-1 text-sm font-medium">{k === 'year' ? t('calendar.years') : t('calendar.terms')}</h4>
            <ul className="space-y-2" aria-label={k === 'year' ? t('calendar.years') : t('calendar.terms')}>
              {group.map((x, i) => (
                <TermRow key={`${x.id}:${x.name}:${x.nameAr ?? ''}:${x.startDate}:${x.endDate}:${x.active}`} term={x} index={i} count={group.length} editable={canEdit} busy={busy}
                  onSave={(patch) => void run(() => api.updateAcademicTerm(x.id, patch))} onMove={(d) => move(x.id, d)}
                  onToggle={() => void run(() => api.updateAcademicTerm(x.id, { active: !x.active }))} onDelete={() => void remove(x)} />
              ))}
            </ul>
          </section>
        );
      })}
      {canEdit && (
        <form onSubmit={add} className="mt-4 space-y-2 border-t border-border pt-3" aria-label={t('calendar.add')}>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-28 flex-col text-xs">{t('calendar.newKind')}
              <select aria-label={t('calendar.newKind')} className="rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground" value={kind} onChange={(e) => setKind(e.target.value as AcademicTermKind)}>
                {ACADEMIC_TERM_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
              </select>
            </label>
            <label className="flex min-w-32 flex-1 flex-col text-xs">{t('calendar.newEn')}<Input aria-label={t('calendar.newEn')} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'year' ? t('calendar.exampleYear') : t('calendar.exampleTerm')} /></label>
            <label className="flex min-w-32 flex-1 flex-col text-xs">{t('calendar.newAr')}<Input aria-label={t('calendar.newAr')} dir="auto" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-32 flex-col text-xs">{t('calendar.start')}<Input type="date" aria-label={t('calendar.newStart')} value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label className="flex min-w-32 flex-col text-xs">{t('calendar.end')}<Input type="date" aria-label={t('calendar.newEnd')} value={end} onChange={(e) => setEnd(e.target.value)} /></label>
            <Button type="submit" disabled={!name.trim() || !start || !end || end < start || busy}>{t('calendar.add')}</Button>
          </div>
        </form>
      )}
    </Card>
  );
}
