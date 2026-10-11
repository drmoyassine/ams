// "Needs a look": which requirements and notes of a draft a person should check first. A cheap, read-only view over what is
// already stored: the quote verdicts on the rows, the analysis's raw log (confidence), and the tree (orphans).
import { asc, eq, inArray } from 'drizzle-orm';
import { analysisRun, extractionItem, requirement, requirementNote } from '@ams/db';
import type { Ctx } from '../ctx.js';
import { LOW_CONFIDENCE, noteFingerprint, normalizeCode } from './analysis/merge.js';
import { getVersion, require_ } from './common.js';

export interface ReviewItems {
  /** Only requirements with at least one reason to look. */
  requirements: { id: string; quoteNotFound: boolean; lowConfidence: boolean; orphan: boolean }[];
  /** Only notes with at least one reason to look. `suggested`: the analysis's own suggestion (authority ai_suggested). */
  notes: { id: string; requirementId: string; quoteNotFound: boolean; lowConfidence: boolean; suggested: boolean }[];
}

interface Logged { runId: string | null; confidence: number | null; parentCode: string | null }

/**
 * The reasons to look at a draft's items, newest information first:
 *  - quote not found: the row cites a quote that is not on the stored page (any origin: a person's citation too);
 *  - low confidence: the analysis itself was unsure (the best of the copies it proposed is under LOW_CONFIDENCE);
 *  - orphan: placed at the top level because the analysis named a parent that does not exist in the draft;
 *  - suggested: a note the analysis labelled ai_suggested (it could not tell what authority the accreditor gives it).
 * A person's own edit takes a row off the low-confidence and orphan lists: they have looked at it.
 */
export async function listReviewItems(ctx: Ctx, versionId: string): Promise<ReviewItems> {
  await require_(ctx, 'framework:read');
  await getVersion(ctx, versionId);
  const reqs = await ctx.tx.select().from(requirement).where(eq(requirement.frameworkVersionId, versionId));
  if (!reqs.length) return { requirements: [], notes: [] };
  const notes = await ctx.tx.select().from(requirementNote).where(inArray(requirementNote.requirementId, reqs.map((r) => r.id))).orderBy(asc(requirementNote.createdAt));
  const codes = new Set(reqs.map((r) => normalizeCode(r.code)));

  // What the latest run logged for each code (and each note), from its raw proposals.
  const logged = await ctx.tx.select({ kind: extractionItem.kind, payload: extractionItem.payload, runId: extractionItem.analysisRunId, at: analysisRun.createdAt })
    .from(extractionItem).leftJoin(analysisRun, eq(analysisRun.id, extractionItem.analysisRunId))
    .where(eq(extractionItem.frameworkVersionId, versionId)).orderBy(asc(analysisRun.createdAt), asc(extractionItem.createdAt));
  const reqLog = new Map<string, Logged[]>();
  const noteLog = new Map<string, Logged[]>();
  const keep = (map: Map<string, Logged[]>, key: string, entry: Logged) => {
    const list = map.get(key);
    if (!list || list[0]!.runId !== entry.runId) map.set(key, [entry]); // a later run replaces what earlier ones logged
    else list.push(entry);
  };
  for (const row of logged) {
    const item = (row.payload as { item?: { kind?: string; code?: string | null; parent_code?: string | null; text?: string; confidence?: number | null } } | null)?.item;
    if (!item) continue;
    const entry: Logged = { runId: row.runId, confidence: item.confidence ?? null, parentCode: item.parent_code?.trim() ? normalizeCode(item.parent_code) : null };
    if (row.kind === 'requirement' && item.code?.trim()) keep(reqLog, normalizeCode(item.code), entry);
    else if (row.kind === 'note' && entry.parentCode && item.text) keep(noteLog, `${entry.parentCode}\u0000${noteFingerprint(item.text)}`, entry);
  }
  const low = (list: Logged[] | undefined) => {
    const known = (list ?? []).map((l) => l.confidence).filter((c): c is number => c !== null);
    return known.length > 0 && Math.max(...known) < LOW_CONFIDENCE;
  };

  const byId = new Map(reqs.map((r) => [r.id, r]));
  const requirements: ReviewItems['requirements'] = [];
  for (const r of reqs) {
    const log = reqLog.get(normalizeCode(r.code));
    const analysisMade = r.origin === 'ai' && !r.editedByPerson;
    const stated = log?.map((l) => l.parentCode).find((p) => p) ?? null;
    const flags = {
      quoteNotFound: !!r.sourceQuote && !r.quoteVerified,
      lowConfidence: analysisMade && low(log),
      orphan: analysisMade && !r.parentId && !!stated && stated !== normalizeCode(r.code) && !codes.has(stated),
    };
    if (flags.quoteNotFound || flags.lowConfidence || flags.orphan) requirements.push({ id: r.id, ...flags });
  }
  const out: ReviewItems['notes'] = [];
  for (const n of notes) {
    const parent = byId.get(n.requirementId);
    const analysisMade = n.origin === 'ai' && !n.editedByPerson;
    const flags = {
      quoteNotFound: !!n.sourceQuote && !n.quoteVerified,
      lowConfidence: analysisMade && !!parent && low(noteLog.get(`${normalizeCode(parent.code)}\u0000${noteFingerprint(n.text)}`)),
      suggested: n.authority === 'ai_suggested',
    };
    if (flags.quoteNotFound || flags.lowConfidence || flags.suggested) out.push({ id: n.id, requirementId: n.requirementId, ...flags });
  }
  return { requirements, notes: out };
}
