// The IQF mapping stages of the `analyse` job (step E; DEC-006, DEC-021, DEC-022, DEC-023), run after `write`:
//
//   embed        one job: if embeddings are on in Settings -> AI, embeds this version's requirements and the IQF's items
//                (framework text only; unchanged texts are skipped by hash). Off or not set up: lexical only, recorded.
//   map          one batch of ~10 requirements per job (cursor = batch index): a shortlist of at most 8 IQF items for each
//                (words, and meaning when embeddings are on), then one aiExtract (map.v1) judging every candidate. What comes
//                back becomes a SUGGESTED LINK: a requirement_mapping row, origin 'ai', review 'pending'. Ranking never decides.
//   propose_new  one chunk of ~20 requirements per job: those with no covering or partly covering suggestion are grouped and
//                a NEW IQF item is drafted for each group (newiqf.v1) as an iqf_item_proposal, pending. The IQF itself is
//                never written here; the database refuses it for the worker.
//
// Same rules as the other stages: each step in its own transaction, the cursor makes a retried job harmless, the run's
// budget covers every call, and the spend limit ends the mapping (not the run): see mappingBudgetStop.
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { embedding, iqfItemProposal, requirement, requirementMapping, type analysisRun } from '@ams/db';
import type { AnalysisMapping, AnalysisProgress, AnalysisStage } from '@ams/shared';
import type { Ctx } from '../../ctx.js';
import { aiExtract, BudgetExceeded, type AiRuntime } from '../../ai/index.js';
import { rankBySimilarity, requirementEmbeddingItems, upsertEmbeddings } from '../../ai/embeddings.js';
import { getVersion, isInternalVersion } from '../common.js';
import { candidatesOf, loadIqf, naturalCompare, nextFreeCode, usableCode, type Iqf, type IqfItem } from './iqf-context.js';
import { MapSchema, NewIqfSchema } from './mapping-schemas.js';
import { normalizeCode } from './merge.js';
import { ANALYSIS_PROMPTS } from './schemas.js';
import { buildShortlist, LexicalIndex, RANK_DEPTH, SHORTLIST_SIZE } from './shortlist.js';

type Run = typeof analysisRun.$inferSelect;
type Reports = { [k: string]: unknown };
export interface MappingStep {
  next: { stage: AnalysisStage; cursor: number } | 'done';
  progress?: Partial<AnalysisProgress>;
  report?: { mapping: AnalysisMapping };
}
type MappingStageFn = (ctx: Ctx, run: Run, cursor: number, runtime: AiRuntime, report: Reports) => Promise<MappingStep>;

/** Requirements judged per model call, and requirements grouped per new-item call. */
export const MAP_BATCH = 10;
export const NEW_ITEM_CHUNK = 20;
const REQ_CHARS = 1200;
const CAND_CHARS = 500;
const REASON_CHARS = 500;
const OUTLINE_LINES = 300;
const FINALISE = { stage: 'finalise', cursor: 0 } as const satisfies { stage: AnalysisStage; cursor: number };

export const MAPPING_STAGES: readonly AnalysisStage[] = ['embed', 'map', 'propose_new'];
export const isMappingStage = (stage: string): boolean => (MAPPING_STAGES as readonly string[]).includes(stage);

const emptyMapping = (over: Partial<AnalysisMapping> = {}): AnalysisMapping => ({
  skipped: null, iqfVersionId: null, retrieval: 'lexical only',
  embeddings: { used: false, embedded: 0, reused: 0, note: null },
  requirements: 0, judged: 0, skippedDecided: 0, mapped: 0, noSuggestion: 0,
  links: { covers: 0, partly_covers: 0, related: 0, kept: 0 }, newItems: 0,
  shortlist: { requirements: 0, candidates: 0, perRequirement: 0, padded: 0, size: SHORTLIST_SIZE },
  judgedCodes: [], noSuggestionCodes: [], unplacedCodes: [], stopped: null,
  ...over,
});
const mappingOf = (report: Reports): AnalysisMapping => (report.mapping as AnalysisMapping | undefined) ?? emptyMapping();

/** The spend limit ends the mapping, not the run: what was proposed stays, the run finishes (like the recovery rounds). */
export function mappingBudgetStop(report: Reports): MappingStep {
  return { next: FINALISE, report: { mapping: { ...mappingOf(report), stopped: 'budget' } } };
}

interface ExtReq { id: string; code: string; title: string; text: string }

/** The version's requirements a link can be proposed for: assessable, with wording or a real title. Stable order. */
async function eligibleRequirements(ctx: Ctx, versionId: string): Promise<ExtReq[]> {
  const rows = await ctx.tx.select().from(requirement).where(and(eq(requirement.frameworkVersionId, versionId), eq(requirement.isAssessable, true)));
  return rows
    .filter((r) => !!r.officialText?.trim() || r.title.trim() !== r.code.trim())
    .map((r) => ({ id: r.id, code: r.code, title: r.title, text: (r.officialText ?? '').normalize('NFC') }))
    .sort((a, b) => naturalCompare(a.code, b.code) || a.id.localeCompare(b.id));
}

const clean = (s: string | null | undefined, max: number) => (s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, max);

// ---- embed -----------------------------------------------------------------------------------------------------------

const embedStage: MappingStageFn = async (ctx, run, _cursor, runtime) => {
  const iqf = await loadIqf(ctx);
  const reqs = await eligibleRequirements(ctx, run.frameworkVersionId);
  const skip = (why: string): MappingStep => ({ next: FINALISE, report: { mapping: emptyMapping({ skipped: why, requirements: reqs.length, iqfVersionId: iqf?.version?.id ?? null }) } });
  // The internal quality framework is its own frame (TASK-107): there is no external IQF to map it onto.
  if (await isInternalVersion(ctx, run.frameworkVersionId)) return skip('This is the internal quality framework: the institution\'s own frame, so there is nothing to map it onto.');
  if (!iqf || !iqf.version) return skip('There is no quality framework to map onto yet: set it up in Settings.');
  if (iqf.items.length === 0) return skip('The quality framework has no items yet, so there is nothing to link to.');
  if (reqs.length === 0) return skip('This version has no requirements with wording to map.');
  const base = emptyMapping({ iqfVersionId: iqf.version.id, requirements: reqs.length });
  const next: MappingStep['next'] = { stage: 'map', cursor: 0 };
  const progress = { mapTotal: reqs.length, mapDone: 0 };
  if (!runtime.embedding) {
    return { next, progress, report: { mapping: { ...base, embeddings: { ...base.embeddings, note: 'Lexical only: embeddings are off or not set up in Settings -> AI.' } } } };
  }
  try {
    const items = await requirementEmbeddingItems(ctx, [...reqs.map((r) => r.id), ...iqf.items.map((i) => i.id)]);
    const { embedded, skipped } = await upsertEmbeddings(ctx, items, runtime);
    return { next, progress, report: { mapping: { ...base, retrieval: 'hybrid', embeddings: { used: true, embedded, reused: skipped, note: null } } } };
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    // A failing endpoint costs the meaning-based ranking, not the mapping.
    const why = e instanceof Error ? e.message : String(e);
    return { next, progress, report: { mapping: { ...base, embeddings: { ...base.embeddings, note: `Lexical only: the embedding endpoint failed (${why.slice(0, 200)}).` } } } };
  }
};

// ---- map -------------------------------------------------------------------------------------------------------------

const untouched = (m: { origin: string; reviewStatus: string; editedByPerson: boolean }) => m.origin === 'ai' && m.reviewStatus === 'pending' && !m.editedByPerson;

const mapStage: MappingStageFn = async (ctx, run, cursor, runtime, report) => {
  const m = structuredClone(mappingOf(report));
  const iqf = await loadIqf(ctx);
  if (!iqf || !iqf.version) return { next: { stage: 'propose_new', cursor: 0 }, report: { mapping: m } };
  const version = await getVersion(ctx, run.frameworkVersionId);
  const reqs = await eligibleRequirements(ctx, run.frameworkVersionId);
  const batch = reqs.slice(cursor * MAP_BATCH, (cursor + 1) * MAP_BATCH);
  const more = (cursor + 1) * MAP_BATCH < reqs.length;
  const progress = { mapTotal: reqs.length, mapDone: Math.min((cursor + 1) * MAP_BATCH, reqs.length) };
  const next: MappingStep['next'] = more ? { stage: 'map', cursor: cursor + 1 } : { stage: 'propose_new', cursor: 0 };
  if (batch.length === 0) return { next: { stage: 'propose_new', cursor: 0 }, progress, report: { mapping: m } };

  const existing = await ctx.tx.select().from(requirementMapping).where(and(
    eq(requirementMapping.frameworkId, version.frameworkId), inArray(requirementMapping.externalCode, batch.map((r) => r.code))));
  const rowsOf = (code: string) => existing.filter((x) => x.externalCode === code);
  const index = new LexicalIndex(candidatesOf(iqf.items));
  const byId = new Map(iqf.items.map((i) => [i.id, i]));
  const topLevel = iqf.items.filter((i) => i.depth === 0).map((i) => i.id);
  const model = runtime.embedding?.model;
  const useMeaning = m.embeddings.used && !!model;
  const vectors = new Map<string, number[]>();
  if (useMeaning) {
    for (const e of await ctx.tx.select({ ownerId: embedding.ownerId, vector: embedding.vector }).from(embedding)
      .where(and(eq(embedding.model, model!), eq(embedding.ownerType, 'requirement'), inArray(embedding.ownerId, batch.map((r) => r.id))))) vectors.set(e.ownerId, e.vector);
  }
  const poolIds = iqf.items.map((i) => i.id);

  const judged: { req: ExtReq; candidates: IqfItem[] }[] = [];
  for (const r of batch) {
    const rows = rowsOf(r.code);
    // A person has decided about this requirement already: an approved link, or one they made or edited.
    if (rows.some((x) => x.reviewStatus === 'approved' || !untouched(x) && x.reviewStatus !== 'rejected')) { m.skippedDecided++; continue; }
    // A rejected suggestion is remembered: that pair is not offered again.
    const rejected = new Set(rows.filter((x) => x.reviewStatus === 'rejected').map((x) => normalizeCode(x.internalCode)));
    m.links.kept += rejected.size;
    const allowed = (id: string) => { const it = byId.get(id); return !!it && !rejected.has(normalizeCode(it.code)); };
    const byWords = index.rank({ title: r.title, text: r.text.slice(0, REQ_CHARS) }, RANK_DEPTH * 2).map((x) => x.id).filter(allowed);
    const vec = vectors.get(r.id);
    const byMeaning = useMeaning && vec ? (await rankBySimilarity(ctx, vec, poolIds, RANK_DEPTH * 2, model!)).map((x) => x.ownerId).filter(allowed) : [];
    const sl = buildShortlist(byWords, byMeaning, topLevel.filter(allowed));
    m.judgedCodes.push(r.code);
    m.judged++;
    if (sl.ids.length === 0) { m.noSuggestion++; m.noSuggestionCodes.push(r.code); continue; }
    m.shortlist.requirements++;
    m.shortlist.candidates += sl.ids.length;
    if (sl.padded > 0) m.shortlist.padded++;
    judged.push({ req: r, candidates: sl.ids.map((id) => byId.get(id)!) });
  }
  m.shortlist.perRequirement = m.shortlist.requirements ? Math.round((m.shortlist.candidates / m.shortlist.requirements) * 10) / 10 : 0;

  if (judged.length > 0) {
    const levelNames = iqf.version.levelLabels;
    const input = [
      `Level names of the quality framework, top first: ${levelNames.length ? levelNames.join(' > ') : 'not set'}`,
      '',
      'REQUIREMENTS_JSON:',
      JSON.stringify(judged.map(({ req, candidates }) => ({
        code: req.code, title: req.title, text: clean(req.text, REQ_CHARS),
        candidates: candidates.map((c) => ({ code: c.code, path: c.path, title: c.title, text: clean(c.text, CAND_CHARS) })),
      }))),
    ].join('\n');
    const { data } = await aiExtract({ task: 'map', promptVersion: ANALYSIS_PROMPTS.map, input, schema: MapSchema, runtime });
    const answers = new Map(data.results.map((x) => [normalizeCode(x.requirement), x]));
    for (const { req, candidates } of judged) {
      const rows = rowsOf(req.code);
      const known = new Map(candidates.map((c) => [normalizeCode(c.code), c]));
      const seen = new Set<string>();
      let suggested = 0;
      for (const j of answers.get(normalizeCode(req.code))?.judgments ?? []) {
        const cand = known.get(normalizeCode(j.candidate));
        if (!cand || seen.has(cand.id) || j.relation === 'none') continue;
        seen.add(cand.id);
        const rationale = clean(j.reason, REASON_CHARS) || null;
        const current = rows.find((x) => normalizeCode(x.internalCode) === normalizeCode(cand.code));
        if (current && !untouched(current)) continue; // a person's row: left as it is
        if (!current) {
          await ctx.tx.insert(requirementMapping).values({
            institutionId: ctx.caller.institutionId, frameworkId: version.frameworkId, externalCode: req.code, internalFrameworkId: iqf.frameworkId,
            internalCode: cand.code, relation: j.relation, rationale, origin: 'ai',
          }).onConflictDoNothing();
        } else if (current.relation !== j.relation || (current.rationale ?? null) !== rationale) {
          await ctx.tx.update(requirementMapping).set({ relation: j.relation, rationale }).where(eq(requirementMapping.id, current.id));
        }
        m.links[j.relation]++;
        suggested++;
      }
      if (suggested > 0) m.mapped++;
      else { m.noSuggestion++; m.noSuggestionCodes.push(req.code); }
    }
  }
  return { next, progress, report: { mapping: m } };
};

// ---- propose_new -----------------------------------------------------------------------------------------------------

/** Requirements judged this run that no covering or partly covering link is suggested for, and no earlier decision settles. */
async function unplaced(ctx: Ctx, run: Run, m: AnalysisMapping): Promise<string[]> {
  const version = await getVersion(ctx, run.frameworkVersionId);
  if (m.judgedCodes.length === 0) return [];
  const fits = await ctx.tx.select({ code: requirementMapping.externalCode, relation: requirementMapping.relation, status: requirementMapping.reviewStatus }).from(requirementMapping)
    .where(and(eq(requirementMapping.frameworkId, version.frameworkId), inArray(requirementMapping.externalCode, m.judgedCodes)));
  const placed = new Set(fits.filter((f) => f.status !== 'rejected' && (f.relation === 'covers' || f.relation === 'partly_covers')).map((f) => normalizeCode(f.code)));
  // An earlier proposal a person accepted or dismissed settles these requirements; a re-run does not raise them again.
  const settled = new Set<string>();
  for (const p of await ctx.tx.select({ links: iqfItemProposal.links }).from(iqfItemProposal)
    .where(and(eq(iqfItemProposal.frameworkId, version.frameworkId), inArray(iqfItemProposal.status, ['accepted', 'dismissed'])))) {
    for (const l of p.links) settled.add(normalizeCode(l.externalCode));
  }
  return m.judgedCodes.filter((c) => !placed.has(normalizeCode(c)) && !settled.has(normalizeCode(c))).sort(naturalCompare);
}

function outline(iqf: Iqf): string {
  const lines = iqf.items.map((i) => `${'  '.repeat(i.depth)}${i.code} ${i.title}`);
  if (lines.length <= OUTLINE_LINES) return lines.join('\n');
  // A large IQF: the top levels in full, and a note that the rest is left out.
  const top = iqf.items.filter((i) => i.depth <= 1).map((i) => `${'  '.repeat(i.depth)}${i.code} ${i.title}`);
  return [...top.slice(0, OUTLINE_LINES), `(${iqf.items.length - Math.min(top.length, OUTLINE_LINES)} deeper items not shown)`].join('\n');
}

const proposeNewStage: MappingStageFn = async (ctx, run, cursor, runtime, report) => {
  const m = structuredClone(mappingOf(report));
  if (m.skipped) return { next: FINALISE, report: { mapping: m } };
  const iqf = await loadIqf(ctx);
  if (!iqf || !iqf.version || iqf.items.length === 0) return { next: FINALISE, report: { mapping: m } };
  const version = await getVersion(ctx, run.frameworkVersionId);
  // The pool is fixed at the first chunk, so the chunks of one run stay the same while it goes.
  const pool = cursor === 0 ? await unplaced(ctx, run, m) : m.unplacedCodes;
  m.unplacedCodes = pool;
  const chunks = Math.ceil(pool.length / NEW_ITEM_CHUNK);
  const progress = { groupsTotal: chunks, groupsDone: Math.min(cursor + 1, chunks) };
  const last = cursor + 1 >= chunks;
  const next: MappingStep['next'] = last ? FINALISE : { stage: 'propose_new', cursor: cursor + 1 };

  const codes = pool.slice(cursor * NEW_ITEM_CHUNK, (cursor + 1) * NEW_ITEM_CHUNK);
  if (codes.length > 0) {
    const reqs = new Map((await eligibleRequirements(ctx, run.frameworkVersionId)).map((r) => [normalizeCode(r.code), r]));
    const chosen = codes.map((c) => reqs.get(normalizeCode(c))).filter((r): r is ExtReq => !!r);
    const labels = iqf.version.levelLabels;
    const input = [
      `Level names of the quality framework, top first: ${labels.length ? labels.join(' > ') : 'not set'}`,
      '', 'Outline of the quality framework (code and title):', outline(iqf) || '(empty)',
      '', 'REQUIREMENTS_JSON:',
      JSON.stringify(chosen.map((r) => ({ code: r.code, title: r.title, text: clean(r.text, REQ_CHARS) }))),
    ].join('\n');
    const { data } = await aiExtract({ task: 'newiqf', promptVersion: ANALYSIS_PROMPTS.newiqf, input, schema: NewIqfSchema, runtime });

    const mine = new Set(chosen.map((r) => normalizeCode(r.code)));
    const realCode = new Map(chosen.map((r) => [normalizeCode(r.code), r.code]));
    const iqfByCode = new Map(iqf.items.map((i) => [normalizeCode(i.code), i]));
    const iqfById = new Map(iqf.items.map((i) => [i.id, i]));
    const pending = await ctx.tx.select().from(iqfItemProposal).where(and(eq(iqfItemProposal.frameworkId, version.frameworkId), eq(iqfItemProposal.status, 'pending')));
    const usedCodes = new Set<string>([...iqf.items.map((i) => normalizeCode(i.code)), ...pending.map((p) => normalizeCode(p.code))]);
    const placedHere = new Set<string>();
    for (const item of data.items) {
      const links: { externalCode: string; relation: string; reason: string | null }[] = [];
      for (const c of item.covers) {
        const key = normalizeCode(c.requirement);
        if (!mine.has(key) || placedHere.has(key)) continue;
        placedHere.add(key);
        links.push({ externalCode: realCode.get(key)!, relation: c.relation, reason: clean(c.reason, REASON_CHARS) || null });
      }
      const title = clean(item.title, 200);
      if (links.length === 0 || !title) continue;
      let parent = item.parent_code?.trim() ? iqfByCode.get(normalizeCode(item.parent_code)) ?? null : null;
      // The IQF names a level for each depth; an item cannot sit deeper than its last level, so it goes under the ancestor above.
      const proposedParent = parent;
      while (labels.length > 0 && parent && parent.depth + 1 > labels.length - 1) parent = parent.parentId ? iqfById.get(parent.parentId) ?? null : null;
      const depth = parent ? parent.depth + 1 : 0;
      const levelLabel = labels.length ? (labels[Math.min(depth, labels.length - 1)] ?? labels[labels.length - 1]!) : (item.level_label?.trim() || 'Standard');
      // Matches an earlier pending proposal for the same requirements: that one is refreshed, not duplicated.
      const prior = pending.find((p) => p.links.some((l) => links.some((n) => normalizeCode(n.externalCode) === normalizeCode(l.externalCode))));
      if (prior) usedCodes.delete(normalizeCode(prior.code));
      const suggested = usableCode(item.code) ? item.code.trim() : null;
      const code = suggested && parent === proposedParent && !usedCodes.has(normalizeCode(suggested)) ? suggested : nextFreeCode(usedCodes, parent?.code ?? null);
      usedCodes.add(normalizeCode(code));
      const values = {
        analysisRunId: run.id, parentCode: parent?.code ?? null, levelLabel, code, title,
        description: clean(item.description, 1500) || null, reason: clean(item.reason, REASON_CHARS) || null, links,
      };
      if (prior) {
        await ctx.tx.update(iqfItemProposal).set(values).where(eq(iqfItemProposal.id, prior.id));
      } else {
        await ctx.tx.insert(iqfItemProposal).values({
          institutionId: ctx.caller.institutionId, frameworkId: version.frameworkId, frameworkVersionId: run.frameworkVersionId,
          internalFrameworkId: iqf.frameworkId, status: 'pending', ...values,
        });
      }
      m.newItems++;
    }
  }
  if (last) {
    // Suggestions an earlier run made that this one did not repeat are replaced, not left beside the new ones.
    await ctx.tx.update(iqfItemProposal).set({ status: 'superseded' }).where(and(
      eq(iqfItemProposal.frameworkVersionId, run.frameworkVersionId), eq(iqfItemProposal.status, 'pending'),
      or(isNull(iqfItemProposal.analysisRunId), ne(iqfItemProposal.analysisRunId, run.id))));
  }
  return { next, progress, report: { mapping: m } };
};

export const MAPPING_STEPS: Record<'embed' | 'map' | 'propose_new', MappingStageFn> = { embed: embedStage, map: mapStage, propose_new: proposeNewStage };
