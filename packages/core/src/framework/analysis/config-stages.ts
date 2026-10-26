// The configuration stages of the `analyse` job (step H; PRD 15.1 step 4; DEC-006, DEC-022), run after `write` and before the
// IQF mapping, only when the version has a policy and procedure, report template or guidance document:
//
//   config_survey   one document per job (cursor = its index): one aiExtract (config_survey.v1) says which of lifecycle,
//                   vocabularies and report template the document holds, and on which pages. The last job plans the windows.
//   config_extract  one window of ~8 pages (1 page overlap) of one document and one target per job: lifecycle.v1, vocab.v1
//                   or template.v1. Items are logged in extraction_item (Appendix B kinds), page and quote on each.
//   config_write    one job, no model call: quotes verified against the pages, windows merged, the result built with the
//                   configuration schemas (config-merge.ts) and written into the DRAFT version as proposals. Human edits win.
//
// Why here: the requirements are written first (their codes and levels are settled), and the IQF mapping, which is the most
// expensive part and the one a spend limit should cut, comes last. Same rules as the other stages: each step is its own
// transaction, the cursor makes a retried job harmless, the run's budget covers every call, and the spend limit ends THIS part
// of the run (the items found so far are still checked and written), not the run.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { extractionItem, frameworkVersion, reportTemplate, sourceDocument, sourcePage, type analysisRun } from '@ams/db';
import {
  CONFIG_SECTIONS, CONFIG_TARGETS,
  type AnalysisConfig, type AnalysisProgress, type AnalysisStage, type AnalysisStats, type ConfigItemGroup, type ConfigItemResult, type ConfigResult, type ConfigSection, type ConfigSurveyEntry, type ConfigTarget,
} from '@ams/shared';
import type { Ctx } from '../../ctx.js';
import { aiExtract, type AiRuntime } from '../../ai/index.js';
import { getVersion, isInternalVersion } from '../common.js';
import {
  CONFIG_ITEM_KIND, CONFIG_LOG_KINDS, CONFIG_PROMPTS, CONFIG_ROLES, ConfigSurveySchema, LifecycleExtractSchema, LifecycleItemSchema, TemplateExtractSchema, TemplateItemSchema, VocabExtractSchema, VocabItemSchema,
} from './config-schemas.js';
import { buildConfig, type ConfigBuild, type ConfigDoc, type ConfigRef, type RawConfigItem, type TemplateHint } from './config-merge.js';
import { formatPages, pageWindows } from './merge.js';
import { loadPageTexts } from './write.js';

type Run = typeof analysisRun.$inferSelect;
type Reports = { [k: string]: unknown };
export interface ConfigStep {
  next: { stage: AnalysisStage; cursor: number };
  progress?: Partial<AnalysisProgress>;
  report?: { config: AnalysisConfig; stats?: AnalysisStats };
}
type ConfigStageFn = (ctx: Ctx, run: Run, cursor: number, runtime: AiRuntime, report: Reports) => Promise<ConfigStep>;

/** Window size and overlap (PRD 15.1), as for the requirements. */
const WINDOW_PAGES = 8;
const WINDOW_OVERLAP = 1;
/** What the survey is shown of a document: the first pages, and the start of each. */
export const CONFIG_SURVEY_PAGES = 150;
const CONFIG_SURVEY_CHARS = 400;
const WRITE = { stage: 'config_write', cursor: 0 } as const satisfies { stage: AnalysisStage; cursor: number };
const EMBED = { stage: 'embed', cursor: 0 } as const satisfies { stage: AnalysisStage; cursor: number };
/** The wording stage (TASK-107): only the internal framework reads it; an external version has nothing for it. */
const WORDING = { stage: 'wording', cursor: 0 } as const satisfies { stage: AnalysisStage; cursor: number };
/** Where the configuration hands on to: the internal framework goes on to the wording stage, an external one to the mapping. */
const afterConfig = async (ctx: Ctx, versionId: string) => ((await isInternalVersion(ctx, versionId)) ? WORDING : EMBED);

export const CONFIG_STAGES: readonly AnalysisStage[] = ['config_survey', 'config_extract', 'config_write'];
export const isConfigStage = (stage: string): boolean => (CONFIG_STAGES as readonly string[]).includes(stage);

export const NO_CONFIG_DOCS = 'This version has no policy and procedure, report template or guidance document, so there was nothing to read for the lifecycle, vocabularies or report templates.';

const emptyConfig = (over: Partial<AnalysisConfig> = {}): AnalysisConfig => ({ skipped: null, survey: [], windows: [], stopped: null, result: null, ...over });
const configOf = (report: Reports): AnalysisConfig => (report.config as AnalysisConfig | undefined) ?? emptyConfig();

/** The step that leaves the configuration stages out and says so (called by `write` when there is nothing to read). */
export const skipConfig = (ctx: Ctx, versionId: string): Promise<ConfigStep> =>
  afterConfig(ctx, versionId).then((next) => ({ next, report: { config: emptyConfig({ skipped: NO_CONFIG_DOCS }) } }));

/** The spend limit ends the configuration reading, not the run: what was found so far is still checked and written. */
export function configBudgetStop(report: Reports): ConfigStep {
  return { next: WRITE, report: { config: { ...configOf(report), windows: configOf(report).windows, stopped: 'budget' } } };
}

// ---- The documents --------------------------------------------------------------------------------------------------

/** The version's documents that can supply configuration, in a fixed order, with their page counts. */
export async function configCandidates(ctx: Ctx, versionId: string) {
  const rows = await ctx.tx.select({
    id: sourceDocument.id, title: sourceDocument.title, role: sourceDocument.role, language: sourceDocument.language,
    pages: sql<number>`(select count(*)::int from source_page p where p.source_document_id = source_document.id)`,
  }).from(sourceDocument).where(eq(sourceDocument.frameworkVersionId, versionId))
    .orderBy(asc(sourceDocument.createdAt), asc(sourceDocument.title), asc(sourceDocument.id));
  return rows.filter((d) => CONFIG_ROLES.has(d.role) && d.pages > 0);
}

const pagesOf = (ctx: Ctx, documentId: string, only?: number[]) =>
  ctx.tx.select({ pageNo: sourcePage.pageNo, text: sourcePage.text }).from(sourcePage)
    .where(and(eq(sourcePage.sourceDocumentId, documentId), only ? inArray(sourcePage.pageNo, only) : undefined)).orderBy(asc(sourcePage.pageNo));

// ---- config_survey --------------------------------------------------------------------------------------------------

const configSurvey: ConfigStageFn = async (ctx, run, cursor, runtime, report) => {
  const cfg = configOf(report);
  const docs = await configCandidates(ctx, run.frameworkVersionId);
  const d = docs[cursor];
  const progress = { configDocsTotal: docs.length, configDocsDone: Math.min(cursor + 1, docs.length) };
  if (!d) return { next: WRITE, progress, report: { config: cfg } };

  const stored = await pagesOf(ctx, d.id);
  const have = new Set(stored.map((p) => p.pageNo));
  const outline = ((report.survey as Record<string, { outline?: { heading: string; page?: number | null }[]; language?: string }> | undefined)?.[d.id]?.outline ?? [])
    .map((o) => `    ${o.heading}${o.page ? ` (page ${o.page})` : ''}`);
  const language = (report.survey as Record<string, { language?: string }> | undefined)?.[d.id]?.language ?? d.language;
  const input = [
    `Document: ${d.title}`, `Role: ${d.role}`, `Language: ${language}`,
    `Pages: ${d.pages}${d.pages > CONFIG_SURVEY_PAGES ? ` (the first ${CONFIG_SURVEY_PAGES} are shown)` : ''}`,
    ...(outline.length ? ['Outline:', ...outline] : []), '',
    formatPages(stored.slice(0, CONFIG_SURVEY_PAGES), CONFIG_SURVEY_CHARS),
  ].join('\n');
  const { data } = await aiExtract({ task: 'config_survey', promptVersion: CONFIG_PROMPTS.config_survey, input, schema: ConfigSurveySchema, runtime });

  // Only pages the document has; "present" without pages means the whole document.
  const pick = (p: { present: boolean; pages: number[] }): { pages: number[] } | null => {
    if (!p.present) return null;
    const pages = [...new Set(p.pages.filter((n) => have.has(n)))].sort((a, b) => a - b);
    return { pages: pages.length ? pages : [...have].sort((a, b) => a - b) };
  };
  const isTemplateDoc = d.role === 'report_template';
  const template = pick(isTemplateDoc ? { ...data.template, present: true } : data.template);
  const entry: ConfigSurveyEntry = {
    documentId: d.id, title: d.title, role: d.role, language,
    // A report-template document is read for a template and nothing else.
    lifecycle: isTemplateDoc ? null : pick(data.lifecycle), vocab: isTemplateDoc ? null : pick(data.vocab),
    template: template ? { ...template, name: data.template.name?.trim() || null, kind: data.template.kind ?? null } : null,
    note: data.note?.trim() || null,
  };
  const survey = [...cfg.survey.filter((e) => e.documentId !== d.id), entry];
  const last = cursor + 1 >= docs.length;
  if (!last) return { next: { stage: 'config_survey', cursor: cursor + 1 }, progress, report: { config: { ...cfg, survey } } };

  // The windows: each document, each target it holds, ~8 pages with 1 page overlap, in the order of the documents.
  const windows: AnalysisConfig['windows'] = [];
  for (const doc of docs) {
    const e = survey.find((x) => x.documentId === doc.id);
    if (!e) continue;
    for (const target of CONFIG_TARGETS) {
      const pages = e[target]?.pages;
      if (pages?.length) for (const w of pageWindows(pages, WINDOW_PAGES, WINDOW_OVERLAP)) windows.push({ documentId: doc.id, target, pages: w });
    }
  }
  return {
    next: windows.length ? { stage: 'config_extract', cursor: 0 } : WRITE,
    progress: { ...progress, configWindowsTotal: windows.length, configWindowsDone: 0, configItems: 0 },
    report: { config: { ...cfg, survey, windows } },
  };
};

// ---- config_extract -------------------------------------------------------------------------------------------------

const configExtract: ConfigStageFn = async (ctx, run, cursor, runtime, report) => {
  const cfg = configOf(report);
  const w = cfg.windows[cursor];
  const progress = run.progress as AnalysisProgress;
  if (!w) return { next: WRITE, report: { config: cfg } };
  const [doc] = await ctx.tx.select().from(sourceDocument).where(eq(sourceDocument.id, w.documentId));
  const pages = await pagesOf(ctx, w.documentId, w.pages);
  const entry = cfg.survey.find((e) => e.documentId === w.documentId);
  const header = [
    `Document: ${doc?.title ?? ''}`, `Role: ${doc?.role ?? 'other'}`, `Language: ${entry?.language ?? doc?.language ?? 'en'}`,
    ...(w.target === 'template' ? [`Report title: ${entry?.template?.name ?? doc?.title ?? ''}`] : []),
    `This window: pages ${w.pages[0]} to ${w.pages[w.pages.length - 1]}.`,
  ].join('\n');
  const input = `${header}\n\n${formatPages(pages)}`;
  type Answered = { kind: string; source: { page: number; quote: string }; confidence?: number | null | undefined; flags: string[] };
  const answered: Answered[] = w.target === 'lifecycle'
    ? (await aiExtract({ task: 'lifecycle', promptVersion: CONFIG_PROMPTS.lifecycle, input, schema: LifecycleExtractSchema, runtime })).data.items
    : w.target === 'vocab'
      ? (await aiExtract({ task: 'vocab', promptVersion: CONFIG_PROMPTS.vocab, input, schema: VocabExtractSchema, runtime })).data.items
      : (await aiExtract({ task: 'template', promptVersion: CONFIG_PROMPTS.template, input, schema: TemplateExtractSchema, runtime })).data.items;

  // Only what is on the pages it was shown is taken, as for the requirements.
  const asked = new Set(w.pages);
  const items = answered.filter((item) => asked.has(item.source.page));
  const rows = items.map((item, i) => ({
    institutionId: ctx.caller.institutionId, frameworkVersionId: run.frameworkVersionId, jobId: ctx.caller.requestId, analysisRunId: run.id,
    kind: CONFIG_ITEM_KIND[item.kind as keyof typeof CONFIG_ITEM_KIND], payload: { target: w.target, item, documentId: w.documentId, window: cursor, seq: cursor * 10_000 + i },
    sourceDocumentId: w.documentId, sourcePage: item.source.page, sourceQuote: item.source.quote, confidence: item.confidence ?? null, flags: item.flags,
  }));
  if (rows.length) await ctx.tx.insert(extractionItem).values(rows);
  return {
    next: cursor + 1 < cfg.windows.length ? { stage: 'config_extract', cursor: cursor + 1 } : WRITE,
    progress: { configWindowsTotal: cfg.windows.length, configWindowsDone: cursor + 1, configItems: (progress.configItems ?? 0) + rows.length },
    report: { config: cfg },
  };
};

// ---- config_write ---------------------------------------------------------------------------------------------------

/** The run's logged configuration proposals, in reading order. */
export async function loadConfigItems(ctx: Ctx, runId: string): Promise<RawConfigItem[]> {
  const logged = await ctx.tx.select().from(extractionItem)
    .where(and(eq(extractionItem.analysisRunId, runId), inArray(extractionItem.kind, [...CONFIG_LOG_KINDS])))
    .orderBy(asc(extractionItem.createdAt), asc(extractionItem.id));
  const out: RawConfigItem[] = [];
  for (const row of logged) {
    const p = row.payload as { target?: string; item?: unknown; documentId?: string; seq?: number; window?: number };
    if (!p.documentId || !p.target || !(CONFIG_TARGETS as readonly string[]).includes(p.target)) continue;
    const schema = p.target === 'lifecycle' ? LifecycleItemSchema : p.target === 'vocab' ? VocabItemSchema : TemplateItemSchema;
    const item = schema.safeParse(p.item);
    if (!item.success) continue;
    out.push({ id: row.id, documentId: p.documentId, target: p.target as ConfigTarget, seq: p.seq ?? 0, window: p.window ?? 0, item: item.data });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

const GROUP_SECTION: Record<ConfigItemGroup, ConfigSection> = {
  phase: 'lifecycle_template', milestone: 'lifecycle_template', decision: 'decision_vocab', finding: 'finding_vocab', response: 'response_vocab',
  rating: 'rating_method', template: 'report_templates', section: 'report_templates',
};
const NOT_FOUND: Record<ConfigSection, string | null> = {
  lifecycle_template: 'No lifecycle (stages and milestones) was found in the documents.',
  decision_vocab: 'No decision vocabulary was found in the documents.',
  finding_vocab: 'No finding vocabulary was found in the documents.',
  response_vocab: 'No response types were found in the documents.',
  rating_method: null,
  report_templates: 'No report template was found in the documents.',
};

/** Mirrors config_part_is_empty() in the database. */
function partIsEmpty(section: ConfigSection, v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    if (section === 'lifecycle_template') { const ph = (v as { phases?: unknown }).phases; return !Array.isArray(ph) || ph.length === 0; }
    return Object.keys(v as object).length === 0;
  }
  return false;
}
const size = (section: ConfigSection, v: unknown): number => {
  if (section === 'lifecycle_template') return ((v as { phases?: { milestones?: unknown[] }[] } | null)?.phases ?? []).reduce((n, p) => n + 1 + (p.milestones?.length ?? 0), 0);
  return Array.isArray(v) ? v.length : v ? 1 : 0;
};

type Found = Record<string, { runId?: string; at?: string; items?: Record<string, unknown>; keys?: string[] }>;

const configWrite: ConfigStageFn = async (ctx, run, _cursor, _runtime, report) => {
  const cfg = configOf(report);
  const versionId = run.frameworkVersionId;
  const raw = await loadConfigItems(ctx, run.id);
  const candidates = await configCandidates(ctx, versionId);
  const docs = new Map<string, ConfigDoc>(candidates.map((d) => [d.id, { id: d.id, title: d.title, language: cfg.survey.find((e) => e.documentId === d.id)?.language ?? d.language, role: d.role }]));
  // The titles of documents the items cite are needed even if a role changed meanwhile.
  for (const r of raw) if (!docs.has(r.documentId)) {
    const [d] = await ctx.tx.select().from(sourceDocument).where(eq(sourceDocument.id, r.documentId));
    if (d) docs.set(d.id, { id: d.id, title: d.title, language: d.language, role: d.role });
  }
  const pages = await loadPageTexts(ctx, [...new Set(raw.map((r) => r.documentId))]);
  const hints = new Map<string, TemplateHint>(cfg.survey.filter((e) => e.template).map((e) => [e.documentId, { name: e.template!.name, kind: e.template!.kind }]));

  const version = await getVersion(ctx, versionId);
  const existingTemplates = await ctx.tx.select().from(reportTemplate).where(eq(reportTemplate.frameworkVersionId, versionId));
  const found = ((version.configFound ?? {}) as Found);
  const edited = ((version.configEdited ?? {}) as Record<string, boolean>);
  const mine = (t: typeof existingTemplates[number]) => t.origin === 'ai' && !t.editedByPerson && t.reviewStatus === 'pending';
  const analysisKeys = new Set(found.report_templates?.keys ?? []);

  const build: ConfigBuild = buildConfig({
    raw, docs, pages, templateHints: hints,
    otherTemplates: existingTemplates.filter((t) => !mine(t)).map((t) => ({ key: t.key, name: t.name })),
  });

  // The raw log records how each proposal fared in the checks.
  for (const [id, check] of build.checks) {
    await ctx.tx.update(extractionItem).set({ quoteVerified: check.quoteVerified, flags: check.flags, sourcePage: check.page }).where(eq(extractionItem.id, id));
  }

  const results: ConfigItemResult[] = build.results;
  const now = new Date().toISOString();
  const stopped = cfg.stopped === 'budget';
  const newFound: Found = { ...found };
  const patch: Partial<typeof frameworkVersion.$inferInsert> = {};
  const decide = (section: ConfigSection, current: unknown, next: unknown, refs: Record<string, ConfigRef>, write: (v: never) => void): 'written' | 'kept' => {
    const owned = !!found[section];
    if (edited[section] || !(partIsEmpty(section, current) || owned)) return 'kept';
    // A run that stopped early does not replace a fuller result the analysis wrote before.
    if (stopped && owned && size(section, next) < size(section, current)) return 'kept';
    write(next as never);
    newFound[section] = { runId: run.id, at: now, items: refs };
    return 'written';
  };
  const outcome = new Map<ConfigSection, 'written' | 'kept'>();
  if (build.lifecycle.value) outcome.set('lifecycle_template', decide('lifecycle_template', version.lifecycleTemplate, build.lifecycle.value, build.lifecycle.refs, (v) => { patch.lifecycleTemplate = v; }));
  if (build.decision.value.length) outcome.set('decision_vocab', decide('decision_vocab', version.decisionVocab, build.decision.value, build.decision.refs, (v) => { patch.decisionVocab = v; }));
  if (build.finding.value.length) outcome.set('finding_vocab', decide('finding_vocab', version.findingVocab, build.finding.value, build.finding.refs, (v) => { patch.findingVocab = v; }));
  if (build.response.value.length) outcome.set('response_vocab', decide('response_vocab', version.responseVocab, build.response.value, build.response.refs, (v) => { patch.responseVocab = v; }));
  if (build.rating.value) outcome.set('rating_method', decide('rating_method', version.ratingMethod, build.rating.value, { rating_method: build.rating.ref! }, (v) => { patch.ratingMethod = v; }));

  // Templates: one row per template document, matched by key. A person's row is left alone; one a person deleted is not added back.
  const byKey = new Map(existingTemplates.map((t) => [t.key, t]));
  const tplOutcome = new Map<string, 'written' | 'kept' | 'deleted'>();
  const writtenKeys = new Set<string>();
  const tplItems: Record<string, unknown> = { ...(found.report_templates?.items ?? {}) };
  for (const t of build.templates) {
    const row = byKey.get(t.key);
    const values = {
      name: t.name, kind: t.kind as typeof reportTemplate.$inferInsert.kind, language: t.language, structure: t.structure, wordLimit: t.word_limit, requiresAttestation: t.requires_attestation,
      sourceDocumentId: t.source.documentId, sourcePage: t.source.page, sourceQuote: t.source.quote, quoteVerified: t.source.verified,
    };
    if (!row && analysisKeys.has(t.key)) { tplOutcome.set(t.key, 'deleted'); continue; }
    if (row && !mine(row)) { tplOutcome.set(t.key, 'kept'); continue; }
    if (!row) {
      await ctx.tx.insert(reportTemplate).values({
        institutionId: ctx.caller.institutionId, frameworkVersionId: versionId, key: t.key, origin: 'ai', reviewStatus: 'pending', ...values,
      });
    } else {
      await ctx.tx.update(reportTemplate).set(values).where(eq(reportTemplate.id, row.id));
    }
    tplOutcome.set(t.key, 'written');
    writtenKeys.add(t.key);
    tplItems[t.key] = { ...t.source, sections: t.sectionRefs };
  }
  if (writtenKeys.size) newFound.report_templates = { runId: run.id, at: now, keys: [...new Set([...analysisKeys, ...writtenKeys])], items: tplItems };

  if (Object.keys(patch).length || writtenKeys.size) {
    await ctx.tx.update(frameworkVersion).set({ ...patch, configFound: newFound }).where(eq(frameworkVersion.id, versionId));
  }

  // What became of each item: written to the draft, kept out as flagged, or left because a person's work is there.
  const keyOfTemplate = new Map(build.templates.map((t) => [t.name, t.key]));
  const deletedByPerson: string[] = [];
  for (const res of results) {
    if (res.status === 'flagged') continue;
    const section = GROUP_SECTION[res.group];
    if (section === 'report_templates') {
      const tplName = res.group === 'template' ? res.label : res.under ?? '';
      const key = keyOfTemplate.get(tplName);
      const o = key ? tplOutcome.get(key) : undefined;
      if (o === 'kept') { res.status = 'kept'; res.reasons = [...res.reasons, 'a template with this key was made or changed by a person, so it was left as it is']; }
      if (o === 'deleted') {
        res.status = 'kept'; res.reasons = [...res.reasons, 'you deleted this template, so it was not added back'];
        if (res.group === 'template') deletedByPerson.push(res.label);
      }
    } else if (outcome.get(section) === 'kept') {
      res.status = 'kept';
      res.reasons = [...res.reasons, edited[section] ? 'you edited this part, so it was left as it is' : stopped && found[section] ? 'the analysis stopped early, so the fuller earlier result was kept' : 'this part was not made by the analysis, so it was left as it is'];
    }
  }

  const sections: ConfigResult['sections'] = CONFIG_SECTIONS.map((section) => {
    const mineRes = results.filter((r) => GROUP_SECTION[r.group] === section);
    const written = mineRes.filter((r) => r.status === 'written').length;
    const flagged = mineRes.filter((r) => r.status === 'flagged').length;
    const kept = mineRes.filter((r) => r.status === 'kept').length;
    const state: ConfigResult['sections'][number]['state'] = written ? 'written' : kept ? 'kept_your_edits' : flagged ? 'flagged_only' : 'nothing_found';
    return { section, state, written, flagged };
  });
  const notFound = sections.filter((s) => s.state === 'nothing_found').map((s) => NOT_FOUND[s.section]).filter((m): m is string => !!m);
  const result: ConfigResult = {
    items: results, sections, notFound, deletedByPerson,
    milestonesNeedingDueRule: results.filter((r) => r.group === 'milestone' && r.status === 'written' && !!r.dueText).length,
  };
  const stats = report.stats ? {
    ...(report.stats as AnalysisStats),
    configItems: results.length, configWritten: results.filter((r) => r.status === 'written').length, configFlagged: results.filter((r) => r.status === 'flagged').length,
  } : undefined;
  return { next: await afterConfig(ctx, versionId), report: { config: { ...cfg, result }, ...(stats ? { stats } : {}) } };
};

export const CONFIG_STEPS: Record<'config_survey' | 'config_extract' | 'config_write', ConfigStageFn> = {
  config_survey: configSurvey, config_extract: configExtract, config_write: configWrite,
};
