import { useState, type ReactNode } from 'react';
import { BLOOM_LEVELS, OUTCOME_STATUSES, type LearningOutcome, type UpdateOutcome } from '@ams/shared';
import { ContentText } from '../content-text';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const STATUS = { draft: 'Draft', approved: 'Approved', retired: 'Retired' } as const;
const BLOOM = { remember: 'Remember', understand: 'Understand', apply: 'Apply', analyze: 'Analyze', evaluate: 'Evaluate', create: 'Create' } as const;

export interface OutcomeDraft { code: string; textEn: string; textAr: string; bloomLevel: string; status: string; approvedOn: string }
const draftOf = (o?: LearningOutcome): OutcomeDraft => ({
  code: o?.code ?? '', textEn: o?.textEn ?? '', textAr: o?.textAr ?? '', bloomLevel: o?.bloomLevel ?? '', status: o?.status ?? 'draft', approvedOn: o?.approvedOn ?? '',
});
/** The draft as an update (empty fields clear). */
export const patchOf = (d: OutcomeDraft): UpdateOutcome => ({
  code: d.code, textEn: d.textEn, textAr: d.textAr || null, bloomLevel: (d.bloomLevel || null) as UpdateOutcome['bloomLevel'],
  status: d.status as UpdateOutcome['status'], approvedOn: d.approvedOn || null,
});

/** The code after this one ("PLO3" gives "PLO4"); empty when the code ends in no number. */
export const nextCode = (code: string) => { const m = /^(.*?)(\d+)$/.exec(code.trim()); return m ? `${m[1]}${Number(m[2]) + 1}` : ''; };

function OutcomeForm({ initial, label, codeHint, withBloom, submitLabel, cancelLabel = 'Cancel', defaults, focusStatement = false, onSubmit, onCancel }: {
  initial?: LearningOutcome; label: string; codeHint: string; withBloom: boolean; submitLabel: string; cancelLabel?: string; defaults?: Partial<OutcomeDraft>; focusStatement?: boolean;
  onSubmit: (d: OutcomeDraft) => void; onCancel: () => void;
}) {
  const [d, setD] = useState({ ...draftOf(initial), ...defaults });
  const set = (k: keyof OutcomeDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const field = 'flex flex-col gap-1 text-xs';
  return (
    <form className="grid gap-2 sm:grid-cols-6" aria-label={`${submitLabel} ${label}`} onSubmit={(e) => { e.preventDefault(); if (d.code.trim() && d.textEn.trim()) onSubmit(d); }}>
      <label className={`${field} sm:col-span-1`}>Code<Input aria-label={`${label} code`} value={d.code} placeholder={codeHint} onChange={set('code')} required /></label>
      <label className={`${field} sm:col-span-5`}>Statement (English)<Input aria-label={`${label} statement`} value={d.textEn} onChange={set('textEn')} required autoFocus={focusStatement} /></label>
      <label className={`${field} sm:col-span-6`}>Statement (Arabic)<Input aria-label={`${label} statement (Arabic)`} dir="auto" value={d.textAr} onChange={set('textAr')} /></label>
      {withBloom && (
        <label className={`${field} sm:col-span-2`}>Bloom level
          <select aria-label={`${label} Bloom level`} className={select} value={d.bloomLevel} onChange={set('bloomLevel')}>
            <option value="">Not set</option>
            {BLOOM_LEVELS.map((b) => <option key={b} value={b}>{BLOOM[b]}</option>)}
          </select>
        </label>
      )}
      <label className={`${field} sm:col-span-2`}>Status
        <select aria-label={`${label} status`} className={select} value={d.status} onChange={set('status')}>
          {OUTCOME_STATUSES.map((s) => <option key={s} value={s}>{STATUS[s]}</option>)}
        </select>
      </label>
      <label className={`${field} sm:col-span-2`}>Approved on<Input type="date" aria-label={`${label} approved on`} value={d.approvedOn} onChange={set('approvedOn')} /></label>
      <div className="flex flex-wrap gap-2 sm:col-span-6">
        <Button type="submit" disabled={!d.code.trim() || !d.textEn.trim()}>{submitLabel}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
      </div>
    </form>
  );
}

/**
 * One list of outcomes of one kind (ILOs, PEOs, PLOs, indicators, CLOs): code, statement in both languages, Bloom level, status;
 * add, edit, delete (a draft) or retire. `extra` draws what a place adds under a row (link chips, indicators).
 */
export function OutcomeList({ title, label, items, canWrite, codeHint, withBloom = false, canAdd = true, onAdd, onSave, onDelete, extra, empty }: {
  title?: string; label: string; items: LearningOutcome[]; canWrite: boolean; codeHint: string; withBloom?: boolean; /** False where outcomes are added somewhere else (the program's dialog). */ canAdd?: boolean;
  onAdd: (d: OutcomeDraft) => void; onSave: (id: string, d: OutcomeDraft) => void; onDelete: (o: LearningOutcome) => void;
  extra?: (o: LearningOutcome) => ReactNode; empty?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // "Add more": the form stays open after each one, with the next code ready, until Done. `round` makes a fresh form each time.
  const [added, setAdded] = useState(0);
  const [round, setRound] = useState(0);
  const [next, setNext] = useState('');
  const closeAdd = () => { setAdding(false); setAdded(0); setNext(''); };
  const addForm = (
    <div className="space-y-2">
      {added > 0 && <p role="status" className="text-sm text-emerald-800">{added} {label}{added === 1 ? '' : 's'} added. Add the next one, or press Done.</p>}
      <OutcomeForm key={round} label={label} codeHint={codeHint} withBloom={withBloom} submitLabel={`Add ${label}`} cancelLabel={added > 0 ? 'Done' : 'Cancel'} defaults={{ code: next }} focusStatement={added > 0}
        onCancel={closeAdd} onSubmit={(d) => { onAdd(d); setAdded(added + 1); setNext(nextCode(d.code)); setRound(round + 1); }} />
    </div>
  );
  return (
    <section aria-label={title ?? label} className="space-y-2">
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-semibold">{title}</h4>
          {canWrite && canAdd && !adding && <Button type="button" variant="outline" className="px-3 py-1" onClick={() => setAdding(true)}>Add {label}</Button>}
        </div>
      )}
      {items.length === 0 && !adding && <p className="text-sm text-muted-foreground">{empty ?? `No ${label}s yet.`}</p>}
      <ul className="divide-y divide-border rounded-lg border border-border empty:hidden" aria-label={`${label}s`}>
        {items.map((o) => (
          <li key={o.id} className={`px-3 py-2 ${o.status === 'retired' ? 'opacity-60' : ''}`} data-testid="outcome">
            {editing === o.id && canWrite ? (
              <OutcomeForm initial={o} label={label} codeHint={codeHint} withBloom={withBloom} submitLabel="Save" onCancel={() => setEditing(null)}
                onSubmit={(d) => { onSave(o.id, d); setEditing(null); }} />
            ) : (
              <div className="flex flex-wrap items-start gap-2">
                <span className="min-w-14 font-mono text-sm font-semibold">{o.code}</span>
                <div className="min-w-0 flex-1">
                  <ContentText className="text-sm">{o.textEn}</ContentText>
                  {o.textAr && <ContentText className="block text-sm text-muted-foreground">{o.textAr}</ContentText>}
                  <p className="text-xs text-muted-foreground">{STATUS[o.status]}{o.approvedOn ? ` ${o.approvedOn}` : ''}{o.bloomLevel ? ` · ${BLOOM[o.bloomLevel]}` : ''}{o.source ? ` · from ${o.source}` : ''}</p>
                  {extra?.(o)}
                </div>
                {canWrite && (
                  <div className="flex gap-1">
                    <Button type="button" variant="ghost" className="px-2 py-1" aria-label={`Edit ${o.code}`} onClick={() => setEditing(o.id)}>Edit</Button>
                    {o.status === 'draft' && <Button type="button" variant="ghost" className="px-2 py-1" aria-label={`Delete ${o.code}`} onClick={() => onDelete(o)}>Delete</Button>}
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {canAdd && (adding || (!title && canWrite)) && canWrite && (adding
        ? addForm
        : <Button type="button" variant="outline" className="px-3 py-1" onClick={() => setAdding(true)}>Add {label}</Button>)}
    </section>
  );
}

/** A toggle chip: linked or not (PLO -> ILO, PLO -> PEO). */
export function LinkChip({ label, title, on, disabled, onToggle }: { label: string; title: string; on: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-pressed={on} title={title} aria-label={`${on ? 'Unlink' : 'Link'} ${label}`} disabled={disabled} onClick={onToggle}
      className={`rounded border px-2 py-0.5 text-xs ${on ? 'border-primary bg-primary/10 font-medium' : 'border-border text-muted-foreground'} ${disabled ? 'cursor-default' : ''}`}>{label}</button>
  );
}
