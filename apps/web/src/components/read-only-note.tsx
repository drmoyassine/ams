import { useTranslation } from '../i18n';

/** The one line shown on a Settings page (or section) the signed-in person can read but not change. */

export function ReadOnlyNote({ show, className = '' }: { show: boolean; className?: string }) {
  const { t } = useTranslation();
  if (!show) return null;
  return <p role="note" data-testid="read-only-note" className={`text-sm text-muted-foreground ${className}`}>{t('common.readOnly')}</p>;
}
