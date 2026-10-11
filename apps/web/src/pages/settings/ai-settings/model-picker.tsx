import { useId, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiModelInfo } from '@ams/shared';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import type { SettingsApi } from '../../../lib/settings-api';
import { field, hint } from './common';

const MAX_SHOWN = 80;

/**
 * A searchable model picker. The list comes from the account's provider (fetched on the server, cached 10 minutes; Refresh
 * skips the cache). Whatever is typed is the model id, so when the list is loading, empty or failed the person can still type
 * one by hand. Arrow keys move through the list, Enter picks, Escape closes.
 */
export function ModelPicker({ api, label, accountId, kind, value, onChange, disabled, emptyHint }: {
  api: SettingsApi; label: string; accountId: string | null; kind: 'chat' | 'embedding'; value: string; onChange: (id: string) => void; disabled?: boolean; emptyHint?: string;
}) {
  const listId = useId();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const [active, setActive] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const { data, isFetching } = useQuery({
    queryKey: ['ai-models', accountId, kind],
    queryFn: () => api.aiModels(accountId!, kind),
    enabled: !!accountId,
    staleTime: 5 * 60 * 1000,
  });
  const models: AiModelInfo[] = data?.models ?? [];
  const shown = useMemo(() => {
    const q = touched ? value.trim().toLowerCase() : '';
    const hits = q ? models.filter((m) => m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q)) : models;
    return hits.slice(0, MAX_SHOWN);
  }, [models, value, touched]);

  const pick = (m: AiModelInfo) => { onChange(m.id); setOpen(false); setTouched(false); };
  const refresh = async () => {
    if (!accountId) return;
    setRefreshing(true);
    try { qc.setQueryData(['ai-models', accountId, kind], await api.aiModels(accountId, kind, true)); } finally { setRefreshing(false); }
  };

  return (
    <div className={field}>
      <label className={field}>{label}
        <div className="relative">
          <Input role="combobox" aria-label={label} aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
            value={value} disabled={disabled || !accountId} autoComplete="off" spellCheck={false}
            placeholder={accountId ? 'Search, or type a model id' : 'Choose an account first'}
            onChange={(e) => { onChange(e.target.value); setTouched(true); setOpen(true); setActive(0); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, Math.max(shown.length - 1, 0))); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === 'Enter' && open && shown[active]) { e.preventDefault(); pick(shown[active]!); }
              else if (e.key === 'Escape') setOpen(false);
            }} />
          {open && accountId && (
            <ul id={listId} role="listbox" aria-label={`${label} suggestions`} className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-background shadow-md">
              {shown.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground" role="presentation">{isFetching ? 'Loading models…' : models.length ? 'No match. The text you typed will be used as the model id.' : 'No models listed. Type a model id.'}</li>}
              {shown.map((m, i) => (
                <li key={m.id} id={`${listId}-${i}`} role="option" aria-selected={m.id === value}
                  className={`cursor-pointer break-all px-3 py-2 text-sm ${i === active ? 'bg-muted' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); pick(m); }} onMouseEnter={() => setActive(i)}>
                  {m.id}
                  {m.name && m.name !== m.id && <span className="block text-xs text-muted-foreground">{m.name}</span>}
                  {kind === 'chat' && m.supportsImages && <span className="block text-xs text-muted-foreground">reads images</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {accountId && <Button type="button" variant="outline" className="h-8 px-3 text-xs" onClick={refresh} disabled={isFetching || refreshing} aria-label={`Refresh ${label} list`}>{isFetching || refreshing ? 'Loading…' : 'Refresh list'}</Button>}
        <span className={hint} role="status">
          {!accountId ? (emptyHint ?? '') : isFetching ? 'Loading models…' : data?.error ? `Could not load the model list: ${data.error}. Type a model id instead.` : data ? `${models.length} models${data.cached ? ' (saved a moment ago)' : ''}.` : ''}
        </span>
      </div>
    </div>
  );
}
