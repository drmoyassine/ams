import { z } from 'zod';
import { ANALYSIS_GAP_KINDS, ANALYSIS_STAGES, ANALYSIS_STATUSES, CONFIG_SECTIONS, CONFIG_SECTION_LABEL, CONFIG_SECTION_STATES, ConfigItemResultSchema } from './analysis.js';

/**
 * The intelligence report of one analysis run (PRD 15, step F1). Computed on demand from what is stored (so it reflects
 * later edits), plus a frozen copy of the run-time numbers (usage, durations, the stats the run wrote). Every item
 * carries ids and pages so the screen can jump to the requirement card, the source page or the Mappings tab.
 * Wording rules (DEC-005): counts of what was found and checked only; never a score, a share of "compliance" or a
 * prediction; no embedding similarity numbers.
 */
export const ANALYSIS_REPORT_VERSION = 1;

/** Where an item can be found: the requirement card, and the source page. */
export const ReportRefSchema = z.object({
  code: z.string().nullable(),
  title: z.string().nullable(),
  requirementId: z.string().nullable(),
  documentId: z.string().nullable(),
  documentTitle: z.string().nullable(),
  page: z.number().int().nullable(),
});
export type ReportRef = z.infer<typeof ReportRefSchema>;

export const ReportItemSchema = ReportRefSchema.extend({
  kind: z.enum(['requirement', 'note', 'page']),
  /** The accreditor's wording (or a short description) so a person can recognise the item. */
  text: z.string().nullable(),
  /** Why it is listed, in plain words. */
  why: z.string().nullable(),
});
export type ReportItem = z.infer<typeof ReportItemSchema>;

export const ReportGapSchema = ReportRefSchema.extend({
  key: z.string(),
  kind: z.enum(ANALYSIS_GAP_KINDS),
  status: z.enum(['open', 'recovered', 'confirmed_absent', 'unresolved', 'conflict']),
  detail: z.string().nullable(),
  /** The model's reason when it confirmed the gap is not there. */
  reason: z.string().nullable(),
  attempts: z.number().int(),
  /** A conflict: each wording as the sources have it, side by side. */
  variants: z.array(z.object({ documentId: z.string(), documentTitle: z.string().nullable(), page: z.number().int(), text: z.string() })),
});
export type ReportGap = z.infer<typeof ReportGapSchema>;

export const ReportSourceSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  role: z.string(),
  /** Who decided the role: a person, the analysis, or nobody yet. */
  roleDecidedBy: z.enum(['person', 'analysis', 'unset']),
  language: z.string(),
  pages: z.number().int(),
  /** Pages read from the file's own text, pages read by the AI's vision (OCR), and pages that could not be read. */
  pagesNative: z.number().int(),
  pagesOcr: z.number().int(),
  pagesUnreadable: z.number().int(),
  /** Pages typed in or of another kind (tables, slides, sheets) are counted in `pages` only. */
  warnings: z.array(z.string()),
});
export type ReportSource = z.infer<typeof ReportSourceSchema>;

export const ReportLinkSchema = z.object({
  tab: z.enum(['requirements', 'mappings', 'docs', 'settings']),
  /** Settings section, for tab 'settings'; 'ai' means Settings -> AI (outside the version page). 'sources' is the old name of the Docs tab. */
  section: z.enum(['details', 'sources', 'ai', 'lifecycle', 'templates']).nullable(),
  requirementId: z.string().nullable(),
  documentId: z.string().nullable(),
  page: z.number().int().nullable(),
});
export type ReportLink = z.infer<typeof ReportLinkSchema>;

export const ReportCheckSchema = z.object({
  id: z.string(),
  /** Plain words: what to look at. */
  label: z.string(),
  count: z.number().int(),
  /** 'look': a person should look before publishing; 'info': for information. */
  level: z.enum(['look', 'info']),
  link: ReportLinkSchema.nullable(),
});
export type ReportCheck = z.infer<typeof ReportCheckSchema>;

export const ReportSuggestedLinkSchema = z.object({
  internalCode: z.string(),
  internalTitle: z.string().nullable(),
  relation: z.enum(['covers', 'partly_covers', 'related']),
  rationale: z.string().nullable(),
  /** pending: waiting for a person; approved / rejected: decided. */
  reviewStatus: z.enum(['pending', 'approved', 'rejected']),
});

export const ReportNewIqfItemSchema = z.object({
  proposalId: z.string(),
  status: z.enum(['pending', 'accepted', 'dismissed', 'superseded']),
  code: z.string(),
  title: z.string(),
  parentCode: z.string().nullable(),
  reason: z.string().nullable(),
  covers: z.array(z.object({ externalCode: z.string(), requirementId: z.string().nullable(), relation: z.string() })),
});

export const AnalysisReportSchema = z.object({
  reportVersion: z.literal(ANALYSIS_REPORT_VERSION),
  runId: z.string(),
  versionId: z.string(),
  generatedAt: z.string(),

  /** a. What was read and what was used. */
  summary: z.object({
    status: z.enum(ANALYSIS_STATUSES),
    stage: z.enum(ANALYSIS_STAGES).nullable(),
    error: z.string().nullable(),
    startedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    durationSeconds: z.number().nullable(),
    sources: z.array(ReportSourceSchema),
    used: z.object({
      /** Models as recorded by the run; never a key. */
      analysisModel: z.string().nullable(),
      visionModel: z.string().nullable(),
      embeddings: z.object({ used: z.boolean(), model: z.string().nullable(), note: z.string().nullable() }),
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number().nullable(),
      calls: z.number().int(),
      recoveryRounds: z.number().int(),
      promptVersions: z.record(z.string(), z.string()),
    }),
  }),

  /** b. How the accreditor's standards are organised, as the structure stage proposed. Null when the run did not get that far. */
  structure: z.object({
    levelLabelsProposed: z.array(z.string()),
    /** The names written to the version by the run; null when a person's own names were kept. */
    levelLabelsWritten: z.array(z.string()).nullable(),
    levelLabelsNow: z.array(z.string()),
    numbering: z.array(z.object({ levelLabel: z.string(), examples: z.array(z.string()) })),
    keyTerms: z.array(z.object({ term: z.string(), meaning: z.string().nullable() })),
    scope: z.string().nullable(),
  }).nullable(),

  /** c. What was taken out. Counts are live (they follow later edits); `atRun` is what the run itself wrote. */
  requirements: z.object({
    total: z.number().int(),
    notes: z.number().int(),
    byLevel: z.array(z.object({ level: z.string(), count: z.number().int() })),
    quotes: z.object({ found: z.number().int(), total: z.number().int(), percent: z.number().int() }),
    /** Requirements and notes whose quote is not found in the source. */
    quoteNotFound: z.array(ReportItemSchema),
    lowConfidence: z.array(ReportItemSchema),
    /** Notes the analysis suggests that the source does not confirm. */
    suggestedNotConfirmed: z.array(ReportItemSchema),
    orphans: z.number().int(),
    /** Items you deleted that the analysis did not add back. */
    deleted: z.array(z.object({ kind: z.enum(['requirement', 'note']), code: z.string() })),
    keptYourEdits: z.number().int(),
    atRun: z.object({ requirements: z.number().int(), notes: z.number().int(), quotesFound: z.number().int(), quotesTotal: z.number().int() }).nullable(),
  }),

  /** d. Check and recover. */
  gaps: z.object({
    recovered: z.array(ReportGapSchema),
    confirmedAbsent: z.array(ReportGapSchema),
    unresolved: z.array(ReportGapSchema),
    conflicts: z.array(ReportGapSchema),
    uncoveredPages: z.array(ReportGapSchema),
    rounds: z.number().int(),
    /** Why the recovery stopped, in words; null when it ran to the end. */
    stopped: z.string().nullable(),
  }),

  /** e. Suggested links to the institution's quality framework. */
  mapping: z.object({
    ran: z.boolean(),
    skipped: z.string().nullable(),
    retrieval: z.enum(['words and meaning', 'words only']),
    embeddingsNote: z.string().nullable(),
    requirementsConsidered: z.number().int(),
    suggested: z.array(z.object({ ref: ReportRefSchema, links: z.array(ReportSuggestedLinkSchema) })),
    byRelation: z.object({ covers: z.number().int(), partly_covers: z.number().int(), related: z.number().int() }),
    noSuggestion: z.array(ReportRefSchema),
    newItems: z.array(ReportNewIqfItemSchema),
    decisions: z.object({
      linksWaiting: z.number().int(), linksAccepted: z.number().int(), linksDismissed: z.number().int(),
      newItemsWaiting: z.number().int(), newItemsAccepted: z.number().int(), newItemsDismissed: z.number().int(),
    }),
    stopped: z.string().nullable(),
  }),

  /** e2. Configuration found in the policy, template and guidance documents (step H): lifecycle, vocabularies, templates. */
  configuration: z.object({
    ran: z.boolean(),
    /** Why the configuration stages did not run; null when they did. */
    skipped: z.string().nullable(),
    stopped: z.string().nullable(),
    /** Per part of the configuration: what the run did with it, and whether a person has edited it since. */
    sections: z.array(z.object({
      section: z.enum(CONFIG_SECTIONS), state: z.enum(CONFIG_SECTION_STATES), written: z.number().int(), flagged: z.number().int(), editedSince: z.boolean(),
    })),
    /** Everything found, in reading order; `flagged` is the subset kept out of the configuration. */
    items: z.array(ConfigItemResultSchema.extend({ documentTitle: z.string().nullable() })),
    flagged: z.array(ConfigItemResultSchema.extend({ documentTitle: z.string().nullable() })),
    notFound: z.array(z.string()),
    deletedByPerson: z.array(z.string()),
    milestonesNeedingDueRule: z.number().int(),
    /** Documents read for it, with what each held. */
    documents: z.array(z.object({ documentId: z.string(), title: z.string(), role: z.string(), found: z.array(z.string()), note: z.string().nullable() })),
  }),

  /** f. What to look at before publishing. */
  checklist: z.array(ReportCheckSchema),
  /** The version's own validation problems and warnings (validateVersion). */
  validation: z.object({ problems: z.array(z.string()), warnings: z.array(z.string()) }),
});
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;

// ---- Run readiness (preflight) ---------------------------------------------------------------------------------------

export const PreflightCheckSchema = z.object({
  id: z.string(),
  /** ok: fine. problem: blocks a run. note: fine, but worth knowing (for example, embeddings are off). */
  status: z.enum(['ok', 'problem', 'note']),
  message: z.string(),
  /** Where to fix it. 'ai' is Settings -> AI; 'sources' the Sources section; 'version' is this version's status. */
  fix: z.object({ label: z.string(), where: z.enum(['ai', 'sources', 'version', 'docs']) }).nullable(),
});
export type PreflightCheck = z.infer<typeof PreflightCheckSchema>;
export const PreflightSchema = z.object({
  canStart: z.boolean(),
  /** The first blocking reason, for the disabled button. */
  firstProblem: z.string().nullable(),
  checks: z.array(PreflightCheckSchema),
});
export type Preflight = z.infer<typeof PreflightSchema>;

// ---- Markdown --------------------------------------------------------------------------------------------------------

const plural = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;
const date = (s: string | null) => (s ? new Date(s).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'not recorded');
const dur = (s: number | null) => (s === null ? 'not recorded' : s < 90 ? `${Math.round(s)} seconds` : `${Math.round(s / 60)} minutes`);
const where = (r: { documentTitle: string | null; page: number | null }) => (r.documentTitle && r.page !== null ? ` (${r.documentTitle}, page ${r.page})` : '');
const quoteLine = (s: string | null) => (s ? ` ${s.replace(/\s+/g, ' ').slice(0, 300)}` : '');
export const GAP_KIND_WORDS: Record<(typeof ANALYSIS_GAP_KINDS)[number], string> = {
  numbering_gap: 'possibly missing', missing_parent: 'parent not found', unverified_quote: 'quote not found', low_confidence: 'low confidence',
  uncovered_page: 'page not covered', conflict: 'conflicting wording',
};
export const CONFIG_STATE_WORDS = { written: 'written to the draft', kept_your_edits: 'left as you edited it', nothing_found: 'nothing found', flagged_only: 'only flagged proposals' } as const;
export const RELATION_WORDS = { covers: 'covers', partly_covers: 'partly covers', related: 'related' } as const;

/** The report as Markdown (for "Download as Markdown"). Plain text only; the accreditor's wording is quoted as it is. */
export function reportToMarkdown(r: AnalysisReport, title = 'Analysis report'): string {
  const o: string[] = [`# ${title}`, ''];
  const s = r.summary;
  o.push('## Summary', '',
    `- Status: ${s.status}${s.error ? ` (${s.error})` : ''}`,
    `- Started by: ${s.startedBy?.name ?? 'not recorded'}, ${date(s.startedAt)}`,
    `- Finished: ${date(s.finishedAt)} (took ${dur(s.durationSeconds)})`,
    `- Analysis model: ${s.used.analysisModel ?? 'not recorded'}`,
    `- Reading (vision) model: ${s.used.visionModel ?? 'same as analysis, or none used'}`,
    `- Comparing wording: ${s.used.embeddings.used ? `words and meaning (${s.used.embeddings.model ?? 'embedding model'})` : 'words only (lexical only)'}`,
    `- AI calls: ${s.used.calls}; tokens: ${s.used.inputTokens + s.used.outputTokens}${s.used.costUsd === null ? '' : `; cost: $${s.used.costUsd.toFixed(2)}`}`,
    `- Rounds of recovery: ${s.used.recoveryRounds}`, '', '### What was read', '');
  if (!s.sources.length) o.push('- No sources.');
  for (const d of s.sources) {
    o.push(`- ${d.title}: ${d.role} (${d.roleDecidedBy === 'person' ? 'chosen by a person' : d.roleDecidedBy === 'analysis' ? 'decided by the analysis' : 'not set'}), language ${d.language}, ${plural(d.pages, 'page')}: ${d.pagesNative} from the file's text, ${d.pagesOcr} read by AI vision, ${d.pagesUnreadable} not readable`);
    for (const w of d.warnings) o.push(`  - Warning: ${w}`);
  }
  if (r.structure) {
    const t = r.structure;
    o.push('', '## Structure found', '', `- Level names proposed: ${t.levelLabelsProposed.join(' > ') || 'none'}`,
      `- Written to the version: ${t.levelLabelsWritten ? t.levelLabelsWritten.join(' > ') : 'no, your own level names were kept'}`);
    for (const n of t.numbering) o.push(`- Numbering of ${n.levelLabel}: ${n.examples.join(', ')}`);
    if (t.scope) o.push(`- Scope: ${t.scope}`);
    if (t.keyTerms.length) { o.push('', '### Key terms', ''); for (const k of t.keyTerms) o.push(`- ${k.term}${k.meaning ? `: ${k.meaning}` : ''}`); }
  }
  const q = r.requirements;
  o.push('', '## Requirements', '', `- ${plural(q.total, 'requirement')} and ${plural(q.notes, 'note')} in the draft now`,
    `- By level: ${q.byLevel.map((l) => `${l.count} ${l.level}`).join(', ') || 'none'}`,
    `- ${q.quotes.found} of ${q.quotes.total} quotes found in the source (${q.quotes.percent}%)`);
  if (q.orphans) o.push(`- ${plural(q.orphans, 'item')} without a parent`);
  if (q.keptYourEdits) o.push(`- ${plural(q.keptYourEdits, 'item')} you edited were kept as they were`);
  const list = (title2: string, items: ReportItem[]) => {
    if (!items.length) return;
    o.push('', `### ${title2}`, '');
    for (const i of items) o.push(`- ${i.code ?? ''}${where(i)}${i.why ? `: ${i.why}` : ''}${quoteLine(i.text)}`);
  };
  list('Quote not found in the source', q.quoteNotFound);
  list('Low confidence', q.lowConfidence);
  list('Suggested by the analysis (not confirmed in the source)', q.suggestedNotConfirmed);
  if (q.deleted.length) { o.push('', '### Deleted by you and not added back', ''); for (const d of q.deleted) o.push(`- ${d.kind} ${d.code}`); }

  const g = r.gaps;
  o.push('', '## Gaps and conflicts', '', `- Recovered: ${g.recovered.length}; confirmed absent: ${g.confirmedAbsent.length}; unresolved: ${g.unresolved.length}; conflicts: ${g.conflicts.length}; pages not covered: ${g.uncoveredPages.length}`);
  if (g.stopped) o.push(`- ${g.stopped}`);
  const gapList = (title2: string, items: ReportGap[]) => {
    if (!items.length) return;
    o.push('', `### ${title2}`, '');
    for (const i of items) {
      o.push(`- ${i.code ?? ''}${where(i)} ${GAP_KIND_WORDS[i.kind]}${i.reason ? `: ${i.reason}` : i.detail ? `: ${i.detail}` : ''}`);
      for (const v of i.variants) o.push(`  - ${v.documentTitle ?? 'source'}, page ${v.page}: ${v.text.replace(/\s+/g, ' ')}`);
    }
  };
  gapList('Unresolved', g.unresolved);
  gapList('Conflicts', g.conflicts);
  gapList('Confirmed absent', g.confirmedAbsent);
  gapList('Pages not covered', g.uncoveredPages);
  gapList('Recovered', g.recovered);

  const m = r.mapping;
  o.push('', '## Links to your quality framework', '');
  if (!m.ran) o.push(`- No links were suggested${m.skipped ? `: ${m.skipped}` : '.'}`);
  else {
    o.push(`- Candidates were found by ${m.retrieval}${m.embeddingsNote ? ` (${m.embeddingsNote})` : ''}`,
      `- Suggested links by relation: ${m.byRelation.covers} covers, ${m.byRelation.partly_covers} partly covers, ${m.byRelation.related} related`,
      `- ${plural(m.noSuggestion.length, 'requirement')} with no suggestion; ${plural(m.newItems.length, 'suggested new quality framework item')}`,
      `- Decided so far: links ${m.decisions.linksAccepted} accepted, ${m.decisions.linksDismissed} dismissed, ${m.decisions.linksWaiting} waiting; new items ${m.decisions.newItemsAccepted} accepted, ${m.decisions.newItemsDismissed} dismissed, ${m.decisions.newItemsWaiting} waiting`);
    for (const x of m.suggested) o.push(`- ${x.ref.code ?? ''}: ${x.links.map((l) => `${RELATION_WORDS[l.relation]} ${l.internalCode}`).join('; ')}`);
    for (const n of m.newItems) o.push(`- Suggested new item ${n.code} ${n.title} (${n.status})`);
  }
  const cf = r.configuration;
  o.push('', '## Configuration found', '');
  if (!cf.ran) o.push(`- Not read${cf.skipped ? `: ${cf.skipped}` : '.'}`);
  else {
    for (const d of cf.documents) o.push(`- ${d.title}: ${d.found.length ? d.found.join(', ') : 'nothing to take'}${d.note ? ` (${d.note})` : ''}`);
    if (cf.stopped) o.push(`- ${cf.stopped}`);
    for (const x of cf.sections) o.push(`- ${CONFIG_SECTION_LABEL[x.section]}: ${CONFIG_STATE_WORDS[x.state]}; ${x.written} written, ${x.flagged} flagged${x.editedSince ? '; edited by you since' : ''}`);
    if (cf.milestonesNeedingDueRule) o.push(`- ${plural(cf.milestonesNeedingDueRule, 'milestone')} still need a due rule set by a reviewer`);
    for (const n of cf.notFound) o.push(`- ${n}`);
    for (const d of cf.deletedByPerson) o.push(`- You deleted ${d}; it was not added back`);
    for (const i of cf.items.filter((x) => x.status !== 'flagged')) o.push(`- ${i.group} ${i.label}${i.detail ? ` (${i.detail})` : ''}${where({ documentTitle: i.documentTitle, page: i.page })}${i.dueText ? `; due as written: "${i.dueText}"` : ''}${i.reasons.length ? `; ${i.reasons.join('; ')}` : ''}`);
    if (cf.flagged.length) {
      o.push('', '### Kept out of the configuration', '');
      for (const i of cf.flagged) o.push(`- ${i.group} ${i.label}${where({ documentTitle: i.documentTitle, page: i.page })}: ${i.reasons.join('; ')}`);
    }
  }
  o.push('', '## Before you publish', '');
  if (!r.checklist.length && !r.validation.problems.length && !r.validation.warnings.length) o.push('- Nothing is flagged. Publishing is still your decision.');
  for (const c of r.checklist) o.push(`- ${c.label}`);
  for (const p of r.validation.problems) o.push(`- Problem to fix: ${p}`);
  for (const w of r.validation.warnings) o.push(`- To check: ${w}`);
  o.push('');
  return o.join('\n');
}
