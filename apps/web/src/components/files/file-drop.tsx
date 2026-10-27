import { useRef, useState } from 'react';
import { UPLOAD_RULES, type UploadKind } from '../../lib/file-rules';
import { Button } from '../ui/button';

/**
 * The one place a person drops or chooses files (DRY). It only hands the files over (`onFiles`); what happens next belongs to the
 * caller: `UploadArea` stores each file at once with a state and a Retry, the create-from-files page keeps them until the standard
 * exists. What it accepts and says about it comes from `UPLOAD_RULES`.
 */
export function FileDrop({ onFiles, kind = 'document', multiple = true, label = 'Upload documents', inputLabel = 'Files to upload', buttonLabel, note, disabled }: {
  onFiles: (files: File[]) => void;
  kind?: UploadKind;
  multiple?: boolean;
  /** The name of the drop zone (for people using a screen reader, and tests). */
  label?: string;
  inputLabel?: string;
  buttonLabel?: string;
  /** Said after the kinds of file: limits the caller enforces. */
  note?: string;
  disabled?: boolean;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const rule = UPLOAD_RULES[kind];
  const hand = (list: FileList | File[] | null) => {
    const files = [...(list ?? [])];
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };
  return (
    <div role="group" aria-label={label}
      onDragOver={(e) => { if (disabled) return; e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) hand(e.dataTransfer.files); }}
      className={`flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed p-4 text-sm ${over ? 'border-primary bg-primary/5' : 'border-border'}`}>
      <span className="min-w-0 flex-1 text-muted-foreground">
        {multiple ? 'Drop files here, or choose them.' : 'Drop a file here, or choose it.'} {rule.hint}{multiple ? '; many at a time' : ''}.{note ? ` ${note}` : ''}
      </span>
      <input ref={input} type="file" multiple={multiple} {...(rule.accept ? { accept: rule.accept } : {})} aria-label={inputLabel} className="sr-only" tabIndex={-1} disabled={disabled}
        onChange={(e) => { hand(e.target.files); e.target.value = ''; }} />
      <Button type="button" variant="outline" disabled={disabled} onClick={() => input.current?.click()}>{buttonLabel ?? (multiple ? 'Choose files' : 'Choose file')}</Button>
    </div>
  );
}
