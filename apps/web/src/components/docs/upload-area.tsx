import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../lib/framework-api';
import { FILE_ACCEPT } from '../../lib/source-files';
import { Button } from '../ui/button';

interface Item { key: number; file: File; state: 'waiting' | 'uploading' | 'done' | 'failed'; message: string }
const CONCURRENCY = 2;
let counter = 0;

/**
 * Drag and drop (or choose) many files. Each file uploads on its own, two at a time, with its own state and, when it fails, the
 * server's reason and a Retry; the others carry on. `onUpload` stores one file and rejects with the reason it was refused.
 */
export function UploadArea({ onUpload, onSettled, label = 'Upload documents' }: {
  onUpload: (file: File) => Promise<unknown>; /** Called when the queue is empty (refresh the list). */ onSettled?: () => void; label?: string;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const live = useRef<Item[]>([]);
  const running = useRef(0);
  const set = useCallback((next: Item[]) => { live.current = next; setItems(next); }, []);
  const patch = useCallback((key: number, p: Partial<Item>) => set(live.current.map((i) => (i.key === key ? { ...i, ...p } : i))), [set]);

  const pump = useCallback(() => {
    while (running.current < CONCURRENCY) {
      const next = live.current.find((i) => i.state === 'waiting');
      if (!next) break;
      running.current += 1;
      patch(next.key, { state: 'uploading', message: '' });
      void onUpload(next.file).then(
        () => patch(next.key, { state: 'done', message: '' }),
        (e: unknown) => patch(next.key, { state: 'failed', message: e instanceof ApiError ? e.message : (e as Error).message || 'the upload failed' }),
      ).finally(() => {
        running.current -= 1;
        if (live.current.some((i) => i.state === 'waiting')) pump();
        else if (running.current === 0) onSettled?.();
      });
    }
  }, [onUpload, onSettled, patch]);

  const add = (files: FileList | File[] | null) => {
    const list = [...(files ?? [])];
    if (!list.length) return;
    set([...live.current.filter((i) => i.state !== 'done'), ...list.map((file) => ({ key: ++counter, file, state: 'waiting' as const, message: '' }))]);
    pump();
  };
  const retry = (key: number) => { patch(key, { state: 'waiting', message: '' }); pump(); };
  const busy = items.some((i) => i.state === 'waiting' || i.state === 'uploading');

  return (
    <div className="space-y-2">
      <div role="group" aria-label={label}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
        className={`flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed p-4 text-sm ${over ? 'border-primary bg-primary/5' : 'border-border'}`}>
        <span className="min-w-0 flex-1 text-muted-foreground">Drop files here, or choose them. PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV or images; many at a time.</span>
        <input ref={input} type="file" multiple accept={FILE_ACCEPT} aria-label="Files to upload" className="sr-only" tabIndex={-1}
          onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        <Button type="button" variant="outline" onClick={() => input.current?.click()}>Choose files</Button>
      </div>
      {items.length > 0 && (
        <ul aria-label="Uploads" aria-live="polite" className="space-y-1 text-sm">
          {items.map((i) => (
            <li key={i.key} data-testid="upload-item" data-state={i.state} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span dir="auto" className="min-w-0 break-all font-medium">{i.file.name}</span>
              {i.state === 'waiting' && <span className="text-xs text-muted-foreground">Waiting</span>}
              {i.state === 'uploading' && <progress aria-label={`Uploading ${i.file.name}`} className="h-2 w-24" />}
              {i.state === 'done' && <span className="text-xs text-emerald-800">Stored</span>}
              {i.state === 'failed' && (
                <>
                  <span role="alert" className="min-w-0 text-xs text-red-700">{i.message}</span>
                  <Button type="button" variant="outline" className="px-2 py-1 text-xs" aria-label={`Retry ${i.file.name}`} onClick={() => retry(i.key)}>Retry</Button>
                  <Button type="button" variant="ghost" className="px-2 py-1 text-xs" aria-label={`Remove ${i.file.name} from the list`} onClick={() => set(live.current.filter((x) => x.key !== i.key))}>Dismiss</Button>
                </>
              )}
            </li>
          ))}
          {!busy && items.some((i) => i.state === 'done') && (
            <li><button type="button" className="text-xs underline" onClick={() => set(live.current.filter((i) => i.state !== 'done'))}>Clear the stored ones from this list</button></li>
          )}
        </ul>
      )}
    </div>
  );
}
