import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CONFIG_SECTION_LABEL, CONFIG_STATE_WORDS, GAP_KIND_WORDS, RELATION_WORDS, reportToMarkdown, type AnalysisReport, type AnalysisStats, type ReportCheck, type ReportGap, type ReportItem, type ReportRef } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import type { AnalysisRun, FrameworkApi } from '../../lib/framework-api';
import { progressText, spendText, statsText } from './analysis-panel';

const STATUS_LABEL = { queued: 'Queued', running: 'Running', succeeded: 'Finished', failed: 'Stopped', cancelled: 'Cancelled' } as const;
const STATUS_CLS = {
  queued: 'bg-muted text-muted-foreground', running: 'bg-sky-50 text-sky-900', succeeded: 'bg-emerald-50 text-emerald-900',
  failed: 'bg-red-50 text-red-900', cancelled: 'bg-muted text-muted-foreground',
} as const;
type ReportConfigItem = AnalysisReport['configuration']['items'][number];
const active = (r: AnalysisRun | undefined) => r?.status === 'queued' || r?.status === 'running';
const plural = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;
const when = (s: string | null) => (s ? new Date(s).toLocaleString('en') : 'not recorded');
const duration = (s: number | null) => (s === null ? 'not recorded' : s < 90 ? `${s} seconds` : `${Math.round(s / 60)} minutes`);

export interface ReportNav {
  onShowRequirement: (requirementId: string) => void;
  onShowPage: (documentId: string, page: number) => void;
  onShowMappings: () => void;
  onShowSettings: (section: 'details' | 'sources' | 'ai' | 'lifecycle' | 'templates') => void;
}

/** A requirement / source-page pair of links. Falls back to plain text when the target is missing. */
function Where({ r, nav, label }: { r: ReportRef; nav: ReportNav; label?: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2">
      {r.code && (r.requirementId
        ? <a href={`#requirement-${r.requirementId}`} className="font-medium underline" onClick={(e) => { e.preventDefault(); nav.onShowRequirement(r.requirementId!); }}><ContentText>{label ?? r.code}</ContentText></a>
        : <span className="font-medium"><ContentText>{label ?? r.code}</ContentText></span>)}
      {r.documentId && r.page !== null && (
        <a href={`#source-${r.documentId}`} className="underline" onClick={(e) => { e.preventDefault(); nav.onShowPage(r.documentId!, r.page!); }}>
          <ContentText>{r.documentTitle ?? 'source'}</ContentText>, page {r.page}
        </a>
      )}
    </span>
  );
}

function Card({ id, title, children, hint }: { id: string; title: string; children: ReactNode; hint?: string }) {
  return (
    <section aria-labelledby={`report-${id}`} className="min-w-0 space-y-2 rounded-md border border-border p-3 print:break-inside-avoid" data-testid={`report-${id}`}>
      <h3 id={`report-${id}`} className="font-medium">{title}</h3>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>;

function ItemList({ items, nav, label }: { items: ReportItem[]; nav: ReportNav; label: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 8);
  return (
    <div className="space-y-1">
      <ul aria-label={label} className="space-y-1.5 text-sm">
        {shown.map((i, n) => (
          <li key={`${i.kind}-${i.code}-${n}`} className="min-w-0 break-words" data-testid="report-item">
            <Where r={i} nav={nav} label={i.kind === 'note' ? <>note on {i.code}</> : undefined} />
            {i.why && <span className="text-muted-foreground"> · {i.why}</span>}
            {i.text && <span className="mt-0.5 block text-xs text-muted-foreground"><ContentText>{i.text}</ContentText></span>}
          </li>
        ))}
      </ul>
      {items.length > 8 && <button type="button" className="text-xs underline print:hidden" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button>}
    </div>
  );
}

function GapList({ gaps, nav, label, reasons }: { gaps: ReportGap[]; nav: ReportNav; label: string; reasons?: boolean }) {
  return (
    <ul aria-label={label} className="space-y-1.5 text-sm">
      {gaps.map((g) => (
        <li key={g.key} className="min-w-0 break-words" data-testid="report-gap">
          <Where r={g} nav={nav} />
          <span className="text-muted-foreground"> · {GAP_KIND_WORDS[g.kind]}</span>
          {(reasons ? g.reason : g.detail) && <span className="mt-0.5 block text-xs text-muted-foreground"><ContentText>{(reasons ? g.reason : g.detail) ?? ''}</ContentText></span>}
          {g.variants.length > 0 && (
            <div className="mt-1 grid gap-2 sm:grid-cols-2" data-testid="conflict-variants">
              {g.variants.map((v, n) => (
                <blockquote key={n} className="min-w-0 rounded border border-border bg-muted/40 p-2 text-xs">
                  <a href={`#source-${v.documentId}`} className="font-medium underline" onClick={(e) => { e.preventDefault(); nav.onShowPage(v.documentId, v.page); }}>
                    <ContentText>{v.documentTitle ?? 'source'}</ContentText>, page {v.page}
                  </a>
                  <p className="mt-1 whitespace-pre-line"><ContentText>{v.text}</ContentText></p>
                </blockquote>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

const GROUP_WORD: Record<ReportConfigItem['group'], string> = {
  phase: 'Stage', milestone: 'Milestone', decision: 'Decision', finding: 'Finding', response: 'Response type', rating: 'Rating method', template: 'Report template', section: 'Section',
};
/** One configuration item: what it is, where in the documents, why it is flagged, and the document's own timing words. */
function ConfigRow({ i, nav }: { i: ReportConfigItem; nav: ReportNav }) {
  return (
    <li className="min-w-0 break-words" data-testid={i.status === 'flagged' ? 'config-flagged' : 'config-item'}>
      <span className="text-muted-foreground">{GROUP_WORD[i.group]}{i.under ? ` in ${i.under}` : ''}: </span>
      <span className="font-medium"><ContentText>{i.label}</ContentText></span>
      {i.detail && <span className="text-muted-foreground"> ({i.detail})</span>}
      {' · '}
      <a href={`#source-${i.documentId}`} className="underline" onClick={(e) => { e.preventDefault(); nav.onShowPage(i.documentId, i.page); }}><ContentText>{i.documentTitle ?? 'source'}</ContentText>, page {i.page}</a>
      {i.dueText && <span className="block text-xs">Due as written: <ContentText>{i.dueText}</ContentText></span>}
      {i.reasons.length > 0 && <span className={`block text-xs ${i.status === 'flagged' ? 'text-amber-800' : 'text-muted-foreground'}`}>{i.reasons.join('; ')}</span>}
      {i.status === 'flagged' && i.quote && <span className="block text-xs text-muted-foreground">Quote: <ContentText>{i.quote}</ContentText></span>}
    </li>
  );
}

function CheckLink({ c, nav }: { c: ReportCheck; nav: ReportNav }) {
  const l = c.link;
  if (!l) return <span>{c.label}</span>;
  const go = () => {
    if (l.tab === 'requirements') { if (l.requirementId) nav.onShowRequirement(l.requirementId); else if (l.documentId && l.page !== null) nav.onShowPage(l.documentId, l.page); else nav.onShowRequirement(''); }
    else if (l.tab === 'mappings') nav.onShowMappings();
    else if (l.documentId && l.page !== null) nav.onShowPage(l.documentId, l.page);
    else nav.onShowSettings(l.section ?? 'details');
  };
  return <a href="#" className="underline" onClick={(e) => { e.preventDefault(); go(); }}>{c.label}</a>;
}

function Sections({ report, nav }: { report: AnalysisReport; nav: ReportNav }) {
  const s = report.summary;
  const q = report.requirements;
  const g = report.gaps;
  const m = report.mapping;
  const st = report.structure;
  const cf = report.configuration;
  return (
    <div className="space-y-3">
      <Card id="summary" title="Summary">
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">Status</dt><dd>{STATUS_LABEL[s.status]}{s.error ? ` · ${s.error}` : ''}</dd>
          <dt className="text-muted-foreground">Started by</dt><dd><ContentText>{s.startedBy?.name ?? 'not recorded'}</ContentText> · {when(s.startedAt)}</dd>
          <dt className="text-muted-foreground">Took</dt><dd>{duration(s.durationSeconds)}</dd>
          <dt className="text-muted-foreground">Analysis model</dt><dd>{s.used.analysisModel ?? 'not recorded'}</dd>
          <dt className="text-muted-foreground">Reading (vision) model</dt><dd>{s.used.visionModel ?? 'same as analysis, or none used'}</dd>
          <dt className="text-muted-foreground">Comparing wording</dt><dd>{s.used.embeddings.used ? `words and meaning${s.used.embeddings.model ? ` (${s.used.embeddings.model})` : ''}` : 'words only (lexical only)'}</dd>
          <dt className="text-muted-foreground">AI used</dt>
          <dd>{plural(s.used.calls, 'call')} · {(s.used.inputTokens + s.used.outputTokens).toLocaleString('en')} tokens{s.used.costUsd === null ? '' : ` · $${s.used.costUsd.toFixed(2)}`} · {plural(s.used.recoveryRounds, 'round')} of recovery</dd>
        </dl>
        <h4 className="pt-1 text-sm font-medium">What was read</h4>
        {s.sources.length === 0 ? <Empty>No sources.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-start text-sm" data-testid="report-sources">
              <thead><tr className="text-start text-xs text-muted-foreground">
                <th scope="col" className="py-1 pe-2 text-start font-normal">Document</th><th scope="col" className="pe-2 text-start font-normal">Role</th><th scope="col" className="pe-2 text-start font-normal">Language</th>
                <th scope="col" className="pe-2 text-start font-normal">Pages</th><th scope="col" className="pe-2 text-start font-normal">File text</th><th scope="col" className="pe-2 text-start font-normal">AI vision</th><th scope="col" className="text-start font-normal">Not readable</th>
              </tr></thead>
              <tbody>
                {s.sources.map((d) => (
                  <tr key={d.documentId} className="border-t border-border align-top">
                    <td className="py-1 pe-2 break-words"><ContentText>{d.title}</ContentText>{d.warnings.map((w, n) => <span key={n} className="block text-xs text-amber-800">{w}</span>)}</td>
                    <td className="pe-2">{d.role.replace('_', ' ')}<span className="block text-xs text-muted-foreground">{d.roleDecidedBy === 'person' ? 'chosen by a person' : d.roleDecidedBy === 'analysis' ? 'decided by the analysis' : 'not set'}</span></td>
                    <td className="pe-2"><ContentText>{d.language}</ContentText></td>
                    <td className="pe-2">{d.pages}</td><td className="pe-2">{d.pagesNative}</td><td className="pe-2">{d.pagesOcr}</td><td>{d.pagesUnreadable}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card id="structure" title="Structure found">
        {!st ? <Empty>The analysis stopped before it looked at the structure.</Empty> : (
          <div className="space-y-2 text-sm">
            <p>Level names the analysis proposed: <ContentText>{st.levelLabelsProposed.join(' > ') || 'none'}</ContentText>.{' '}
              {st.levelLabelsWritten ? 'They were written to this version.' : 'Your own level names were kept.'}</p>
            {st.numbering.length > 0 && (
              <ul aria-label="Numbering" className="space-y-0.5">
                {st.numbering.map((n, i) => <li key={i}>Numbering of <ContentText>{n.levelLabel}</ContentText>: <ContentText>{n.examples.join(', ')}</ContentText></li>)}
              </ul>
            )}
            {st.scope && <p>Scope: <ContentText>{st.scope}</ContentText></p>}
            {st.keyTerms.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm underline">{plural(st.keyTerms.length, 'key term')}</summary>
                <ul className="mt-1 space-y-0.5 text-sm">{st.keyTerms.map((k, i) => <li key={i}><span className="font-medium"><ContentText>{k.term}</ContentText></span>{k.meaning && <>: <ContentText>{k.meaning}</ContentText></>}</li>)}</ul>
              </details>
            )}
          </div>
        )}
      </Card>

      <Card id="requirements" title="Requirements">
        <p className="text-sm">{plural(q.total, 'requirement')} and {plural(q.notes, 'note')} in the draft now{q.byLevel.length ? ` (${q.byLevel.map((l) => `${l.count} ${l.level}`).join(', ')})` : ''}.</p>
        <p className="text-sm" data-testid="quotes-found">{q.quotes.found} of {q.quotes.total} quotes found in the source ({q.quotes.percent}%).</p>
        {q.orphans > 0 && <p className="text-sm">{plural(q.orphans, 'item')} without a parent.</p>}
        {q.keptYourEdits > 0 && <p className="text-sm">{plural(q.keptYourEdits, 'item')} you edited: kept as you left {q.keptYourEdits === 1 ? 'it' : 'them'}.</p>}
        {q.quoteNotFound.length > 0 && <><h4 className="pt-1 text-sm font-medium">Quote not found in the source</h4><ItemList items={q.quoteNotFound} nav={nav} label="Quote not found" /></>}
        {q.lowConfidence.length > 0 && <><h4 className="pt-1 text-sm font-medium">The analysis was not sure about</h4><ItemList items={q.lowConfidence} nav={nav} label="Low confidence" /></>}
        {q.suggestedNotConfirmed.length > 0 && <><h4 className="pt-1 text-sm font-medium">Suggested by the analysis (not confirmed in the source)</h4><ItemList items={q.suggestedNotConfirmed} nav={nav} label="Suggested notes" /></>}
        {q.deleted.length > 0 && (
          <>
            <h4 className="pt-1 text-sm font-medium">You deleted these; they were not added back</h4>
            <ul aria-label="Deleted by you" className="text-sm">{q.deleted.map((d, i) => <li key={i}>{d.kind} <ContentText>{d.code}</ContentText></li>)}</ul>
          </>
        )}
      </Card>

      <Card id="gaps" title="Gaps and conflicts" hint={g.stopped ?? undefined}>
        <p className="text-sm">{g.recovered.length} recovered · {g.confirmedAbsent.length} confirmed absent · {g.unresolved.length} unresolved · {plural(g.conflicts.length, 'conflict')} · {plural(g.uncoveredPages.length, 'page')} not covered.</p>
        {g.unresolved.length > 0 && <><h4 className="pt-1 text-sm font-medium">Still unresolved</h4><GapList gaps={g.unresolved} nav={nav} label="Unresolved gaps" /></>}
        {g.conflicts.length > 0 && <><h4 className="pt-1 text-sm font-medium">Conflicts: the same code, worded differently</h4><GapList gaps={g.conflicts} nav={nav} label="Conflicts" /></>}
        {g.uncoveredPages.length > 0 && <><h4 className="pt-1 text-sm font-medium">Pages with text that nothing cites</h4><GapList gaps={g.uncoveredPages} nav={nav} label="Pages not covered" /></>}
        {g.confirmedAbsent.length > 0 && <><h4 className="pt-1 text-sm font-medium">Confirmed absent, with the reason</h4><GapList gaps={g.confirmedAbsent} nav={nav} label="Confirmed absent" reasons /></>}
        {g.recovered.length > 0 && <><h4 className="pt-1 text-sm font-medium">Recovered</h4><GapList gaps={g.recovered} nav={nav} label="Recovered" /></>}
      </Card>

      <Card id="mapping" title="Links to your quality framework">
        {!m.ran ? <Empty>No links were suggested{m.skipped ? `: ${m.skipped.charAt(0).toLowerCase()}${m.skipped.slice(1)}` : '.'}</Empty> : (
          <div className="space-y-2 text-sm">
            <p>Candidates were found by {m.retrieval}{m.embeddingsNote ? ` (${m.embeddingsNote})` : ''}. {m.stopped}</p>
            <p>Suggested links: {m.byRelation.covers} covers · {m.byRelation.partly_covers} partly covers · {m.byRelation.related} related. {plural(m.noSuggestion.length, 'requirement')} with no suggestion · {plural(m.newItems.length, 'suggested new item')}.</p>
            <p data-testid="mapping-decisions">Decided so far: links {m.decisions.linksAccepted} accepted, {m.decisions.linksDismissed} dismissed, {m.decisions.linksWaiting} waiting · new items {m.decisions.newItemsAccepted} accepted, {m.decisions.newItemsDismissed} dismissed, {m.decisions.newItemsWaiting} waiting.</p>
            {m.suggested.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-sm" data-testid="report-links">
                  <thead><tr className="text-xs text-muted-foreground"><th scope="col" className="py-1 pe-2 text-start font-normal">Requirement</th><th scope="col" className="text-start font-normal">Suggested links</th></tr></thead>
                  <tbody>
                    {m.suggested.map((x) => (
                      <tr key={x.ref.code ?? ''} className="border-t border-border align-top">
                        <td className="py-1 pe-2"><Where r={x.ref} nav={nav} /></td>
                        <td>{x.links.map((l) => (
                          <span key={l.internalCode} className="block break-words">
                            <a href="#" className="underline" onClick={(e) => { e.preventDefault(); nav.onShowMappings(); }}>{RELATION_WORDS[l.relation]} <ContentText>{l.internalCode}{l.internalTitle ? ` ${l.internalTitle}` : ''}</ContentText></a>
                            {l.reviewStatus !== 'pending' && <span className="text-xs text-muted-foreground"> · {l.reviewStatus === 'approved' ? 'accepted' : 'dismissed'}</span>}
                          </span>
                        ))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {m.noSuggestion.length > 0 && (
              <><h4 className="pt-1 font-medium">Requirements with no suggested link</h4>
                <ul aria-label="No suggestion" className="flex flex-wrap gap-x-3 gap-y-1">{m.noSuggestion.map((r) => <li key={r.code ?? ''}><Where r={r} nav={nav} /></li>)}</ul></>
            )}
            {m.newItems.length > 0 && (
              <><h4 className="pt-1 font-medium">Suggested new quality framework items</h4>
                <ul aria-label="Suggested new items" className="space-y-1">
                  {m.newItems.map((n) => (
                    <li key={n.proposalId} className="break-words">
                      <a href="#" className="underline" onClick={(e) => { e.preventDefault(); nav.onShowMappings(); }}><ContentText>{n.code} {n.title}</ContentText></a>
                      <span className="text-xs text-muted-foreground"> · {n.status === 'pending' ? 'waiting' : n.status} · covers {n.covers.map((c) => c.externalCode).join(', ')}</span>
                    </li>
                  ))}
                </ul></>
            )}
          </div>
        )}
      </Card>

      <Card id="configuration" title="Configuration found" hint="From the policy, report-template and guidance documents. Everything here is a proposal in the draft; publishing the version is the review. Date rules are never taken from the documents.">
        {!cf.ran ? <Empty>Not read{cf.skipped ? `: ${cf.skipped.charAt(0).toLowerCase()}${cf.skipped.slice(1)}` : '.'}</Empty> : (
          <div className="space-y-2 text-sm">
            {cf.stopped && <p>{cf.stopped}</p>}
            {cf.documents.length > 0 && (
              <ul aria-label="Documents read for configuration" className="space-y-0.5">
                {cf.documents.map((d) => (
                  <li key={d.documentId} className="break-words" data-testid="config-document">
                    <span className="font-medium"><ContentText>{d.title}</ContentText></span>: {d.found.length ? <ContentText>{d.found.join(', ')}</ContentText> : 'nothing to take'}
                    {d.note && <span className="text-muted-foreground"> · <ContentText>{d.note}</ContentText></span>}
                  </li>
                ))}
              </ul>
            )}
            {cf.sections.length > 0 && (
              <ul aria-label="Configuration parts" className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                {cf.sections.map((x) => (
                  <li key={x.section} data-testid="config-section">
                    <span className="font-medium">{CONFIG_SECTION_LABEL[x.section]}</span>: {CONFIG_STATE_WORDS[x.state]} · {x.written} written · {x.flagged} flagged{x.editedSince ? ' · you edited it since' : ''}
                  </li>
                ))}
              </ul>
            )}
            {cf.milestonesNeedingDueRule > 0 && (
              <p data-testid="config-due-rules">{plural(cf.milestonesNeedingDueRule, 'milestone')} still {cf.milestonesNeedingDueRule === 1 ? 'needs' : 'need'} a due rule set by a reviewer. The documents' words are kept with each one; no date was taken from them.</p>
            )}
            {cf.notFound.length > 0 && <ul aria-label="Not found in the documents" className="list-disc ps-5">{cf.notFound.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            {cf.deletedByPerson.length > 0 && <p>You deleted <ContentText>{cf.deletedByPerson.join(', ')}</ContentText>; it was not added back.</p>}
            {cf.items.filter((i) => i.status !== 'flagged').length > 0 && (
              <details open={cf.items.length <= 12}>
                <summary className="cursor-pointer underline">Found and written ({cf.items.filter((i) => i.status !== 'flagged').length})</summary>
                <ul aria-label="Configuration found" className="mt-1 space-y-1.5">
                  {cf.items.filter((i) => i.status !== 'flagged').map((i, n) => <ConfigRow key={`${i.group}-${i.ref ?? i.label}-${n}`} i={i} nav={nav} />)}
                </ul>
              </details>
            )}
            {cf.flagged.length > 0 && (
              <>
                <h4 className="pt-1 font-medium">Kept out of the configuration</h4>
                <ul aria-label="Configuration flagged" className="space-y-1.5">
                  {cf.flagged.map((i, n) => <ConfigRow key={`${i.group}-${i.label}-${n}`} i={i} nav={nav} />)}
                </ul>
              </>
            )}
          </div>
        )}
      </Card>

      <Card id="checklist" title="Before you publish">
        {report.checklist.length === 0 && report.validation.problems.length === 0 && report.validation.warnings.length === 0
          ? <Empty>Nothing is flagged. Publishing is still your decision.</Empty>
          : (
            <ul aria-label="Before you publish" className="space-y-1.5 text-sm">
              {report.checklist.map((c) => <li key={c.id} data-testid="report-check" className="break-words"><CheckLink c={c} nav={nav} /></li>)}
              {report.validation.problems.length > 0 && (
                <li><span className="font-medium">Problems to fix</span>
                  <ul className="list-disc ps-5">{report.validation.problems.map((p, i) => <li key={i} className="break-words"><ContentText>{p}</ContentText></li>)}</ul></li>
              )}
              {report.validation.warnings.length > 0 && (
                <li><span className="font-medium">To check (not blocking)</span>
                  <ul className="list-disc ps-5">{report.validation.warnings.map((p, i) => <li key={i} className="break-words"><ContentText>{p}</ContentText></li>)}</ul></li>
              )}
            </ul>
          )}
      </Card>
    </div>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/**
 * The Report tab: the runs of this version and the intelligence report of the selected one (what was read and used, the
 * structure found, the requirements, the gaps, the suggested links and what to look at before publishing). Counts of what
 * was found and checked; never a score or a verdict. The selected run is part of the address, so a person can come back.
 */
export function ReportTab({ api, versionId, runId, onSelectRun, nav, title }: {
  api: FrameworkApi; versionId: string; runId?: string | undefined; onSelectRun: (id: string) => void; nav: ReportNav; title: string;
}) {
  const runs = useQuery({
    queryKey: ['analysis', versionId], queryFn: () => api.analysisRuns(versionId),
    refetchInterval: (q) => (active(q.state.data?.[0]) ? 2000 : false),
  });
  const list = runs.data ?? [];
  const selected = list.find((r) => r.id === runId) ?? list[0];
  const running = active(selected);
  const report = useQuery({
    queryKey: ['analysis-report', selected?.id, selected?.status, selected?.finishedAt], queryFn: () => api.analysisReport(selected!.id),
    enabled: !!selected && !running,
  });
  // Land on the newest run in the address when none was asked for.
  useEffect(() => { if (!runId && list[0]) onSelectRun(list[0].id); }, [runId, list, onSelectRun]);

  if (runs.isError) return <p role="alert" className="text-sm text-red-700">Could not load the analysis runs.</p>;
  if (!runs.data) return <p>Loading…</p>;
  if (list.length === 0) return <p className="text-sm text-muted-foreground">No analysis has run on this version yet. Start one under Docs; its report appears here.</p>;

  return (
    <section aria-label="Analysis report" className="space-y-3">
      <h2 className="text-lg font-semibold">Analysis report</h2>
      <nav aria-label="Analysis runs" className="print:hidden">
        <ul className="flex flex-col gap-1 text-sm">
          {list.map((r) => {
            const stats = (r.report as { stats?: AnalysisStats }).stats;
            const on = r.id === selected?.id;
            return (
              <li key={r.id}>
                <button type="button" aria-current={on ? 'true' : undefined} onClick={() => onSelectRun(r.id)}
                  className={`flex w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md border px-2 py-1.5 text-start break-words hover:bg-muted ${on ? 'border-primary bg-muted' : 'border-border'}`}>
                  <span className={`rounded px-1.5 text-xs ${STATUS_CLS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  <span className="text-xs text-muted-foreground">{when(r.startedAt ?? r.createdAt)}</span>
                  {stats && <span className="min-w-0 text-xs">{plural(stats.requirements, 'requirement')}, {plural(stats.notes, 'note')}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {selected && running && (
        <div role="status" aria-label="Analysis progress" aria-live="polite" className="rounded bg-muted px-2 py-1 text-sm break-words">
          {progressText(selected)}<span className="block text-xs text-muted-foreground">The report appears here when the analysis finishes.</span>
        </div>
      )}
      {selected && !running && (
        <>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Button type="button" variant="outline" disabled={!report.data} onClick={() => window.print()}>Print / save as PDF</Button>
            <Button type="button" variant="outline" disabled={!report.data}
              onClick={() => { if (report.data) download(`analysis-report-${selected.id.slice(0, 8)}.md`, reportToMarkdown(report.data, `Analysis report: ${title}`)); }}>Download as Markdown</Button>
            <span className="text-xs text-muted-foreground">{statsText((selected.report as { stats?: AnalysisStats }).stats)} {spendText(selected.usage)}</span>
          </div>
          {report.isError && <p role="alert" className="text-sm text-red-700">Could not load this report.</p>}
          {report.isLoading && <p>Loading…</p>}
          {report.data && <Sections report={report.data} nav={nav} />}
        </>
      )}
    </section>
  );
}
