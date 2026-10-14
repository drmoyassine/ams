import { useTranslation } from '../i18n';
import { useTermMode, type TermMode } from '../lib/glossary-api';

/** Choose whose words engagement screens use for levels: the institution's, the standard's own, or both (DEC-016). Remembered per viewer. */
export function TermModeSelect() {
  const { t } = useTranslation();
  const [mode, setMode] = useTermMode();
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">{t('terms.label')}
      <select aria-label={t('terms.label')} className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" value={mode} onChange={(e) => { const m = e.target.value as TermMode; setMode(m); }}>
        <option value="both">{t('terms.both')}</option>
        <option value="internal">{t('terms.internal')}</option>
        <option value="standard">{t('terms.standard')}</option>
      </select>
    </label>
  );
}
