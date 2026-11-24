import { Button } from '../ui/button';
import { Input } from '../ui/input';

export type RubricCriterion = { name: string; descriptions: string[] };

/**
 * A rubric as a table: one row per criterion, one column per level of the institution's achievement scale (the levels are not edited
 * here: they come from Settings). Used by the rubric templates in Settings and by a course's rubrics.
 */
export function RubricGrid({ levels, criteria, onChange, readOnly = false, label }: {
  levels: string[]; criteria: RubricCriterion[]; onChange: (c: RubricCriterion[]) => void; readOnly?: boolean; label: string;
}) {
  const setAt = (i: number, c: RubricCriterion) => onChange(criteria.map((x, k) => (k === i ? c : x)));
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] table-fixed border-collapse text-sm" aria-label={label}>
          <thead>
            <tr className="text-start text-xs text-muted-foreground">
              <th className="w-44 border-b border-border px-2 py-1 text-start font-medium">Criterion</th>
              {levels.map((l) => <th key={l} className="border-b border-border px-2 py-1 text-start font-medium">{l}</th>)}
              {!readOnly && <th className="w-10 border-b border-border" />}
            </tr>
          </thead>
          <tbody>
            {criteria.map((k, i) => (
              <tr key={i} className="align-top">
                <td className="border-b border-border px-1 py-1">
                  <Input aria-label={`Criterion ${i + 1}`} value={k.name} disabled={readOnly} onChange={(e) => setAt(i, { ...k, name: e.target.value })} />
                </td>
                {levels.map((l, j) => (
                  <td key={l} className="border-b border-border px-1 py-1">
                    <textarea aria-label={`Criterion ${i + 1} at ${l}`} rows={2} disabled={readOnly} dir="auto" className="w-full rounded-md border border-border bg-background p-1.5 text-xs"
                      value={k.descriptions[j] ?? ''} onChange={(e) => setAt(i, { ...k, descriptions: levels.map((_, m) => (m === j ? e.target.value : k.descriptions[m] ?? '')) })} />
                  </td>
                ))}
                {!readOnly && (
                  <td className="border-b border-border px-1 py-1 text-center">
                    <button type="button" aria-label={`Remove criterion ${i + 1}`} className="rounded px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => onChange(criteria.filter((_, m) => m !== i))}>✕</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && <Button type="button" variant="outline" onClick={() => onChange([...criteria, { name: '', descriptions: levels.map(() => '') }])}>+ Criterion</Button>}
    </div>
  );
}
