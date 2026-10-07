import { useState, type FormEvent } from 'react';
import { parseCell, type CellValue, type DataColumn, type PublicForm, type SubmitResponse } from '@ams/shared';
import { ApiError } from '../lib/framework-api';
import { ContentText } from './content-text';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** One question: the input fits the column's type; help text and the problem (if any) sit under it. */
function Question({ c, value, error, disabled, onChange }: { c: DataColumn; value: string; error?: string; disabled: boolean; onChange: (v: string) => void }) {
  const id = `q-${c.key}`;
  const label = <>{c.label}{c.unit ? <span className="text-muted-foreground"> ({c.unit})</span> : null}{c.required && <span className="text-red-700"> *</span>}</>;
  const options = c.type === 'choice' ? c.choices ?? [] : c.type === 'yes_no' ? ['Yes', 'No'] : null;
  const described = [c.help ? `${id}-help` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-1 rounded-md border border-border p-4" data-testid="form-question">
      {options ? (
        <fieldset aria-describedby={described}>
          <legend className="font-medium" dir="auto">{label}</legend>
          {c.help && <p id={`${id}-help`} className="text-sm text-muted-foreground" dir="auto">{c.help}</p>}
          <div className="mt-2 space-y-1">
            {options.map((o) => (
              <label key={o} className="flex items-center gap-2 text-sm">
                <input type="radio" name={id} value={o} checked={value === o} disabled={disabled} onChange={() => onChange(o)} /> <span dir="auto">{o}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <>
          <label htmlFor={id} className="block font-medium" dir="auto">{label}</label>
          {c.help && <p id={`${id}-help`} className="text-sm text-muted-foreground" dir="auto">{c.help}</p>}
          <Input id={id} value={value} disabled={disabled} aria-invalid={error ? true : undefined} aria-describedby={described} dir="auto"
            type={c.type === 'date' ? 'date' : 'text'} inputMode={c.type === 'number' || c.type === 'integer' || c.type === 'percent' ? 'decimal' : undefined}
            className="max-w-md" onChange={(e) => onChange(e.target.value)} />
        </>
      )}
      {error && <p id={`${id}-error`} className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

/**
 * A data item's form, like Google Forms: its title and purpose, then one question per column. Answers are checked with
 * the sheet's rules before they are sent, and again by the server. `preview` shows it without taking answers.
 */
export function DataFormView({ form, onSubmit, preview = false, once = false }: {
  form: PublicForm & { message?: string | null }; onSubmit?: (r: SubmitResponse) => Promise<unknown>; preview?: boolean;
  /** One answer only (a request): no "Submit another response". */
  once?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (preview || !onSubmit) return;
    const answers: Record<string, CellValue> = {};
    const found: Record<string, string> = {};
    for (const c of form.columns) {
      const p = parseCell(c, values[c.key] ?? '');
      if (p.error) found[c.key] = p.error;
      answers[c.key] = values[c.key]?.trim() ? values[c.key]! : null;
    }
    setErrors(found); setError('');
    if (Object.keys(found).length) { setError('Some answers need attention.'); return; }
    setBusy(true);
    try { await onSubmit({ answers }); setSent(true); setValues({}); } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError) setErrors(Object.fromEntries(err.issues.flatMap((i) => (i.path.startsWith('answers.') ? [[i.path.slice(8), i.message]] : []))));
    } finally { setBusy(false); }
  };
  if (sent) {
    return (
      <div className="space-y-3 rounded-lg border border-border p-6">
        <p role="status">Thank you. Your response was received.</p>
        {!once && <Button type="button" variant="outline" onClick={() => setSent(false)}>Submit another response</Button>}
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label={form.title}>
      <div className="rounded-lg border-t-4 border-primary bg-background p-4 shadow-sm">
        {form.institutionName && <p className="text-sm text-muted-foreground"><ContentText>{form.institutionName}</ContentText></p>}
        <h1 className="text-2xl font-semibold"><ContentText>{form.title}</ContentText></h1>
        {form.message && <p className="mt-1 whitespace-pre-line rounded bg-muted p-2 text-sm"><ContentText>{form.message}</ContentText></p>}
        {form.definition && <p className="mt-1 whitespace-pre-line text-sm"><ContentText>{form.definition}</ContentText></p>}
        {form.columns.some((c) => c.required) && <p className="mt-2 text-xs text-red-700">* Required</p>}
      </div>
      {form.columns.map((c) => (
        <Question key={c.key} c={c} value={values[c.key] ?? ''} error={errors[c.key]} disabled={preview || busy}
          onChange={(v) => { setValues((s) => ({ ...s, [c.key]: v })); setErrors((s) => { const n = { ...s }; delete n[c.key]; return n; }); }} />
      ))}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!preview && <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Submit'}</Button>}
    </form>
  );
}
