import { useId, type ReactNode } from 'react';
import type { AiTestResult } from '@ams/shared';

export const field = 'flex flex-col gap-1 text-sm';
export const hint = 'text-xs text-muted-foreground';
export const selectClass = 'h-10 w-full rounded-md border border-border bg-background px-3 text-sm disabled:opacity-60';

export function Switch({ label, checked, onChange, disabled, description }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; description?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" role="switch" aria-checked={checked} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-5 w-5 shrink-0" />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium">{label}</span>
        {description && <span className={`block ${hint}`}>{description}</span>}
      </label>
    </div>
  );
}

/** A native select with a visible label: keyboard and touch handling come from the browser. */
export function Select({ label, value, onChange, disabled, children, note }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; children: ReactNode; note?: ReactNode }) {
  return (
    <label className={field}>{label}
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={selectClass}>{children}</select>
      {note && <span className={hint}>{note}</span>}
    </label>
  );
}

/** The outcome of a Test: one line, success or the reason. */
export function TestLine({ result, what }: { result: AiTestResult | null; what: string }) {
  if (!result) return null;
  const text = result.ok
    ? `${what}: working${result.model ? ` (${result.model})` : ''}${result.dimension ? `, ${result.dimension} values per text` : ''}, ${result.ms} ms.`
    : `${what}: failed. ${result.error ?? ''}`;
  return <p className={`text-sm ${result.ok ? 'text-emerald-800' : 'text-red-700'}`} role={result.ok ? 'status' : 'alert'} data-testid={`test-${what}`}>{text}</p>;
}

export const providerLabelShort = (label: string) => label.replace(/\s*\(.*\)$/, '');
