// Read-only tools over FRAMEWORK content: standards, versions, requirements and their notes, source pages, mappings, analysis
// reports and the glossary. Each calls the existing core service with the person's ctx, so framework:read (or org:read for the
// glossary) is checked by the same code as the screens. NOTHING here touches evidence, datasets, responses, requests, forms or
// letters (a test scans this folder for those tables).
import { z } from 'zod';
import type { AssistantLink } from '@ams/shared';
import { getSourceDocument } from '../../framework/common.js';
import { listFrameworks, getVersionDetail } from '../../framework/versions.js';
import { getRequirementWithNotes, listRequirements } from '../../framework/requirements.js';
import { listSourceDocuments } from '../../framework/sources.js';
import { getSourcePageView } from '../../framework/source-view.js';
import { LexicalIndex } from '../../framework/analysis/shortlist.js';
import { getLatestAnalysisReport } from '../../framework/analysis/report.js';
import { listAnalysisRuns } from '../../framework/analysis/runs.js';
import { normalizeQuoteText } from '../../framework/quote-match.js';
import { getMappings } from '../../mapping/mapping.js';
import { listIqfProposals } from '../../mapping/proposals.js';
import { getGlossary } from '../../glossary/glossary.js';
import { clip, defineTool, plural } from './types.js';

const versionId = z.uuid().describe('The id of the version (from list_versions, or the screen context).');
const MAX_RESULTS = 25;

const reqLink = (r: { id: string; code: string; title: string }, vId: string): AssistantLink => ({
  kind: 'requirement', id: r.id, versionId: vId, code: r.code, label: clip(`${r.code} ${r.title}`, 80),
});
const srcLink = (documentId: string, vId: string, page: number, title: string): AssistantLink => ({
  kind: 'source', documentId, versionId: vId, page, label: clip(`${title}, page ${page}`, 80),
});

// ---- list_versions ---------------------------------------------------------------------------------------------------------
export const listVersionsTool = defineTool({
  name: 'list_versions', access: 'read',
  description: 'Lists the standards (accreditors\' frameworks) and their versions that the person can open, with each version\'s id, edition, status and counts. Start here when you need a version id.',
  input: z.object({}).strict(),
  describeArgs: () => 'all standards and versions',
  async execute(ctx) {
    const fws = await listFrameworks(ctx);
    const data = fws.slice(0, 60).map((f) => ({
      standardId: f.id, name: f.name, accreditor: f.accreditorShortName, scope: f.scope,
      versions: f.versions.map((v) => ({
        versionId: v.id, label: `${f.accreditorShortName} ${v.edition}`, edition: v.edition, status: v.status,
        requirements: v.requirementCount, assessable: v.assessableCount, engagements: v.engagementCount,
      })),
    }));
    const links: AssistantLink[] = fws.flatMap((f) => f.versions.map((v) => ({ kind: 'version' as const, id: v.id, label: `${f.accreditorShortName} ${v.edition}` }))).slice(0, 12);
    const n = fws.reduce((a, f) => a + f.versions.length, 0);
    return { data, summary: `Listed ${plural(fws.length, 'standard')} and ${plural(n, 'version')}`, links };
  },
});

// ---- get_version_summary ---------------------------------------------------------------------------------------------------
export const getVersionSummaryTool = defineTool({
  name: 'get_version_summary', access: 'read',
  description: 'One version at a glance: edition, status, level names, how many requirements at each level, its source documents (with ids and page counts) and its latest analysis run.',
  input: z.object({ versionId }).strict(),
  describeArgs: () => 'one version',
  async execute(ctx, args) {
    const v = await getVersionDetail(ctx, args.versionId);
    const reqs = await listRequirements(ctx, args.versionId);
    const sources = await listSourceDocuments(ctx, args.versionId);
    const runs = await listAnalysisRuns(ctx, args.versionId);
    const byLevel = new Map<string, number>();
    for (const r of reqs) byLevel.set(r.levelLabel, (byLevel.get(r.levelLabel) ?? 0) + 1);
    const latest = runs[0];
    const data = {
      versionId: v.id, edition: v.edition, status: v.status, internalQualityFramework: v.internal,
      levelNames: v.levelLabels, requirements: reqs.length, assessable: reqs.filter((r) => r.isAssessable).length,
      byLevel: [...byLevel].map(([level, count]) => ({ level, count })),
      sources: sources.map((s) => ({ documentId: s.id, title: s.title, role: s.role, language: s.language, pages: s.pageCount, textStatus: s.textStatus })),
      latestAnalysis: latest ? { runId: latest.id, status: latest.status, stage: latest.stage, finishedAt: latest.finishedAt?.toISOString() ?? null, error: latest.error } : null,
    };
    return {
      data, summary: `Read the summary of ${v.edition} (${plural(reqs.length, 'requirement')})`,
      links: [{ kind: 'version', id: v.id, label: `Version ${v.edition}` }],
    };
  },
});

// ---- count_requirements ---------------------------------------------------------------------------------------------------
export const countRequirementsTool = defineTool({
  name: 'count_requirements', access: 'read',
  description: 'Counts the requirements of a version, grouped by level (default), by whether they are assessable, by origin (manual, import, AI), by review status or by whether their source quote is verified. Optionally only those under one parent.',
  input: z.object({
    versionId,
    groupBy: z.enum(['level', 'assessable', 'origin', 'review_status', 'quote_verified']).default('level'),
    parentId: z.uuid().optional().describe('Count only the descendants of this requirement.'),
  }).strict(),
  describeArgs: (a) => `count by ${a.groupBy.replace('_', ' ')}`,
  async execute(ctx, args) {
    let rows = await listRequirements(ctx, args.versionId);
    if (args.parentId) {
      const keep = new Set<string>();
      const walk = (id: string) => { for (const r of rows) if (r.parentId === id && !keep.has(r.id)) { keep.add(r.id); walk(r.id); } };
      walk(args.parentId);
      rows = rows.filter((r) => keep.has(r.id));
    }
    const key = (r: (typeof rows)[number]): string => {
      switch (args.groupBy) {
        case 'level': return r.levelLabel;
        case 'assessable': return r.isAssessable ? 'assessable' : 'not assessable';
        case 'origin': return r.origin;
        case 'review_status': return r.reviewStatus;
        case 'quote_verified': return r.sourceQuote ? (r.quoteVerified ? 'quote verified' : 'quote not verified') : 'no quote';
      }
    };
    const groups = new Map<string, number>();
    for (const r of rows) groups.set(key(r), (groups.get(key(r)) ?? 0) + 1);
    const data = { total: rows.length, groupedBy: args.groupBy, groups: [...groups].map(([group, count]) => ({ group, count })) };
    return { data, summary: `Counted ${plural(rows.length, 'requirement')} by ${args.groupBy.replace('_', ' ')}`, links: [] };
  },
});

// ---- search_requirements --------------------------------------------------------------------------------------------------
export const searchRequirementsTool = defineTool({
  name: 'search_requirements', access: 'read',
  description: 'Finds requirements in one version by words (Arabic or English; spelling variants are matched), by code, by level name, or under a parent. Returns at most 25, best match first, each with its id, code, title, level and a short excerpt. Use get_requirement to read one in full.',
  input: z.object({
    versionId,
    query: z.string().trim().max(300).optional().describe('Words to look for in titles and wording.'),
    code: z.string().trim().max(60).optional().describe('A code or code prefix, for example "3.2".'),
    level: z.string().trim().max(80).optional().describe('A level name such as "Standard" or "Indicator" (see get_version_summary).'),
    parentId: z.uuid().optional().describe('Only the descendants of this requirement.'),
    assessableOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
  }).strict(),
  describeArgs: (a) => [a.query ? `“${clip(a.query, 40)}”` : null, a.code ? `code ${a.code}` : null, a.level ? `level ${a.level}` : null, a.parentId ? 'under one parent' : null].filter(Boolean).join(', ') || 'all requirements',
  async execute(ctx, args) {
    const all = await listRequirements(ctx, args.versionId);
    const byId = new Map(all.map((r) => [r.id, r]));
    let rows = all;
    if (args.parentId) {
      const keep = new Set<string>();
      const walk = (id: string) => { for (const r of all) if (r.parentId === id && !keep.has(r.id)) { keep.add(r.id); walk(r.id); } };
      walk(args.parentId);
      rows = rows.filter((r) => keep.has(r.id));
    }
    if (args.level) { const l = normalizeQuoteText(args.level); rows = rows.filter((r) => normalizeQuoteText(r.levelLabel) === l); }
    if (args.assessableOnly) rows = rows.filter((r) => r.isAssessable);
    if (args.code) {
      const c = normalizeQuoteText(args.code);
      rows = rows.filter((r) => { const rc = normalizeQuoteText(r.code); return rc === c || rc.startsWith(`${c}.`) || rc.startsWith(`${c}-`); });
    }
    const total = rows.length;
    let ordered = rows;
    if (args.query) {
      const path = (r: (typeof all)[number]) => { const out: string[] = []; for (let p = r.parentId ? byId.get(r.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) out.unshift(p.title); return out; };
      const index = new LexicalIndex(rows.map((r) => ({ id: r.id, code: r.code, title: r.title, text: r.officialText ?? '', path: path(r) })));
      const rank = new Map(index.rank({ title: args.query, text: '' }).map((s, i) => [s.id, i]));
      ordered = rows.filter((r) => rank.has(r.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    }
    const found = ordered.slice(0, args.limit);
    const data = {
      matches: args.query ? ordered.length : total, shown: found.length,
      requirements: found.map((r) => ({
        requirementId: r.id, code: r.code, title: clip(r.title, 160), level: r.levelLabel, depth: r.depth,
        parentCode: r.parentId ? byId.get(r.parentId)?.code ?? null : null, assessable: r.isAssessable, excerpt: clip(r.officialText, 240) || null,
      })),
    };
    return {
      data, summary: found.length ? `Found ${plural(args.query ? ordered.length : total, 'requirement')}${args.query ? ` about “${clip(args.query, 40)}”` : ''}` : 'Found no matching requirements',
      links: found.slice(0, 8).map((r) => reqLink(r, args.versionId)),
    };
  },
});

// ---- get_requirement ------------------------------------------------------------------------------------------------------
export const getRequirementTool = defineTool({
  name: 'get_requirement', access: 'read',
  description: 'Reads one requirement in full: code, title, level, official wording, its place in the tree, and its notes (type, authority, text) with the source document, page and quote each cites.',
  input: z.object({ requirementId: z.uuid() }).strict(),
  describeArgs: () => 'one requirement',
  async execute(ctx, args) {
    const { requirement: r, notes } = await getRequirementWithNotes(ctx, args.requirementId);
    const siblings = await listRequirements(ctx, r.frameworkVersionId);
    const byId = new Map(siblings.map((x) => [x.id, x]));
    const chain: { code: string; title: string }[] = [];
    for (let p = r.parentId ? byId.get(r.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) chain.unshift({ code: p.code, title: clip(p.title, 100) });
    const children = siblings.filter((x) => x.parentId === r.id);
    const docs = new Map((await listSourceDocuments(ctx, r.frameworkVersionId)).map((d) => [d.id, d.title]));
    const cite = (id: string | null, page: number | null, quote: string | null, verified: boolean) =>
      id && page ? { documentId: id, documentTitle: docs.get(id) ?? null, page, quote: clip(quote, 300) || null, quoteVerified: verified } : null;
    const data = {
      requirementId: r.id, versionId: r.frameworkVersionId, code: r.code, title: r.title, level: r.levelLabel, assessable: r.isAssessable, language: r.language,
      officialText: clip(r.officialText, 2500) || null, path: chain, children: children.slice(0, 15).map((c) => ({ requirementId: c.id, code: c.code, title: clip(c.title, 100) })), childCount: children.length,
      origin: r.origin, reviewStatus: r.reviewStatus,
      source: cite(r.sourceDocumentId, r.sourcePage, r.sourceQuote, r.quoteVerified),
      notes: notes.slice(0, 25).map((n) => ({
        type: n.type, authority: n.authority, text: clip(n.text, 800), reviewStatus: n.reviewStatus, source: cite(n.sourceDocumentId, n.sourcePage, n.sourceQuote, n.quoteVerified),
      })),
    };
    const links: AssistantLink[] = [reqLink(r, r.frameworkVersionId)];
    const seen = new Set<string>();
    const cites = [{ id: r.sourceDocumentId, page: r.sourcePage }, ...notes.map((n) => ({ id: n.sourceDocumentId, page: n.sourcePage }))];
    for (const c of cites) {
      if (!c.id || !c.page || seen.has(`${c.id}:${c.page}`) || links.length >= 6) continue;
      seen.add(`${c.id}:${c.page}`);
      links.push(srcLink(c.id, r.frameworkVersionId, c.page, docs.get(c.id) ?? 'Source'));
    }
    return { data, summary: `Read requirement ${r.code}`, links };
  },
});

// ---- read_source_page -----------------------------------------------------------------------------------------------------
const MAX_PAGE_CHARS = 6000;
export const readSourcePageTool = defineTool({
  name: 'read_source_page', access: 'read',
  description: 'Reads one stored page of a source document (the accreditor\'s own text), optionally marking where a quote sits on it. Use it to check what the source really says.',
  input: z.object({ documentId: z.uuid(), page: z.number().int().min(1), quote: z.string().trim().max(1000).optional() }).strict(),
  describeArgs: (a) => `source page ${a.page}`,
  async execute(ctx, args) {
    const view = await getSourcePageView(ctx, args.documentId, args.page, args.quote);
    const doc = await getSourceDocument(ctx, args.documentId);
    const text = view.page?.text ?? null;
    const data = {
      document: { documentId: view.document.id, title: view.document.title, role: view.document.role, language: view.document.language, pages: view.document.pageCount },
      page: args.page, textStored: !!view.page, needsOcr: view.page?.needsOcr ?? false,
      text: text ? text.slice(0, MAX_PAGE_CHARS) : null, textCut: !!text && text.length > MAX_PAGE_CHARS,
      quoteFound: view.quoteGiven ? view.highlight !== null : null,
      quoteFoundOnPage: view.quoteGiven && !view.highlight ? view.quoteFoundOnPage : null,
      quoteSpan: view.highlight && text ? text.slice(view.highlight.start, view.highlight.end) : null,
    };
    return {
      data, summary: `Read page ${args.page} of “${clip(view.document.title, 50)}”`,
      links: view.page ? [srcLink(view.document.id, doc.frameworkVersionId, args.page, view.document.title)] : [],
    };
  },
});

// ---- get_analysis_report_summary -----------------------------------------------------------------------------------------
export const getAnalysisReportSummaryTool = defineTool({
  name: 'get_analysis_report_summary', access: 'read',
  description: 'The latest finished analysis report of a version, in brief: what was read, how many requirements and notes were found, how many quotes were found in the sources, the gaps still open, the suggested links, and the checklist of what to look at before publishing. Counts only; no verdicts.',
  input: z.object({ versionId }).strict(),
  describeArgs: () => 'latest analysis report',
  async execute(ctx, args) {
    const r = await getLatestAnalysisReport(ctx, args.versionId);
    if (!r) return { data: { report: null, note: 'This version has no finished analysis run yet.' }, summary: 'No analysis report yet', links: [] };
    const data = {
      runId: r.runId, status: r.summary.status, finishedAt: r.summary.finishedAt, error: r.summary.error,
      sources: r.summary.sources.map((s) => ({ documentId: s.documentId, title: s.title, pages: s.pages, unreadablePages: s.pagesUnreadable, warnings: s.warnings.slice(0, 3) })),
      requirements: { total: r.requirements.total, notes: r.requirements.notes, byLevel: r.requirements.byLevel, quotesFound: r.requirements.quotes.found, quotesTotal: r.requirements.quotes.total, quoteNotFound: r.requirements.quoteNotFound.length, orphans: r.requirements.orphans },
      gaps: { recovered: r.gaps.recovered.length, confirmedAbsent: r.gaps.confirmedAbsent.length, unresolved: r.gaps.unresolved.length, conflicts: r.gaps.conflicts.length, stopped: r.gaps.stopped },
      unresolvedGaps: r.gaps.unresolved.slice(0, 10).map((g) => ({ code: g.code, title: clip(g.title, 100), kind: g.kind, detail: clip(g.detail, 160), documentTitle: g.documentTitle, page: g.page })),
      mapping: { ran: r.mapping.ran, byRelation: r.mapping.byRelation, decisions: r.mapping.decisions, newItemsSuggested: r.mapping.newItems.length },
      checklist: r.checklist.map((c) => ({ label: c.label, count: c.count, level: c.level })),
      validation: { problems: r.validation.problems.slice(0, 10), warnings: r.validation.warnings.slice(0, 10) },
    };
    return { data, summary: 'Read the latest analysis report', links: [{ kind: 'version', id: args.versionId, label: 'Report tab' }] };
  },
});

// ---- list_mappings ---------------------------------------------------------------------------------------------------------
export const listMappingsTool = defineTool({
  name: 'list_mappings', access: 'read',
  description: 'For an external standard\'s version: the links to the institution\'s own quality framework (relation, review status, rationale) and the new quality-framework items the analysis suggested. Not for the quality framework itself.',
  input: z.object({ versionId, limit: z.number().int().min(1).max(MAX_RESULTS).default(15), reviewStatus: z.enum(['pending', 'approved', 'rejected']).optional() }).strict(),
  describeArgs: () => 'links to the quality framework',
  async execute(ctx, args) {
    const m = await getMappings(ctx, args.versionId);
    const suggestions = await listIqfProposals(ctx, args.versionId);
    const rows = args.reviewStatus ? m.mappings.filter((x) => x.reviewStatus === args.reviewStatus) : m.mappings;
    const byRelation: Record<string, number> = {};
    for (const x of m.mappings) byRelation[x.relation] = (byRelation[x.relation] ?? 0) + 1;
    const data = {
      total: m.mappings.length, byRelation, shown: Math.min(rows.length, args.limit),
      mappings: rows.slice(0, args.limit).map((x) => ({
        externalCode: x.externalCode, externalRequirementId: x.externalRequirementId, internalCode: x.internalCode, internalTitle: clip(x.internalTitle, 100),
        relation: x.relation, reviewStatus: x.reviewStatus, origin: x.origin, rationale: clip(x.rationale, 240) || null, stale: x.stale,
      })),
      suggestedNewItems: suggestions.proposals.filter((p) => p.status === 'pending').slice(0, 10).map((p) => ({ code: p.code, title: clip(p.title, 100), reason: clip(p.reason, 200) })),
      suggestedNewItemCount: suggestions.proposals.length,
    };
    const links: AssistantLink[] = rows.slice(0, 6).flatMap((x) => (x.externalRequirementId ? [reqLink({ id: x.externalRequirementId, code: x.externalCode, title: '' }, args.versionId)] : []));
    return { data, summary: `Listed ${plural(m.mappings.length, 'link')} to the quality framework`, links };
  },
});

// ---- get_glossary_term ---------------------------------------------------------------------------------------------------
export const getGlossaryTermTool = defineTool({
  name: 'get_glossary_term', access: 'read',
  description: 'Looks up a term in the institution\'s glossary (level names, finding names, report types) in English or Arabic, with its definition and the words each standard uses for it.',
  input: z.object({ term: z.string().trim().min(1).max(100) }).strict(),
  describeArgs: (a) => `“${clip(a.term, 40)}”`,
  async execute(ctx, args) {
    const g = await getGlossary(ctx);
    const q = normalizeQuoteText(args.term);
    const hits = g.terms.filter((t) => [t.key.replace(/_/g, ' '), t.labelEn, t.labelAr ?? '', t.definitionEn ?? '', t.definitionAr ?? ''].some((s) => s && normalizeQuoteText(s).includes(q))).slice(0, 5);
    const data = {
      terms: hits.map((t) => ({
        term: t.labelEn, termAr: t.labelAr, kind: t.kind, definition: clip(t.definitionEn, 400) || null, definitionAr: clip(t.definitionAr, 400) || null,
        standardsUse: g.aliases.filter((a) => a.termId === t.id).slice(0, 10).map((a) => a.externalTerm),
      })),
    };
    return { data, summary: hits.length ? `Looked up “${clip(args.term, 40)}” in the glossary` : `No glossary term for “${clip(args.term, 40)}”`, links: [] };
  },
});

export const FRAMEWORK_TOOLS = [
  listVersionsTool, getVersionSummaryTool, countRequirementsTool, searchRequirementsTool, getRequirementTool, readSourcePageTool,
  getAnalysisReportSummaryTool, listMappingsTool, getGlossaryTermTool,
];
