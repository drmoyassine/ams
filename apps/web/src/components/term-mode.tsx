import { useTermMode, type TermMode } from '../lib/glossary-api';

/** Choose whose words engagement screens use for levels: the institution's, the standard's own, or both (DEC-016). Remembered per viewer. */
export function TermModeSelect() {
  const [mode, setMode] = useTermMode();
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">Terms
      <select aria-label="Terms" className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" value={mode} onChange={(e) => { const m = e.target.value as TermMode; setMode(m); }}>
        <option value="both">Ours and the standard's</option>
        <option value="internal">Ours</option>
        <option value="standard">The standard's own</option>
      </select>
    </label>
  );
}
