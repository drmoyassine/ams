import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ContentText } from '../components/content-text';
import { api as defaultApi } from '../lib/api';

export function ProgramsPage({ api = defaultApi }: { api?: typeof defaultApi }) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useQuery({
    queryKey: ['programs'],
    queryFn: async () => {
      const res = await api.api.programs.$get();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">{t('programs.title')}</h1>
      {isError && <p role="alert">{t('programs.loadFailed')}</p>}
      {data && data.length === 0 && <p className="text-muted-foreground">{t('programs.empty')}</p>}
      {!isPending && data && data.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-4 py-3">
              <ContentText data-testid="program-name">{p.nameAr ?? p.nameEn}</ContentText>
              <span className="text-sm text-muted-foreground">{p.degreeLevel}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
