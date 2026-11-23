// The concentrations a course of a study plan counts toward, as chips (DEC-047): several when "choose one" tracks share a course; none means
// every student of the program. A chip is removed with its ×; another is added from the list.
import type { Concentration } from '@ams/shared';

export function ConcentrationChips({ label, all, value, disabled, onChange }: { label: string; all: Concentration[]; value: string[]; disabled: boolean; onChange: (ids: string[]) => void }) {
  const chosen = value.map((id) => all.find((k) => k.id === id)).filter((k): k is Concentration => !!k);
  const left = all.filter((k) => k.active && !value.includes(k.id));
  return (
    <span role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      {chosen.length === 0 && <span className="text-xs text-muted-foreground">All</span>}
      {chosen.map((k) => (
        <span key={k.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs" data-testid="concentration-chip">
          {k.nameEn}
          {!disabled && <button type="button" aria-label={`Remove ${k.nameEn} from ${label}`} className="leading-none text-muted-foreground hover:text-foreground" onClick={() => onChange(value.filter((x) => x !== k.id))}>×</button>}
        </span>
      ))}
      {!disabled && left.length > 0 && (
        <select aria-label={`Add a concentration to ${label}`} className="h-7 max-w-40 rounded-md border border-border bg-background px-1 text-xs" value=""
          onChange={(e) => { const v = e.target.value; if (v) onChange([...value, v]); }}>
          <option value="">+ Concentration</option>
          {left.map((k) => <option key={k.id} value={k.id}>{k.nameEn}</option>)}
        </select>
      )}
    </span>
  );
}
