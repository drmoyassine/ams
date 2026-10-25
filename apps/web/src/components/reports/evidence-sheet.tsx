// The evidence sheet (TASK-092): the approved evidence of the section's linked requirements, plus a search over the
// institution's evidence. "Cite" puts the token in the narrative at the cursor; the evidence panel itself is a sheet —
// the report stays full width (DEC of the plan: no side panels).
import { useEffect, useState } from 'react';
import type { SectionRequirement } from '@ams/shared';
import { BottomSheet } from '../bottom-sheet';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useTranslation } from '../../i18n';
import { useEvidenceApi, type EvidenceApi } from '../../lib/evidence-api';
import { useAction } from '../../lib/use-action';

export interface CitableEvidence { versionId: string; title: string; code: string | null; where: string }

export function EvidenceSheet({ requirements, onCite, onClose, api: override }: {
  requirements: SectionRequirement[];
  /** Puts [E:<versionId>] in the narrative and closes the sheet. */
  onCite: (evidence: CitableEvidence) => void;
  onClose: () => void;
  /** Injectable client (tests); the default talks to the app. */
  api?: EvidenceApi;
}) {
  const { t } = useTranslation();
  const api = useEvidenceApi(override);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState<CitableEvidence[]>([]);
  const [approved, setApproved] = useState<CitableEvidence[] | null>(null);

  // The approved links of every requirement the section answers (a link approved by a reviewer; TASK-088's rule).
  useEffect(() => {
    let live = true;
    void (async () => {
      const all = await Promise.all(requirements.map(async (r) => {
        const links = await act(() => api.internalLinks(r.requirementId)) ?? [];
        return links.filter((l) => l.reviewStatus === 'approved').map((l) => ({
          versionId: l.evidenceVersionId, title: l.evidenceTitle, code: r.code, where: t('rep.linkedEvidence'),
        }));
      }));
      if (live) setApproved(all.flat());
    })();
    return () => { live = false; };
    // The requirements of a section are fixed once the report is made; load them once.
  }, []);

  const search = async () => {
    const items = await act(() => api.list(query.trim() || undefined)) ?? [];
    setSearched(items.filter((i) => i.latest).map((i) => ({
      versionId: i.latest!.id, title: i.title, code: null, where: t('rep.searchedEvidence'),
    })));
  };

  const row = (e: CitableEvidence) => (
    <li key={`${e.where}:${e.versionId}`} className="flex flex-wrap items-center gap-2" data-testid="citable-evidence">
      <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{e.title}</span>
      {e.code && <span className="rounded bg-muted px-1 text-xs text-muted-foreground">{e.code}</span>}
      <Button type="button" variant="outline" onClick={() => onCite(e)} data-testid={`cite-${e.versionId}`}>{t('rep.cite')}</Button>
    </li>
  );

  return (
    <BottomSheet labelledBy="evidence-sheet-title" onClose={onClose}>
      <h2 id="evidence-sheet-title" className="mb-2 text-lg font-semibold">{t('rep.evidenceSheet')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('rep.evidenceSheetIntro')}</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {approved !== null && (
        <section aria-label={t('rep.linkedEvidence')} className="mb-4">
          <h3 className="mb-1 text-sm font-medium">{t('rep.linkedEvidence')}</h3>
          {approved.length === 0
            ? <p className="text-sm text-muted-foreground" data-testid="no-linked-evidence">{t('rep.noLinkedEvidence')}</p>
            : <ul className="space-y-1">{approved.map(row)}</ul>}
        </section>
      )}
      <section aria-label={t('rep.searchedEvidence')}>
        <h3 className="mb-1 text-sm font-medium">{t('rep.searchedEvidence')}</h3>
        <div className="mb-2 flex gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t('rep.searchEvidence')} placeholder={t('rep.searchEvidence')} data-testid="evidence-search" />
          <Button type="button" variant="outline" onClick={() => void search()} data-testid="search-evidence">{t('common.search')}</Button>
        </div>
        {searched.length === 0
          ? <p className="text-sm text-muted-foreground">{t('rep.searchHint')}</p>
          : <ul className="space-y-1">{searched.map(row)}</ul>}
      </section>
    </BottomSheet>
  );
}
