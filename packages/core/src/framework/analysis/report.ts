// The intelligence report of an analysis run (PRD 15, step F1). Built on demand from what is stored: the run's own record
// (usage, progress, what the stages reported) and the live state of the draft, so it follows a person's later edits. It
// never calls a model. Wording rules (DEC-005): counts of what was found and checked; no score, no verdict, no embedding
// similarity numbers. Every item carries ids and pages so the screen can link to the card, the source page or Mappings.
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { analysisDismissal, analysisRun, appUser, iqfItemProposal, requirement, requirementMapping, requirementNote, sourceDocument, sourcePage } from '@ams/db';
import {
  ACTIVE_ANALYSIS_STATUSES, ANALYSIS_REPORT_VERSION,
  type AnalysisGap, type AnalysisMapping, type AnalysisReport, type AnalysisRuntimeInfo, type AnalysisStats, type AnalysisUsage, type ReportCheck, type ReportGap, type ReportItem, type ReportRef,
} from '@ams/shared';
import type { Ctx } from '../../ctx.js';
import { getVersion, require_ } from '../common.js';
import { validateVersion } from '../versions.js';
import { loadIqf, naturalCompare } from './iqf-context.js';
import { LOW_CONFIDENCE, noteFingerprint, normalizeCode } from './merge.js';
import { getAnalysisRunRow } from './runs.js';
import { loadRawItems } from './write.js';
import type { Structure } from './schemas.js';

const clip = (s: string | null | undefined, n = 400) => {
  const t = (s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  return t ? (t.length > n ? `${t.slice(0, n)}…` : t) : null;
};
const plural = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;

const STOP_WORDS: Record<string, string> = {
  budget: 'Recovery stopped at the spend limit.',
  max_rounds: 'Recovery used all the rounds allowed in Settings.',
  nothing_new: 'Recovery stopped because the last round found nothing new.',
};

interface StoredReport {
  survey?: Record<string, { language?: string; confidence?: number | null }>;
  structure?: Structure & { levelLabelsApplied: string[] | null };
  readErrors?: Record<string, string>;
  stats?: AnalysisStats;
  gaps?: AnalysisGap[];
  recovery?: { stopped?: string | null; rounds?: unknown[] };
  mapping?: AnalysisMapping;
  runtime?: AnalysisRuntimeInfo;
}

const cmp = (a: ReportRef, b: ReportRef) => naturalCompare(a.code ?? '', b.code ?? '') || (a.page ?? 0) - (b.page ?? 0);

/** The report of one run. Needs framework:read. */
export async function getAnalysisReport(ctx: Ctx, runId: string): Promise<AnalysisReport> {
  await require_(ctx, 'framework:read');
  const run = await getAnalysisRunRow(ctx, runId);
  const version = await getVersion(ctx, run.frameworkVersionId);
  const stored = (run.report ?? {}) as StoredReport;
  const usage = run.usage as AnalysisUsage;

  // ---- sources
  const docs = await ctx.tx.select().from(sourceDocument).where(eq(sourceDocument.frameworkVersionId, version.id));
  docs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.title.localeCompare(b.title));
  const docTitle = new Map(docs.map((d) => [d.id, d.title]));
  const pageRows = docs.length
    ? await ctx.tx.select({ d: sourcePage.sourceDocumentId, method: sourcePage.method, needsOcr: sourcePage.needsOcr }).from(sourcePage).where(inArray(sourcePage.sourceDocumentId, docs.map((d) => d.id)))
    : [];
  const sources = docs.map((d) => {
    const mine = pageRows.filter((p) => p.d === d.id);
    const unreadable = mine.filter((p) => p.needsOcr).length;
    const ocr = mine.filter((p) => !p.needsOcr && p.method === 'ocr').length;
    const warnings: string[] = [];
    const readError = stored.readErrors?.[d.id];
    if (readError) warnings.push(readError);
    if (d.textStatus === 'failed' && !readError) warnings.push('The file could not be read.');
    if (unreadable > 0) warnings.push(`${plural(unreadable, 'page')} had no readable text and ${unreadable === 1 ? 'was' : 'were'} not read by AI vision.`);
    return {
      documentId: d.id, title: d.title, role: d.role,
      roleDecidedBy: d.roleOrigin === 'manual' ? 'person' as const : d.roleOrigin === 'ai' ? 'analysis' as const : 'unset' as const,
      language: stored.survey?.[d.id]?.language ?? d.language,
      pages: mine.length, pagesNative: mine.length - unreadable - ocr, pagesOcr: ocr, pagesUnreadable: unreadable, warnings,
    };
  });

  // ---- the draft as it is now
  const reqs = await ctx.tx.select().from(requirement).where(eq(requirement.frameworkVersionId, version.id));
  const reqByCode = new Map(reqs.map((r) => [normalizeCode(r.code), r]));
  const notes = reqs.length ? await ctx.tx.select().from(requirementNote).where(inArray(requirementNote.requirementId, reqs.map((r) => r.id))) : [];
  const reqById = new Map(reqs.map((r) => [r.id, r]));
  const refOf = (code: string | null, documentId: string | null, page: number | null): ReportRef => {
    const r = code ? reqByCode.get(normalizeCode(code)) : undefined;
    return { code: code ?? null, title: r?.title ?? null, requirementId: r?.id ?? null, documentId, documentTitle: documentId ? docTitle.get(documentId) ?? null : null, page };
  };

  const labels = ((version.levelLabels as string[] | undefined) ?? []).filter(Boolean);
  const counts = new Map<string, number>();
  for (const r of reqs) counts.set(r.levelLabel, (counts.get(r.levelLabel) ?? 0) + 1);
  const byLevel = [...counts.entries()].map(([level, count]) => ({ level, count }))
    .sort((a, b) => (labels.indexOf(a.level) + 1 || 999) - (labels.indexOf(b.level) + 1 || 999) || a.level.localeCompare(b.level));

  const quoted = [...reqs.filter((r) => r.sourceQuote), ...notes.filter((n) => n.sourceQuote)];
  const found = quoted.filter((r) => r.quoteVerified).length;
  const reqItem = (r: typeof reqs[number], why: string): ReportItem => ({ kind: 'requirement', ...refOf(r.code, r.sourceDocumentId, r.sourcePage), text: clip(r.officialText ?? r.title), why });
  const noteItem = (n: typeof notes[number], why: string): ReportItem => {
    const r = reqById.get(n.requirementId);
    return { kind: 'note', ...refOf(r?.code ?? null, n.sourceDocumentId, n.sourcePage), text: clip(n.text), why };
  };
  const quoteNotFound = [
    ...reqs.filter((r) => r.sourceQuote && !r.quoteVerified).map((r) => reqItem(r, 'its quote was not found on the cited page')),
    ...notes.filter((n) => n.sourceQuote && !n.quoteVerified).map((n) => noteItem(n, 'the quote of this note was not found on the cited page')),
  ].sort(cmp);
  const suggestedNotConfirmed = notes.filter((n) => n.authority === 'ai_suggested').map((n) => noteItem(n, 'suggested by the analysis; the source does not confirm it')).sort(cmp);

  // Low confidence: from what the run logged (the draft rows do not keep it).
  const lowConfidence: ReportItem[] = [];
  const seenLow = new Set<string>();
  for (const raw of await loadRawItems(ctx, run.id)) {
    const c = raw.item.confidence;
    if (c === null || c === undefined || c >= LOW_CONFIDENCE) continue;
    const code = raw.item.kind === 'note' ? raw.item.parent_code ?? raw.item.code ?? null : raw.item.code ?? null;
    const key = `${raw.item.kind}|${normalizeCode(code ?? '')}|${raw.item.text.slice(0, 60)}`;
    if (!code || seenLow.has(key) || !reqByCode.has(normalizeCode(code))) continue;
    seenLow.add(key);
    lowConfidence.push({ kind: raw.item.kind, ...refOf(code, raw.documentId, raw.item.source.page), text: clip(raw.item.text), why: 'the analysis was not sure about this one' });
  }
  lowConfidence.sort(cmp);

  // Deleted by a person and not added back.
  const deleted: AnalysisReport['requirements']['deleted'] = [];
  const noteKeys = new Set(notes.map((n) => `${normalizeCode(reqById.get(n.requirementId)?.code ?? '')}\u0000${noteFingerprint(n.text)}`));
  for (const d of await ctx.tx.select().from(analysisDismissal).where(eq(analysisDismissal.frameworkVersionId, version.id))) {
    const code = normalizeCode(d.code);
    if (d.kind === 'requirement' && !reqByCode.has(code)) deleted.push({ kind: 'requirement', code: d.code });
    if (d.kind === 'note' && !noteKeys.has(`${code}\u0000${noteFingerprint(d.noteText ?? '')}`)) deleted.push({ kind: 'note', code: d.code });
  }
  deleted.sort((a, b) => naturalCompare(a.code, b.code));

  const stats = stored.stats;

  // ---- gaps (step D)
  const toGap = (g: AnalysisGap): ReportGap => {
    const live = g.code ? reqByCode.get(normalizeCode(g.code)) : undefined;
    return {
      key: g.key, kind: g.kind, status: g.status, ...refOf(g.code, g.documentId, g.page),
      requirementId: live?.id ?? null, detail: g.detail, reason: g.reason, attempts: g.attempts,
      variants: (g.variants ?? []).map((v) => ({ documentId: v.documentId, documentTitle: docTitle.get(v.documentId) ?? null, page: v.page, text: v.text })),
    };
  };
  // A gap about a requirement or note that a person has since deleted is no longer a gap of this draft.
  const allGaps = (stored.gaps ?? [])
    .filter((g) => !((g.kind === 'unverified_quote' || g.kind === 'low_confidence') && g.code && !reqByCode.has(normalizeCode(g.code))))
    .map(toGap);
  const gapsOf = (...s: ReportGap['status'][]) => allGaps.filter((g) => s.includes(g.status)).sort(cmp);
  const stopKey = stored.recovery?.stopped ?? null;

  // ---- IQF mapping (step E)
  const m = stored.mapping;
  const ran = !!m && !m.skipped;
  const suggested: AnalysisReport['mapping']['suggested'] = [];
  const noSuggestion: ReportRef[] = [];
  const decisions = { linksWaiting: 0, linksAccepted: 0, linksDismissed: 0, newItemsWaiting: 0, newItemsAccepted: 0, newItemsDismissed: 0 };
  const byRelation = { covers: 0, partly_covers: 0, related: 0 };
  let newItems: AnalysisReport['mapping']['newItems'] = [];
  if (ran) {
    const judged = (m!.judgedCodes ?? []).map(normalizeCode);
    const rows = judged.length ? await ctx.tx.select().from(requirementMapping).where(and(eq(requirementMapping.frameworkId, version.frameworkId), inArray(requirementMapping.externalCode, m!.judgedCodes))) : [];
    const iqf = await loadIqf(ctx);
    const iqfTitle = new Map((iqf?.items ?? []).map((i) => [normalizeCode(i.code), i.title]));
    const ai = rows.filter((x) => x.origin === 'ai');
    const grouped = new Map<string, typeof ai>();
    for (const x of ai) grouped.set(x.externalCode, [...(grouped.get(x.externalCode) ?? []), x]);
    for (const [code, list] of grouped) {
      if (!reqByCode.has(normalizeCode(code))) continue;
      suggested.push({
        ref: refOf(code, null, null),
        links: list.sort((a, b) => naturalCompare(a.internalCode, b.internalCode)).map((x) => ({
          internalCode: x.internalCode, internalTitle: iqfTitle.get(normalizeCode(x.internalCode)) ?? null, relation: x.relation, rationale: clip(x.rationale, 500), reviewStatus: x.reviewStatus,
        })),
      });
      for (const x of list) {
        byRelation[x.relation]++;
        if (x.reviewStatus === 'pending') decisions.linksWaiting++;
        else if (x.reviewStatus === 'approved') decisions.linksAccepted++;
        else decisions.linksDismissed++;
      }
    }
    suggested.sort((a, b) => cmp(a.ref, b.ref));
    const withRows = new Set(rows.map((x) => normalizeCode(x.externalCode)));
    for (const code of m!.noSuggestionCodes ?? []) {
      if (withRows.has(normalizeCode(code)) || !reqByCode.has(normalizeCode(code))) continue;
      noSuggestion.push(refOf(code, null, null));
    }
    noSuggestion.sort(cmp);
    const proposals = await ctx.tx.select().from(iqfItemProposal).where(eq(iqfItemProposal.analysisRunId, run.id));
    newItems = proposals.map((p) => ({
      proposalId: p.id, status: p.status, code: p.code, title: p.title, parentCode: p.parentCode, reason: clip(p.reason, 500),
      covers: p.links.map((l) => ({ externalCode: l.externalCode, requirementId: reqByCode.get(normalizeCode(l.externalCode))?.id ?? null, relation: l.relation })),
    })).sort((a, b) => naturalCompare(a.code, b.code));
    for (const p of proposals) {
      if (p.status === 'pending') decisions.newItemsWaiting++;
      else if (p.status === 'accepted') decisions.newItemsAccepted++;
      else if (p.status === 'dismissed') decisions.newItemsDismissed++;
    }
  }

  // ---- validation (reused from validateVersion)
  const validation = await validateVersion(ctx, version.id);
  const problems = validation.ok ? [] : validation.issues.map((i) => i.message);
  const warnings = (validation.warnings ?? []).map((i) => i.message);

  // ---- the checklist
  const checklist: ReportCheck[] = [];
  const reqLink = (first: ReportRef | undefined): ReportCheck['link'] => ({ tab: 'requirements', section: null, requirementId: first?.requirementId ?? null, documentId: first?.documentId ?? null, page: first?.page ?? null });
  const add = (id: string, count: number, label: string, level: ReportCheck['level'], link: ReportCheck['link']) => { if (count > 0) checklist.push({ id, label, count, level, link }); };
  const unresolved = gapsOf('open', 'unresolved').filter((g) => g.kind !== 'uncovered_page');
  const conflicts = gapsOf('conflict');
  const uncovered = allGaps.filter((g) => g.kind === 'uncovered_page' && g.status !== 'recovered' && g.status !== 'confirmed_absent').sort(cmp);
  add('quote_not_found', quoteNotFound.length, `${plural(quoteNotFound.length, 'requirement or note', 'requirements or notes')} whose quote was not found in the source`, 'look', reqLink(quoteNotFound[0]));
  add('unresolved_gaps', unresolved.length, `${plural(unresolved.length, 'gap')} the analysis could not resolve`, 'look', reqLink(unresolved[0]));
  add('conflicts', conflicts.length, `${plural(conflicts.length, 'conflict')}: the same code is worded differently in the sources`, 'look', reqLink(conflicts[0]));
  add('uncovered_pages', uncovered.length, `${plural(uncovered.length, 'source page')} with text that no requirement or note cites`, 'look',
    uncovered[0] ? { tab: 'settings', section: 'sources', requirementId: null, documentId: uncovered[0].documentId, page: uncovered[0].page } : null);
  add('low_confidence', lowConfidence.length, `${plural(lowConfidence.length, 'item')} the analysis was not sure about`, 'look', reqLink(lowConfidence[0]));
  add('suggested_notes', suggestedNotConfirmed.length, `${plural(suggestedNotConfirmed.length, 'note')} suggested by the analysis and not confirmed in the source`, 'look', reqLink(suggestedNotConfirmed[0]));
  const toMappings: ReportCheck['link'] = { tab: 'mappings', section: null, requirementId: null, documentId: null, page: null };
  add('links_waiting', decisions.linksWaiting, `${plural(decisions.linksWaiting, 'suggested link')} to your quality framework waiting for a decision`, 'look', toMappings);
  add('new_items_waiting', decisions.newItemsWaiting, `${plural(decisions.newItemsWaiting, 'suggested new quality framework item')} waiting for a decision`, 'look', toMappings);
  add('no_suggestion', noSuggestion.length, `${plural(noSuggestion.length, 'requirement')} with no suggested link`, 'info', toMappings);
  add('validation_problems', problems.length, `${plural(problems.length, 'problem')} to fix before this version can be published`, 'look', { tab: 'settings', section: 'details', requirementId: null, documentId: null, page: null });
  add('validation_warnings', warnings.length, `${plural(warnings.length, 'thing')} to check before publishing (not blocking)`, 'info', reqLink(undefined));
  if (run.status === 'failed' || run.status === 'cancelled') {
    checklist.unshift({ id: 'run_stopped', label: `This analysis ${run.status === 'failed' ? 'stopped before it finished' : 'was cancelled'}${run.error ? `: ${run.error}` : ''}. What it wrote so far is in the draft.`, count: 1, level: 'look', link: null });
  }

  // ---- who and when
  let startedBy: AnalysisReport['summary']['startedBy'] = null;
  if (run.startedBy) {
    const [u] = await ctx.tx.select({ id: appUser.id, name: appUser.fullName }).from(appUser).where(eq(appUser.id, run.startedBy));
    startedBy = u ? { id: u.id, name: u.name } : null;
  }
  const startedAt = run.startedAt ?? run.createdAt;
  const durationSeconds = run.finishedAt ? Math.max(0, Math.round((run.finishedAt.getTime() - startedAt.getTime()) / 1000)) : null;
  const rt = stored.runtime;
  const hybrid = ran && m!.retrieval === 'hybrid';
  const s = stored.structure;

  return {
    reportVersion: ANALYSIS_REPORT_VERSION,
    runId: run.id,
    versionId: version.id,
    generatedAt: new Date().toISOString(),
    summary: {
      status: run.status, stage: run.stage, error: run.error, startedBy,
      startedAt: startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null, durationSeconds, sources,
      used: {
        analysisModel: rt?.analysisModel ?? run.model ?? null,
        visionModel: rt?.visionModel ?? null,
        embeddings: { used: hybrid, model: hybrid ? rt?.embeddingModel ?? null : null, note: m?.embeddings?.note ?? null },
        inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, costUsd: usage.costUsd ?? null, calls: usage.calls ?? 0,
        recoveryRounds: stats?.recoveryRounds ?? (stored.recovery?.rounds?.length ?? 0),
        promptVersions: run.promptVersions ?? {},
      },
    },
    structure: s ? {
      levelLabelsProposed: s.level_labels, levelLabelsWritten: s.levelLabelsApplied ?? null, levelLabelsNow: labels,
      numbering: (s.numbering ?? []).map((n) => ({ levelLabel: n.level_label, examples: n.examples })),
      keyTerms: (s.key_terms ?? []).map((k) => ({ term: k.term, meaning: k.meaning ?? null })),
      scope: s.scope?.trim() || null,
    } : null,
    requirements: {
      total: reqs.length, notes: notes.length, byLevel,
      quotes: { found, total: quoted.length, percent: quoted.length ? Math.round((found / quoted.length) * 100) : 0 },
      quoteNotFound, lowConfidence, suggestedNotConfirmed, orphans: stats?.orphans ?? 0, deleted, keptYourEdits: stats?.keptHumanEdits ?? 0,
      atRun: stats ? { requirements: stats.requirements, notes: stats.notes, quotesFound: stats.quoteVerified, quotesTotal: stats.requirements + stats.notes } : null,
    },
    gaps: {
      recovered: gapsOf('recovered'), confirmedAbsent: gapsOf('confirmed_absent'), unresolved, conflicts, uncoveredPages: uncovered,
      rounds: stats?.recoveryRounds ?? (stored.recovery?.rounds?.length ?? 0), stopped: stopKey ? STOP_WORDS[stopKey] ?? null : null,
    },
    mapping: {
      ran, skipped: m?.skipped ?? null, retrieval: hybrid ? 'words and meaning' : 'words only', embeddingsNote: m?.embeddings?.note ?? null,
      requirementsConsidered: m?.requirements ?? 0, suggested, byRelation, noSuggestion, newItems, decisions,
      stopped: m?.stopped === 'budget' ? 'Linking stopped at the spend limit; the suggestions so far are kept.' : null,
    },
    checklist,
    validation: { problems, warnings },
  };
}

/** The report of the version's latest finished run (succeeded, stopped or cancelled), or null when it has had none. */
export async function getLatestAnalysisReport(ctx: Ctx, versionId: string): Promise<AnalysisReport | null> {
  await require_(ctx, 'framework:read');
  await getVersion(ctx, versionId);
  const [row] = await ctx.tx.select({ id: analysisRun.id }).from(analysisRun)
    .where(and(eq(analysisRun.frameworkVersionId, versionId), notInArray(analysisRun.status, [...ACTIVE_ANALYSIS_STATUSES])))
    .orderBy(desc(analysisRun.createdAt)).limit(1);
  return row ? getAnalysisReport(ctx, row.id) : null;
}
