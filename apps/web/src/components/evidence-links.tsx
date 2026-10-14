import type { EvidenceLink } from '@ams/shared';
import type { EvidenceApi } from '../lib/evidence-api';
import { ContentText } from './content-text';
import { Button } from './ui/button';
import { useTranslation } from '../i18n';

const REVIEW_CLS = { proposed: 'bg-muted text-muted-foreground', approved: 'bg-emerald-50 text-emerald-900', rejected: 'bg-red-50 text-red-900' } as const;

/** Evidence links with their reason, review state and the flags the PRD asks for (newer version, stale). */
export function EvidenceLinkList({ links, api, canReview, canRemove, onChange, setError, showTarget = false }: {
  links: EvidenceLink[]; api: EvidenceApi; canReview: boolean; canRemove: boolean; onChange: () => void; setError: (m: string) => void; showTarget?: boolean;
}) {
  const { t } = useTranslation();
  const reviewLabel = { proposed: t('evidence.review.proposed'), approved: t('evidence.review.approved'), rejected: t('evidence.review.rejected') } as const;
  const act = (fn: () => Promise<unknown>) => { setError(''); fn().then(onChange, (e: Error) => setError(e.message)); };
  if (links.length === 0) return <p className="text-sm text-muted-foreground">{t('evidence.noLinks')}</p>;
  return (
    <ul className="space-y-2">
      {links.map((l) => (
        <li key={l.id} className="rounded-md border border-border p-2 text-sm" data-testid="evidence-link">
          <div className="flex flex-wrap items-center gap-2">
            {showTarget
              ? <span className="font-medium"><ContentText>{l.target.kind === 'internal' ? `Internal ${l.target.code}${l.target.title ? ` · ${l.target.title}` : ''}` : `${l.target.engagementTitle ?? ''} · ${l.target.code}`}</ContentText></span>
              : <a className="font-medium underline" href={api.fileUrl(l.evidenceVersionId)} target="_blank" rel="noreferrer"><ContentText>{l.evidenceTitle}</ContentText></a>}
            <span className="text-xs text-muted-foreground">v{l.versionNo}{l.periodLabel ? ` · ${l.periodLabel}` : ''}</span>
            <span className={`rounded px-1.5 text-xs ${REVIEW_CLS[l.reviewStatus]}`}>{reviewLabel[l.reviewStatus]}</span>
            {l.newerVersionAvailable && <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-900">{t('evidence.newerVersion', { version: l.latestVersionNo })}</span>}
            {l.stale && <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-900" title={t('evidence.staleHint')}>{t('evidence.stale')}</span>}
          </div>
          <p className="mt-1"><ContentText>{l.rationale}</ContentText></p>
          {l.reviewComment && <p className="text-xs text-muted-foreground">{t('evidence.reviewComment')} <ContentText>{l.reviewComment}</ContentText></p>}
          <div className="mt-1 flex flex-wrap gap-2">
            {canReview && l.reviewStatus !== 'approved' && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => act(() => api.review(l.id, { decision: 'approved' }))}>{t('evidence.approve')}</Button>}
            {canReview && l.reviewStatus === 'proposed' && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => act(() => api.review(l.id, { decision: 'rejected' }))}>{t('evidence.reject')}</Button>}
            {(canRemove || canReview) && <Button type="button" variant="ghost" className="px-2 py-1" aria-label={t('evidence.removeLink', { title: l.evidenceTitle })} onClick={() => act(() => api.remove(l.id))}>{t('common.remove')}</Button>}
          </div>
        </li>
      ))}
    </ul>
  );
}
