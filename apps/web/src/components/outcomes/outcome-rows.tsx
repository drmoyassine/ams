import type { LearningOutcome } from '@ams/shared';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { nextCode } from './outcome-list';

/** One outcome being typed into a form (a program's dialog): its code and statements. */
export interface OutcomeRow { code: string; textEn: string; textAr: string }

/**
 * A repeatable group of outcome rows ("Add another"), for typing several PEOs or PLOs at once. A new row starts with the next code
 * after the last one typed or already recorded. Rows with no statement are ignored when the form is saved.
 */
export function OutcomeRows({ label, title, codeHint, rows, existing, onChange }: {
  label: string; title: string; codeHint: string; rows: OutcomeRow[]; existing: LearningOutcome[]; onChange: (rows: OutcomeRow[]) => void;
}) {
  const last = rows.length ? rows[rows.length - 1]!.code : (existing[existing.length - 1]?.code ?? '');
  const set = (i: number, patch: Partial<OutcomeRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const field = 'flex min-w-0 flex-col gap-1 text-xs';
  return (
    <fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-3" aria-label={title}>
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {existing.length > 0 && (
        <p className="text-xs text-muted-foreground">Already recorded: {existing.map((o) => o.code).join(', ')}. Edit or delete them from the program's Outcomes page.</p>
      )}
      {rows.length === 0 && <p className="text-sm text-muted-foreground">None added here.</p>}
      {rows.map((r, i) => (
        <div key={i} className="grid min-w-0 gap-2 rounded-md border border-border/60 p-2 sm:grid-cols-6" data-testid={`${label}-row`}>
          <label className={`${field} sm:col-span-1`}>Code<Input aria-label={`${label} ${i + 1} code`} value={r.code} placeholder={codeHint} onChange={(e) => set(i, { code: e.target.value })} /></label>
          <label className={`${field} sm:col-span-5`}>Statement (English)<Input aria-label={`${label} ${i + 1} statement`} value={r.textEn} onChange={(e) => set(i, { textEn: e.target.value })} /></label>
          <label className={`${field} sm:col-span-5 sm:col-start-2`}>Statement (Arabic)<Input aria-label={`${label} ${i + 1} statement (Arabic)`} dir="auto" value={r.textAr} onChange={(e) => set(i, { textAr: e.target.value })} /></label>
          <div className="flex items-end sm:col-span-1">
            <Button type="button" variant="ghost" className="px-2 py-1" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" className="px-3 py-1" onClick={() => onChange([...rows, { code: nextCode(last) || '', textEn: '', textAr: '' }])}>
        {rows.length ? 'Add another' : `Add ${label}`}
      </Button>
    </fieldset>
  );
}
