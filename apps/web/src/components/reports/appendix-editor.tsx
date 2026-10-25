// The appendix editor (TASK-092, PRD 10.3): files drawn from evidence versions — pick an evidence item's version, name
// it as it should read in the report, and it joins the list. The server checks each version belongs to this institution.
import { useState } from 'react';
import type { ReportSection } from '@ams/shared';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useTranslation } from '../../i18n';

export interface AppendixItem { evidenceVersionId: string; label: string }

const itemsOf = (content: unknown): AppendixItem[] => {
  const { items } = (content ?? {}) as { items?: AppendixItem[] };
  return items ?? [];
};

export function AppendixEditor({ section, canWrite, busy, error, onSave, picker }: {
  section: ReportSection; canWrite: boolean; busy: boolean; error?: string | null;
  onSave: (content: { items: AppendixItem[] }) => Promise<void>;
  /** Opens the picker over the institution's evidence; resolves to one version and its item's title. */
  picker: () => Promise<{ evidenceVersionId: string; title: string } | null>;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<AppendixItem[]>(() => itemsOf(section.content));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const writeable = canWrite && (section.status === 'draft' || section.status === 'returned');

  const add = async () => {
    const chosen = await picker();
    if (!chosen) return;
    setItems((xs) => [...xs, { evidenceVersionId: chosen.evidenceVersionId, label: chosen.title }]);
    setDirty(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      await onSave({ items: items.map((i) => ({ evidenceVersionId: i.evidenceVersionId, label: i.label.trim() || i.label })) });
      setDirty(false);
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-2" data-testid="appendix-editor">
      {items.length === 0
        ? <p className="text-sm text-muted-foreground" data-testid="no-appendix">{t('rep.noAppendix')}</p>
        : (
          <ol className="space-y-1" aria-label={t('rep.appendixList')}>
            {items.map((it, i) => (
              <li key={`${it.evidenceVersionId}:${i}`} className="flex flex-wrap items-center gap-2" data-testid="appendix-item">
                <span className="text-sm text-muted-foreground">{i + 1}.</span>
                <Input value={it.label} dir="auto" aria-label={`${t('rep.appendixLabel')} ${i + 1}`} disabled={!writeable || busy}
                  className="max-w-96" onChange={(e) => { const v = e.target.value; setItems((xs) => xs.map((x, j) => (j === i ? { ...x, label: v } : x))); setDirty(true); }} />
                {writeable && (
                  <Button type="button" variant="ghost" className="px-1 py-0 text-xs" aria-label={`${t('common.remove')} ${i + 1}`}
                    onClick={() => { setItems((xs) => xs.filter((_, j) => j !== i)); setDirty(true); }}>✕</Button>
                )}
              </li>
            ))}
          </ol>
        )}
      {writeable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => void add()} data-testid="add-appendix">{t('rep.addAppendix')}</Button>
          <Button type="button" disabled={!dirty || saving || busy} onClick={() => void save()} data-testid="save-appendix">{saving ? t('common.saving') : t('common.save')}</Button>
          {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
        </div>
      )}
    </div>
  );
}
