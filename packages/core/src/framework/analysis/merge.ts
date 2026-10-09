// Pure part of the "verify and write" stage: check every proposed item against the stored pages, merge what overlapping
// windows proposed twice, and resolve each requirement's parent by its code. No database, no AI.
import { normalizeQuoteText, textInPages, verifyQuote, type PageTexts } from '../quote-match.js';
import type { ExtractItem } from './schemas.js';

/** One item as the extract stage logged it: the model's answer plus where it came from. */
export interface RawItem {
  /** The extraction_item row, so its verification result can be recorded. */
  id: string;
  documentId: string;
  /** Position in the run (window by window, item by item): the reading order. */
  seq: number;
  window: number;
  item: ExtractItem;
}

export interface DocInfo {
  /** The role in force for the run (a person's choice, or the survey's). */
  role: string;
  language: string;
}

export interface ItemCheck {
  quoteVerified: boolean;
  /** The page the quote was found on, when it differs from the one cited. */
  page: number;
  flags: string[];
}

export interface MergedRequirement {
  code: string;
  parentCode: string | null;
  levelLabel: string | null;
  title: string | null;
  text: string;
  isAssessable: boolean;
  documentId: string;
  page: number;
  quote: string;
  quoteVerified: boolean;
  confidence: number | null;
  flags: string[];
  language: string;
  seq: number;
  depth: number;
  /** Ids of the raw items merged into this one. */
  from: string[];
}

export interface MergedNote {
  requirementCode: string;
  type: 'guidance' | 'evidence_expectation' | 'data_request' | 'quantitative_norm';
  authority: 'required' | 'example' | 'suggested' | 'ai_suggested';
  text: string;
  documentId: string;
  page: number;
  quote: string;
  quoteVerified: boolean;
  confidence: number | null;
  flags: string[];
  seq: number;
  from: string[];
}

export interface MergeResult {
  requirements: MergedRequirement[];
  notes: MergedNote[];
  /** Per raw item: whether its quote was found, and the flags it carries after the checks. */
  checks: Map<string, ItemCheck>;
  /** Requirements whose parent code matches nothing (placed at the top level), and notes with no requirement. */
  orphanRequirements: number;
  orphanNotes: number;
  /** Requirements proposed from a document that does not state the standards (kept out). */
  notFromStandards: number;
  duplicatesMerged: number;
}

/** Documents whose requirements are taken; notes are taken from these and the guidance documents. */
export const REQUIREMENT_ROLES = new Set(['standards']);
export const NOTE_ROLES = new Set(['standards', 'guidance', 'evidence_guidance']);
export const LOW_CONFIDENCE = 0.6;

export const normalizeCode = (code: string) => code.normalize('NFC').trim().replace(/\s+/g, ' ');
const uniq = (xs: string[]) => [...new Set(xs)];

/**
 * Verifies, merges and links the items of one run.
 * @param existingCodes codes already in the draft version (a parent may be one of them).
 */
export function mergeExtracted(raw: RawItem[], docs: ReadonlyMap<string, DocInfo>, pages: ReadonlyMap<string, PageTexts>, existingCodes: ReadonlySet<string>): MergeResult {
  const checks = new Map<string, ItemCheck>();
  const empty: PageTexts = new Map();
  let notFromStandards = 0;

  // 1. Deterministic checks of every item, before anything is merged.
  for (const r of raw) {
    const pageTexts = pages.get(r.documentId) ?? empty;
    const flags = [...r.item.flags];
    const q = verifyQuote(r.item.source.quote, pageTexts, r.item.source.page);
    if (!q.verified) flags.push('quote_not_found');
    else if (q.page !== r.item.source.page) flags.push('page_corrected');
    if (r.item.kind === 'requirement' && r.item.text.trim() && !textInPages(r.item.text, pageTexts, q.page ?? r.item.source.page)) flags.push('text_not_in_source');
    if (!r.item.text.trim()) flags.push('empty_text');
    if ((r.item.confidence ?? 1) < LOW_CONFIDENCE) flags.push('low_confidence');
    checks.set(r.id, { quoteVerified: q.verified, page: q.page ?? r.item.source.page, flags: uniq(flags) });
  }

  // Codes of items by temp id within a window, so parent_temp_id can stand in for a missing parent_code.
  const codeByTemp = new Map<string, string>();
  for (const r of raw) if (r.item.code) codeByTemp.set(`${r.window}:${r.item.temp_id}`, normalizeCode(r.item.code));
  const parentCodeOf = (r: RawItem) => {
    if (r.item.parent_code?.trim()) return normalizeCode(r.item.parent_code);
    if (r.item.parent_temp_id) return codeByTemp.get(`${r.window}:${r.item.parent_temp_id}`) ?? null;
    return null;
  };

  // 2. Requirements: one per code. Overlapping windows propose the same one twice; keep the most complete text.
  const groups = new Map<string, RawItem[]>();
  for (const r of raw) {
    if (r.item.kind !== 'requirement') continue;
    const role = docs.get(r.documentId)?.role ?? 'other';
    if (!REQUIREMENT_ROLES.has(role)) { notFromStandards++; checks.get(r.id)!.flags.push('not_from_standards'); continue; }
    const code = r.item.code?.trim() ? normalizeCode(r.item.code) : null;
    if (!code) { checks.get(r.id)!.flags.push('no_code'); continue; }
    groups.set(code, [...(groups.get(code) ?? []), r]);
  }
  let duplicatesMerged = 0;
  const reqs = new Map<string, MergedRequirement>();
  for (const [code, list] of groups) {
    duplicatesMerged += list.length - 1;
    const score = (r: RawItem) => normalizeQuoteText(r.item.text).length;
    const best = [...list].sort((a, b) => score(b) - score(a) || Number(checks.get(b.id)!.quoteVerified) - Number(checks.get(a.id)!.quoteVerified) || a.seq - b.seq)[0]!;
    const check = checks.get(best.id)!;
    const others = list.filter((r) => r !== best);
    // A longer copy elsewhere means the omission was made up; flags of the shorter copies do not carry over.
    const flags = check.flags.filter((f) => f !== 'possible_omission' || others.every((o) => score(o) <= score(best)));
    reqs.set(code, {
      code,
      parentCode: parentCodeOf(best) ?? list.map(parentCodeOf).find((p) => p) ?? null,
      levelLabel: best.item.level_label?.trim() || list.map((r) => r.item.level_label?.trim()).find((l) => l) || null,
      title: best.item.title?.trim() || list.map((r) => r.item.title?.trim()).find((t) => t) || null,
      text: best.item.text.trim(),
      isAssessable: best.item.is_assessable ?? true,
      documentId: best.documentId,
      page: check.page,
      quote: best.item.source.quote.trim(),
      quoteVerified: check.quoteVerified,
      confidence: Math.max(...list.map((r) => r.item.confidence ?? 0)),
      flags: uniq(flags),
      language: docs.get(best.documentId)?.language ?? 'en',
      seq: Math.min(...list.map((r) => r.seq)),
      depth: 0,
      from: list.map((r) => r.id),
    });
  }

  // 3. Parents by code: a parent is another proposed requirement or one already in the draft; otherwise an orphan.
  let orphanRequirements = 0;
  for (const r of reqs.values()) {
    if (r.parentCode === r.code) r.parentCode = null;
    if (r.parentCode && !reqs.has(r.parentCode) && !existingCodes.has(r.parentCode)) {
      r.flags.push(`orphan:${r.parentCode}`);
      r.parentCode = null;
      orphanRequirements++;
    }
  }
  // Break cycles (a -> b -> a) at the first repeat, and measure depth.
  for (const r of reqs.values()) {
    const seen = new Set<string>([r.code]);
    let depth = 0;
    let at = r;
    while (at.parentCode && reqs.has(at.parentCode)) {
      if (seen.has(at.parentCode)) { at.flags.push('parent_cycle'); at.parentCode = null; break; }
      seen.add(at.parentCode);
      at = reqs.get(at.parentCode)!;
      depth++;
    }
    r.depth = depth + (at.parentCode && existingCodes.has(at.parentCode) ? 1 : 0);
  }

  // 4. Notes: attached to a requirement by code; the same note seen twice is kept once (the longer copy).
  const noteGroups = new Map<string, RawItem[]>();
  let orphanNotes = 0;
  const known = (code: string) => reqs.has(code) || existingCodes.has(code);
  for (const r of raw) {
    if (r.item.kind !== 'note') continue;
    const role = docs.get(r.documentId)?.role ?? 'other';
    if (!NOTE_ROLES.has(role)) { checks.get(r.id)!.flags.push('not_from_standards'); continue; }
    const parent = parentCodeOf(r);
    if (!parent || !known(parent)) { orphanNotes++; checks.get(r.id)!.flags.push('orphan_note'); continue; }
    const key = `${parent}\u0000${normalizeQuoteText(r.item.text).slice(0, 120)}`;
    noteGroups.set(key, [...(noteGroups.get(key) ?? []), r]);
  }
  const notes: MergedNote[] = [];
  for (const list of noteGroups.values()) {
    const best = [...list].sort((a, b) => b.item.text.length - a.item.text.length || a.seq - b.seq)[0]!;
    const check = checks.get(best.id)!;
    const flags = [...check.flags];
    let authority = best.item.authority ?? 'ai_suggested';
    // DEC-006 / DEC-022: "required" only with a verified quote; otherwise it is the AI's suggestion, flagged.
    if (authority === 'required' && !check.quoteVerified) { authority = 'ai_suggested'; flags.push('required_unverified'); }
    if (!best.item.authority) flags.push('ambiguous_authority');
    notes.push({
      requirementCode: parentCodeOf(best)!,
      type: best.item.note_type ?? 'guidance',
      authority,
      text: best.item.text.trim(),
      documentId: best.documentId,
      page: check.page,
      quote: best.item.source.quote.trim(),
      quoteVerified: check.quoteVerified,
      confidence: best.item.confidence ?? null,
      flags: uniq(flags),
      seq: Math.min(...list.map((r) => r.seq)),
      from: list.map((r) => r.id),
    });
  }

  const requirements = [...reqs.values()].sort((a, b) => a.depth - b.depth || a.seq - b.seq);
  for (const c of checks.values()) c.flags = uniq(c.flags);
  return { requirements, notes: notes.sort((a, b) => a.seq - b.seq), checks, orphanRequirements, orphanNotes, notFromStandards, duplicatesMerged };
}

/** Pages of a document cut into windows of `size` pages that overlap by `overlap` (PRD 15.1: ~8 pages, 1 overlap). */
export function pageWindows(pageNos: number[], size = 8, overlap = 1): number[][] {
  const sorted = [...new Set(pageNos)].sort((a, b) => a - b);
  if (sorted.length <= size) return sorted.length ? [sorted] : [];
  const step = Math.max(1, size - overlap);
  const out: number[][] = [];
  for (let i = 0; i < sorted.length; i += step) {
    out.push(sorted.slice(i, i + size));
    if (i + size >= sorted.length) break;
  }
  return out;
}

/** Pages as the prompts present them: each one headed by its real page number. */
export function formatPages(pages: { pageNo: number; text: string }[], maxCharsPerPage = Infinity): string {
  return pages.map((p) => `=== Page ${p.pageNo} ===\n${p.text.length > maxCharsPerPage ? `${p.text.slice(0, maxCharsPerPage)} […]` : p.text}`).join('\n\n');
}
