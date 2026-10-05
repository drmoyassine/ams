import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import type { Issue } from '../lib/framework-api';
import { ApiError } from '../lib/framework-api';

/**
 * Edits one JSON document. Malformed JSON is reported before anything is sent; whatever the server's validation finds is
 * listed with its path, all at once.
 */
export function JsonEditor({ label, value, onSave, readOnly = false, rows = 16 }: {
  label: string;
  value: unknown;
  onSave: (parsed: unknown) => Promise<unknown>;
  readOnly?: boolean;
  rows?: number;
}) {
  const pretty = JSON.stringify(value ?? null, null, 2);
  const [text, setText] = useState(pretty);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setText(pretty); setIssues([]); setError(null); }, [pretty]);

  let parseError: string | null = null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) { parseError = (e as Error).message; }

  async function save() {
    setIssues([]); setError(null); setSaved(false);
    try { await onSave(parsed); setSaved(true); } catch (e) {
      if (e instanceof ApiError) { setError(e.message); setIssues(e.issues); } else throw e;
    }
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor={`json-${label}`}>{label}</label>
      <textarea
        id={`json-${label}`} dir="ltr" spellCheck={false} readOnly={readOnly} rows={rows} value={text}
        onChange={(e) => { setText(e.target.value); setSaved(false); }}
        className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
      />
      {parseError && <p role="alert" className="text-sm text-red-700">Not valid JSON: {parseError}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {issues.length > 0 && (
        <ul aria-label="Validation issues" className="list-disc space-y-1 ps-5 text-sm text-red-700">
          {issues.map((i, n) => <li key={n}><code>{i.path || '(root)'}</code>: {i.message}</li>)}
        </ul>
      )}
      {saved && <p role="status" className="text-sm text-emerald-700">Saved.</p>}
      {!readOnly && <Button type="button" onClick={save} disabled={parseError !== null || text === pretty}>Save {label}</Button>}
    </div>
  );
}
