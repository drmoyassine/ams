import { useTranslation } from '../i18n';

/**
 * Quality Management: where the Internal Quality Framework is run day to day (its lifecycle), as Accreditations is for the
 * external accreditors. The page is a placeholder until the lifecycle is designed (TASK-077); the framework itself is still
 * edited in Settings -> Internal Quality Framework.
 */
export function QualityManagementPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold sm:text-2xl">{t('nav.quality')}</h1>
      <p className="max-w-prose text-sm text-muted-foreground">{t('quality.placeholder')}</p>
    </div>
  );
}
