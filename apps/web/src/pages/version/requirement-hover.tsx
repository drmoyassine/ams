import { useQuery } from '@tanstack/react-query';
import type { RequirementContext, RequirementContexts } from '@ams/shared';
import { HoverCard } from '../../components/accordion';
import { ReviewBadge } from '../../components/badges';
import { ContentText } from '../../components/content-text';
import type { EvidenceApi } from '../../lib/evidence-api';
import { requirementLabel } from '../../lib/format';
import type { Requirement } from '../../lib/framework-api';
import { AssignmentLines } from '../../components/standard-ops/assignment-summary';
import { RELATIONS } from './map-to-iqf-dialog';

/** What every requirement of a version holds (mapped IQF items, inherited and direct evidence), asked once for the whole page. */
export function useRequirementContexts(api: EvidenceApi, versionId: string) {
  return useQuery({ queryKey: ['requirement-context', versionId], queryFn: () => api.requirementContext(versionId), staleTime: 30_000 });
}

const Heading = ({ children }: { children: string }) => <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</p>;

/** The evidence list of one requirement: its own links, then what the mapped IQF items bring (grouped by item), with the full counts. */
export function EvidenceSummary({ ctx, showDirect = true }: { ctx: RequirementContext; /** False where the requirement's own links are listed in full beside it. */ showDirect?: boolean }) {
  const byItem = new Map<string, RequirementContext['inherited']>();
  for (const e of ctx.inherited) byItem.set(e.internalCode, [...(byItem.get(e.internalCode) ?? []), e]);
  const line = (e: { title: string; versionNo: number; periodLabel: string | null }) => (
    <><ContentText>{e.title}</ContentText> <span className="text-muted-foreground">v{e.versionNo}{e.periodLabel ? ` · ${e.periodLabel}` : ''}</span></>
  );
  return (
    <>
      {showDirect && <Heading>Linked evidence</Heading>}
      {showDirect && (ctx.direct.length === 0 ? <p className="text-xs text-muted-foreground">None linked to this requirement itself.</p> : (
        <ul className="list-disc ps-4 text-xs" aria-label="Directly linked evidence">
          {ctx.direct.map((e, i) => <li key={`${e.evidenceItemId}-${i}`}>{line(e)}{e.reviewStatus !== 'approved' && <span className="text-muted-foreground"> ({e.reviewStatus})</span>}</li>)}
          {ctx.directCount > ctx.direct.length && <li className="list-none text-muted-foreground">and {ctx.directCount - ctx.direct.length} more</li>}
        </ul>
      ))}
      {[...byItem].map(([code, list]) => (
        <div key={code} className="mt-1">
          <p className="text-xs font-medium">Inherited from IQF {code}</p>
          <ul className="list-disc ps-4 text-xs" aria-label={`Evidence inherited from IQF ${code}`}>{list.map((e, i) => <li key={`${e.evidenceItemId}-${i}`}>{line(e)}</li>)}</ul>
        </div>
      ))}
      {ctx.inheritedCount > ctx.inherited.length && <p className="mt-1 text-xs text-muted-foreground">and {ctx.inheritedCount - ctx.inherited.length} more inherited</p>}
    </>
  );
}

/**
 * The tooltip of a requirement's card: its code, title and description, the IQF items it is mapped to (relation and review
 * state) and its evidence (its own links and what the approved mappings pass on). It reads the page's one batched answer, so
 * hovering costs no request; until that has loaded it says so. Opened by hovering or by keyboard focus.
 */
export function RequirementHover({ r, name, contexts }: { r: Requirement; name: string; contexts: { data: RequirementContexts | undefined; isError: boolean } }) {
  const ctx = contexts.data?.byCode[r.code];
  return (
    <HoverCard>
      <p className="font-semibold"><ContentText>{name}</ContentText></p>
      <p className="mt-1 line-clamp-4 text-muted-foreground"><ContentText>{r.officialText || 'No description.'}</ContentText></p>
      {!contexts.data && !contexts.isError && <p className="mt-2 text-xs text-muted-foreground">Loading…</p>}
      {contexts.isError && <p className="mt-2 text-xs text-muted-foreground">The IQF links and evidence could not be loaded.</p>}
      {ctx && (
        <>
          <Heading>Mapped to IQF</Heading>
          {ctx.mappings.length === 0 ? <p className="text-xs text-muted-foreground">Not mapped to your quality framework yet.</p> : (
            <ul className="space-y-0.5 text-xs" aria-label="Mapped IQF items">
              {ctx.mappings.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-x-2">
                  <span className="min-w-0 break-words"><ContentText>{requirementLabel(m.internalCode, m.internalTitle ?? '')}</ContentText></span>
                  <span className="text-muted-foreground">{RELATIONS[m.relation]}</span>
                  <ReviewBadge status={m.reviewStatus} />
                </li>
              ))}
            </ul>
          )}
          <EvidenceSummary ctx={ctx} />
          {ctx.scope && ctx.champion && <AssignmentLines assignment={{ scope: ctx.scope, champion: ctx.champion, ...(ctx.plans ? { plans: ctx.plans } : {}) }} internal={false} />}
        </>
      )}
    </HoverCard>
  );
}
