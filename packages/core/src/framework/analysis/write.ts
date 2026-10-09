// The "verify and write" stage: what the extract stage logged is checked, merged and written into the draft version.
// Human edits win (DEC-022): rows a person made, edited or reviewed are never overwritten, re-parented or deleted.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { analysisDismissal, extractionItem, frameworkVersion, requirement, requirementNote, sourcePage } from '@ams/db';
import type { AnalysisStats } from '@ams/shared';
import type { Ctx } from '../../ctx.js';
import { splitTitleAndText } from '../exchange.js';
import { LOW_CONFIDENCE, mergeExtracted, normalizeCode, noteFingerprint, type DocInfo, type RawItem } from './merge.js';
import { ExtractItemSchema } from './schemas.js';

type ReqRow = typeof requirement.$inferSelect;
type NoteRow = typeof requirementNote.$inferSelect;

/** Only an AI row nobody has touched may be changed by a later run. */
const untouched = (r: { origin: string; editedByPerson: boolean; reviewStatus: string }) => r.origin === 'ai' && !r.editedByPerson && r.reviewStatus === 'pending';

/** Level names of the version, top first; the name for a depth past them is the last one. */
const levelAt = (labels: string[], depth: number) => labels[Math.min(depth, labels.length - 1)] ?? 'Requirement';

/** The run's logged proposals (extraction and recovery), in reading order. */
export async function loadRawItems(ctx: Ctx, runId: string): Promise<RawItem[]> {
  const logged = await ctx.tx.select().from(extractionItem)
    .where(and(eq(extractionItem.analysisRunId, runId), inArray(extractionItem.kind, ['requirement', 'note'])))
    .orderBy(asc(extractionItem.createdAt), asc(extractionItem.id));
  const raw: RawItem[] = [];
  for (const row of logged) {
    const p = row.payload as { item?: unknown; documentId?: string; seq?: number; window?: number };
    const item = ExtractItemSchema.safeParse(p.item);
    if (!item.success || !p.documentId) continue;
    raw.push({ id: row.id, documentId: p.documentId, seq: p.seq ?? 0, window: p.window ?? 0, item: item.data });
  }
  return raw.sort((a, b) => a.seq - b.seq);
}

/** Page texts by document. */
export async function loadPageTexts(ctx: Ctx, docIds: string[]): Promise<Map<string, Map<number, string>>> {
  const pages = new Map<string, Map<number, string>>();
  if (!docIds.length) return pages;
  for (const p of await ctx.tx.select({ d: sourcePage.sourceDocumentId, n: sourcePage.pageNo, t: sourcePage.text }).from(sourcePage).where(inArray(sourcePage.sourceDocumentId, docIds))) {
    if (!pages.has(p.d)) pages.set(p.d, new Map());
    pages.get(p.d)!.set(p.n, p.t);
  }
  return pages;
}

const noteKeyOf = (code: string, text: string) => `${code}\u0000${noteFingerprint(text)}`;

/** What a person deleted from this version after the analysis made it (analysis_dismissal, written by a trigger). */
export async function loadDismissals(ctx: Ctx, versionId: string) {
  const rows = await ctx.tx.select().from(analysisDismissal).where(eq(analysisDismissal.frameworkVersionId, versionId));
  return {
    requirements: new Set(rows.filter((r) => r.kind === 'requirement').map((r) => normalizeCode(r.code))),
    notes: new Set(rows.filter((r) => r.kind === 'note').map((r) => noteKeyOf(normalizeCode(r.code), r.noteText ?? ''))),
  };
}

/**
 * Everything the gap finder and the writer need, read the same way for both: the run's proposals without those a person
 * deleted before (unless the code is back in the draft), checked and merged against the stored pages.
 */
export async function loadRunState(ctx: Ctx, run: { id: string; frameworkVersionId: string }, docs: ReadonlyMap<string, DocInfo>, pageDocIds: string[] = []) {
  const all = await loadRawItems(ctx, run.id);
  const existing = await ctx.tx.select().from(requirement).where(eq(requirement.frameworkVersionId, run.frameworkVersionId));
  const byCode = new Map<string, ReqRow>(existing.map((r) => [normalizeCode(r.code), r]));
  const dismissed = await loadDismissals(ctx, run.frameworkVersionId);
  const skipped = new Set<string>();
  const dismissedRaw: RawItem[] = [];
  const raw = all.filter((r) => {
    const code = r.item.kind === 'requirement' && r.item.code?.trim() ? normalizeCode(r.item.code) : null;
    if (code && dismissed.requirements.has(code) && !byCode.has(code)) { skipped.add(code); dismissedRaw.push(r); return false; }
    return true;
  });
  const pages = await loadPageTexts(ctx, [...new Set([...raw.map((r) => r.documentId), ...pageDocIds])]);
  const merged = mergeExtracted(raw, docs, pages, new Set(byCode.keys()));
  return { raw, dismissedRaw, pages, existing, byCode, dismissed, skippedRequirements: skipped, merged };
}

export async function writeAnalysis(ctx: Ctx, run: { id: string; frameworkVersionId: string }, docs: ReadonlyMap<string, DocInfo>): Promise<AnalysisStats> {
  const versionId = run.frameworkVersionId;
  const { existing, byCode, dismissed, skippedRequirements, merged } = await loadRunState(ctx, run, docs);
  const [v] = await ctx.tx.select({ levelLabels: frameworkVersion.levelLabels }).from(frameworkVersion).where(eq(frameworkVersion.id, versionId));
  const labels = ((v?.levelLabels as string[] | undefined) ?? []).filter(Boolean);
  // Real depth in the draft, existing rows included (a proposed requirement may sit under a person's row).
  const depthOf = new Map<string, number>();
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const r of existing) {
    let d = 0;
    for (let at = r; at.parentId && byId.has(at.parentId) && d < 50; at = byId.get(at.parentId)!) d++;
    depthOf.set(normalizeCode(r.code), d);
  }

  let added = 0;
  let updated = 0;
  let keptHumanEdits = 0;
  const writtenReq: { code: string; levelLabel: string; quoteVerified: boolean; confidence: number | null }[] = [];

  // Sibling order: by where each requirement appears in the sources.
  const siblingIndex = new Map<string, number>();
  const orderOf = (parentCode: string | null) => {
    const k = parentCode ?? '';
    const n = siblingIndex.get(k) ?? 0;
    siblingIndex.set(k, n + 1);
    return n;
  };

  for (const m of merged.requirements) {
    const parent = m.parentCode ? byCode.get(m.parentCode) ?? null : null;
    const depth = parent ? (depthOf.get(normalizeCode(parent.code)) ?? 0) + 1 : 0;
    const levelLabel = m.levelLabel && (labels.length === 0 || labels.includes(m.levelLabel)) ? m.levelLabel : levelAt(labels, depth);
    const { title, officialText } = splitTitleAndText(m.code, m.title ?? m.code, m.text || null);
    const values = {
      parentId: parent?.id ?? null, title, officialText, levelLabel, displayOrder: orderOf(m.parentCode), language: m.language,
      isAssessable: m.isAssessable, sourceDocumentId: m.documentId, sourcePage: m.page, sourceQuote: m.quote, quoteVerified: m.quoteVerified,
    };
    const current = byCode.get(m.code);
    if (!current) {
      const [row] = await ctx.tx.insert(requirement).values({
        institutionId: ctx.caller.institutionId, frameworkVersionId: versionId, code: m.code, origin: 'ai', ...values,
      }).returning();
      byCode.set(m.code, row!);
      added++;
    } else if (untouched(current)) {
      const [row] = await ctx.tx.update(requirement).set(values).where(eq(requirement.id, current.id)).returning();
      byCode.set(m.code, row!);
      updated++;
    } else {
      keptHumanEdits++;
      // A person's row keeps its place (and its depth, which guides the level of AI rows under it).
      continue;
    }
    depthOf.set(m.code, depth);
    writtenReq.push({ code: m.code, levelLabel, quoteVerified: m.quoteVerified, confidence: m.confidence });
  }

  // Notes: matched to what is already there by requirement and text.
  const reqIds = [...byCode.values()].map((r) => r.id);
  const existingNotes: NoteRow[] = reqIds.length ? await ctx.tx.select().from(requirementNote).where(inArray(requirementNote.requirementId, reqIds)) : [];
  const noteKey = (requirementId: string, text: string) => `${requirementId}\u0000${noteFingerprint(text)}`;
  const notesByKey = new Map(existingNotes.map((n) => [noteKey(n.requirementId, n.text), n]));
  const writtenNotes: { quoteVerified: boolean; confidence: number | null }[] = [];
  let orphanNotes = merged.orphanNotes;
  let dismissedNotes = 0;
  for (const n of merged.notes) {
    const req = byCode.get(n.requirementCode);
    if (!req) { orphanNotes++; continue; }
    const values = {
      type: n.type, text: n.text, authority: n.authority, sourceDocumentId: n.documentId, sourcePage: n.page, sourceQuote: n.quote, quoteVerified: n.quoteVerified,
    };
    const current = notesByKey.get(noteKey(req.id, n.text));
    // A note a person deleted is not added back (step D); one they wrote again themselves is theirs.
    if (!current && dismissed.notes.has(noteKeyOf(n.requirementCode, n.text))) { dismissedNotes++; continue; }
    if (!current) {
      const [row] = await ctx.tx.insert(requirementNote).values({ institutionId: ctx.caller.institutionId, requirementId: req.id, origin: 'ai', ...values }).returning();
      notesByKey.set(noteKey(req.id, n.text), row!);
      added++;
    } else if (untouched(current)) {
      await ctx.tx.update(requirementNote).set(values).where(eq(requirementNote.id, current.id));
      updated++;
    } else {
      keptHumanEdits++;
      continue;
    }
    writtenNotes.push({ quoteVerified: n.quoteVerified, confidence: n.confidence });
  }

  // The raw log records how each proposal fared in the checks.
  for (const [id, check] of merged.checks) {
    await ctx.tx.update(extractionItem).set({ quoteVerified: check.quoteVerified, flags: check.flags, sourcePage: check.page })
      .where(eq(extractionItem.id, id));
  }

  const all = [...writtenReq, ...writtenNotes];
  const verified = all.filter((x) => x.quoteVerified).length;
  const requirementsByLevel: Record<string, number> = {};
  for (const r of writtenReq) requirementsByLevel[r.levelLabel] = (requirementsByLevel[r.levelLabel] ?? 0) + 1;
  return {
    pagesRead: 0, // filled in by the finalise stage
    requirementsByLevel,
    requirements: writtenReq.length,
    notes: writtenNotes.length,
    quoteVerified: verified,
    quoteVerifiedShare: all.length ? Math.round((verified / all.length) * 1000) / 1000 : 0,
    unverified: all.length - verified,
    orphans: merged.orphanRequirements + orphanNotes,
    lowConfidence: all.filter((x) => x.confidence !== null && x.confidence < LOW_CONFIDENCE).length,
    added,
    updated,
    keptHumanEdits,
    dismissedSkipped: skippedRequirements.size + dismissedNotes,
  };
}
