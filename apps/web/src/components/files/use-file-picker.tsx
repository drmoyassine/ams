import { useRef, type ReactNode } from 'react';
import { UPLOAD_RULES, type UploadKind } from '../../lib/file-rules';

/**
 * A file chooser opened from a button or a menu item (no drop zone): `open()` shows the system's dialog, the files chosen go to
 * `onFiles`. Render `input` once, anywhere in the component. Same rules table as `FileDrop`.
 */
export function useFilePicker({ onFiles, kind = 'document', multiple = false, label }: {
  onFiles: (files: File[]) => void; kind?: UploadKind; multiple?: boolean; /** The input's name, for screen readers and tests. */ label: string;
}): { open: () => void; input: ReactNode } {
  const ref = useRef<HTMLInputElement>(null);
  const rule = UPLOAD_RULES[kind];
  const input = (
    <input ref={ref} type="file" multiple={multiple} {...(rule.accept ? { accept: rule.accept } : {})} aria-label={label} className="sr-only" tabIndex={-1}
      onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; if (files.length) onFiles(multiple ? files : files.slice(0, 1)); }} />
  );
  return { open: () => ref.current?.click(), input };
}
