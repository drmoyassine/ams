// The deterministic gap finder of the check-and-recover passes (PRD 15, step D). Pure: no database, no AI.
//
// After the extraction (and after each recovery round) the merged result is checked for what is likely missing or
// doubtful. Nothing here knows any accreditor: everything is derived from the codes themselves, the numbering examples
// the structure stage found, and the stored page text.
//
//   numbering_gap     siblings 2.1, 2.2, 2.4: 2.3 is possibly missing (numbers, letters, roman numerals, any separators,
//                     Arabic-Indic digits). A hole of more than MAX_SKIP codes is read as a deliberate jump, not a gap.
//   missing_parent    a requirement or note names a parent code that was never extracted (its children are orphans).
//   unverified_quote  a requirement or note whose quote was not found on the page, or whose wording is not on it.
//   low_confidence    a requirement the model itself was unsure about (below LOW_CONFIDENCE), quote found.
//   uncovered_page    a substantive page of a standards document that no checked item cites (see substantivePage).
//   conflict          the same code with materially different wording in two documents or windows. Flagged for a
//                     person; the recovery passes never try to resolve it.
import { bestSubstringSimilarity, normalizeQuoteText, QUOTE_MATCH_THRESHOLD, type PageTexts } from '../quote-match.js';
import type { AnalysisGapKind } from '@ams/shared';
import { LOW_CONFIDENCE, noteFingerprint, normalizeCode, REQUIREMENT_ROLES, type DocInfo, type MergeResult, type RawItem } from './merge.js';

/** The most consecutive codes a hole may miss and still count as a gap (1.2 then 1.9 is a jump, not six gaps). */
export const MAX_SKIP = 3;
/** The most pages one recovery question looks at. */
export const MAX_QUESTION_PAGES = 6;
/** A page needs at least this many words to count as substantive. */
export const SUBSTANTIVE_WORDS = 40;

// ---- Codes ---------------------------------------------------------------------------------------------------------

export type PartKind = 'number' | 'letter' | 'roman';
export interface CodePart {
  /** The token as printed (digits in their own script). */
  raw: string;
  /** Where it starts in the code (NFC), so a sibling's code can be written by replacing it. */
  start: number;
  /** What the token can be read as: digits are numbers; "b" a letter; "iv" roman; "i", "v", "x"… either. */
  kinds: PartKind[];
  /** Value as a number (digits), as a letter (a = 1) and as a roman numeral, where it can be read so. */
  num: number | null;
  letter: number | null;
  roman: number | null;
  script: 'ascii' | 'arabic' | 'persian' | null;
  upper: boolean;
}
export interface ParsedCode {
  code: string;
  /** Words before the numbering, lower case ("cfr", "criterion", "standard"); part of the sibling group. */
  prefix: string;
  parts: CodePart[];
}

const ROMAN = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;
const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
function romanValue(s: string): number | null {
  const t = s.toLowerCase();
  if (!t || t.length > 8 || !ROMAN.test(t)) return null;
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const v = ROMAN_VALUES[t[i]!]!;
    const next = ROMAN_VALUES[t[i + 1] ?? ''] ?? 0;
    total += v < next ? -v : v;
  }
  return total;
}
function toRoman(n: number, upper: boolean): string {
  const table: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return upper ? out.toUpperCase() : out;
}
const asciiDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
const digitScript = (s: string): CodePart['script'] => (/[٠-٩]/.test(s) ? 'arabic' : /[۰-۹]/.test(s) ? 'persian' : 'ascii');
function inScript(n: number, script: CodePart['script'], width: number): string {
  const s = String(n).padStart(width, '0');
  if (script === 'arabic') return s.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  if (script === 'persian') return s.replace(/\d/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
  return s;
}

/**
 * Splits a code into its prefix words and its numbering parts. Separators do not matter ("2.4(a)", "2-4-a" and "2.4.a"
 * are the same parts). Returns null for a code with words after the numbering starts, which is not a pattern to follow.
 */
export function parseCode(code: string): ParsedCode | null {
  const c = code.normalize('NFC');
  const prefix: string[] = [];
  const parts: CodePart[] = [];
  for (const m of c.matchAll(/[0-9٠-٩۰-۹]+|\p{L}+/gu)) {
    const raw = m[0];
    const start = m.index;
    if (/^[0-9٠-٩۰-۹]+$/.test(raw)) {
      parts.push({ raw, start, kinds: ['number'], num: Number(asciiDigits(raw)), letter: null, roman: null, script: digitScript(raw), upper: false });
      continue;
    }
    const lower = raw.toLowerCase();
    const caseConsistent = raw === lower || raw === raw.toUpperCase();
    const kinds: PartKind[] = [];
    const letter = raw.length === 1 && /[a-z]/.test(lower) ? lower.charCodeAt(0) - 96 : null;
    if (letter !== null) kinds.push('letter');
    const roman = caseConsistent ? romanValue(lower) : null;
    if (roman !== null) kinds.push('roman');
    if (!kinds.length) {
      if (parts.length) return null;
      prefix.push(lower);
      continue;
    }
    // A word before any number that only happens to be a valid roman numeral ("mix") is still a part; rare enough.
    parts.push({ raw, start, kinds, num: null, letter, roman, script: null, upper: raw !== lower });
  }
  if (!parts.length) return null;
  return { code: c, prefix: prefix.join(' '), parts };
}

/** The numbering kinds the structure stage's examples show, by (number of parts, position): to read "i" or "c" right. */
export function numberingHints(numbering: { examples: string[] }[] | undefined): Map<string, Set<PartKind>> {
  const hints = new Map<string, Set<PartKind>>();
  for (const level of numbering ?? []) {
    for (const ex of level.examples) {
      const p = parseCode(ex);
      if (!p) continue;
      p.parts.forEach((part, i) => {
        // Only unambiguous examples teach anything.
        if (part.kinds.length !== 1) return;
        const k = `${p.parts.length}:${i}`;
        if (!hints.has(k)) hints.set(k, new Set());
        hints.get(k)!.add(part.kinds[0]!);
      });
    }
  }
  return hints;
}

const canonical = (p: CodePart) => (p.num !== null ? String(p.num) : p.raw.toLowerCase());
/** Siblings share a prefix, the same parent parts, and the same number of parts. */
export const siblingGroup = (p: ParsedCode) => `${p.prefix}|${p.parts.slice(0, -1).map(canonical).join('.')}|${p.parts.length}`;

interface Sibling { code: string; parsed: ParsedCode; documentId: string | null; page: number | null; seq: number | null }

export interface NumberingGap {
  /** The missing code, written like its neighbour ("2.3", "2.4(c)", "IV", "٢٫٣"). */
  code: string;
  prev: Sibling | null;
  next: Sibling | null;
}

/**
 * Holes in the numbering of sibling codes. `codes` are all codes known in the version (extracted, already in the draft,
 * or deleted by a person); only those with a page can anchor a question, so a hole needs at least one such neighbour.
 */
export function findNumberingGaps(codes: Sibling[], hints: Map<string, Set<PartKind>> = new Map()): NumberingGap[] {
  const groups = new Map<string, Sibling[]>();
  for (const s of codes) {
    const g = siblingGroup(s.parsed);
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  const out: NumberingGap[] = [];
  for (const list of groups.values()) {
    const n = list[0]!.parsed.parts.length;
    const last = (s: Sibling) => s.parsed.parts[n - 1]!;
    const numbers = list.filter((s) => last(s).kinds[0] === 'number');
    const alpha = list.filter((s) => last(s).kinds[0] !== 'number');
    const series: { items: Sibling[]; value: (s: Sibling) => number | null; kind: PartKind }[] = [{ items: numbers, value: (s) => last(s).num, kind: 'number' }];
    if (alpha.length) {
      const pureRoman = alpha.some((s) => last(s).kinds.length === 1 && last(s).kinds[0] === 'roman');
      const pureLetter = alpha.some((s) => last(s).kinds.length === 1 && last(s).kinds[0] === 'letter');
      const hint = hints.get(`${n}:${n - 1}`);
      let kind: PartKind | null = null;
      if (pureRoman && pureLetter) kind = null; // mixed: not a pattern to follow
      else if (pureRoman) kind = 'roman';
      else if (pureLetter) kind = 'letter';
      else kind = hint?.has('roman') && !hint.has('letter') ? 'roman' : 'letter';
      if (kind) series.push({ items: alpha, value: (s) => (kind === 'roman' ? last(s).roman : last(s).letter), kind });
    }
    for (const { items, value, kind } of series) {
      const byValue = new Map<number, Sibling>();
      for (const s of items) {
        const v = value(s);
        if (v === null) continue;
        const had = byValue.get(v);
        // Prefer the copy with a page (an extracted item) over a bare code.
        if (!had || (had.page === null && s.page !== null)) byValue.set(v, s);
      }
      const values = [...byValue.keys()].sort((a, b) => a - b);
      if (!values.length) continue;
      const write = (near: Sibling, v: number) => {
        const p = last(near);
        // Zero-padded numbering ("01", "02") keeps its width.
        const width = p.raw.length > 1 && asciiDigits(p.raw).startsWith('0') ? p.raw.length : 1;
        const text = kind === 'number' ? inScript(v, p.script, width)
          : kind === 'letter' ? (p.upper ? String.fromCharCode(64 + v) : String.fromCharCode(96 + v))
            : toRoman(v, p.upper);
        return near.parsed.code.slice(0, p.start) + text + near.parsed.code.slice(p.start + p.raw.length);
      };
      const holes: [number, number][] = [];
      // A leading hole: siblings start at 2, 3 or 4 (b, c, d…): the ones before are possibly missing. Only for a series
      // (two or more siblings): a lone "Standard 2" may be all a document covers.
      if (values.length >= 2 && values[0]! > 1 && values[0]! - 1 <= MAX_SKIP) holes.push([0, values[0]!]);
      for (let i = 1; i < values.length; i++) {
        const missing = values[i]! - values[i - 1]! - 1;
        if (missing >= 1 && missing <= MAX_SKIP) holes.push([values[i - 1]!, values[i]!]);
      }
      for (const [a, b] of holes) {
        const prev = a > 0 ? byValue.get(a)! : null;
        const next = byValue.get(b)!;
        if ((prev?.page ?? null) === null && next.page === null) continue;
        for (let v = a + 1; v < b; v++) out.push({ code: write(prev ?? next, v), prev, next });
      }
    }
  }
  return out;
}

// ---- Pages ---------------------------------------------------------------------------------------------------------

/**
 * Is a page worth asking about? A cheap heuristic, no AI: it must have enough words (SUBSTANTIVE_WORDS; a blank,
 * cover or divider page has few), and it must not look like a table of contents or an index, which list headings with
 * page numbers: most of its lines end in a page number (often after dot leaders), or it opens with a contents/index
 * heading. Such pages repeat requirement codes and titles but state nothing.
 */
export function substantivePage(text: string): { substantive: boolean; why: string } {
  const t = text.normalize('NFC');
  const words = t.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  if (words < SUBSTANTIVE_WORDS) return { substantive: false, why: `only ${words} words` };
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const endsInPage = lines.filter((l) => /(\.{2,}|…|\s)\s*[0-9٠-٩۰-۹ivxlc]{1,5}$/i.test(l)).length;
  if (lines.length >= 4 && endsInPage / lines.length >= 0.4) return { substantive: false, why: 'most lines end in a page number (contents or index)' };
  if (/^(table of contents|contents|index|المحتويات|فهرس)/i.test(lines[0] ?? '')) return { substantive: false, why: 'a contents or index page' };
  return { substantive: true, why: `${words} words` };
}

// ---- The finder ----------------------------------------------------------------------------------------------------

export interface FoundGap {
  /** What the gap is about, stable across rounds: req:<code>, note:<code>:<fingerprint>, page:<doc>:<n>, conflict:<code>. */
  key: string;
  kind: AnalysisGapKind;
  code: string | null;
  documentId: string | null;
  page: number | null;
  detail: string;
  /** The pages of documentId a recovery question would show (empty: nothing to ask, e.g. a conflict). */
  pages: number[];
  /** Reading order for anything recovered for it (between its neighbours). */
  anchorSeq: number;
  /** The item as proposed, for a re-cite question. */
  item?: { kind: 'requirement' | 'note'; code: string; text: string; quote: string };
  /** A conflict: the two wordings, kept so the report can show them side by side. */
  variants?: { documentId: string; page: number; text: string }[];
}

export interface GapFinderInput {
  merged: MergeResult;
  raw: RawItem[];
  /** Page texts by document (every document the run read). */
  pages: ReadonlyMap<string, PageTexts>;
  docs: ReadonlyMap<string, DocInfo>;
  /** Codes in the draft that this run did not propose (a person's rows, earlier runs') and codes a person deleted. */
  knownCodes: ReadonlySet<string>;
  /** Codes of rows a person made, edited or reviewed: the run never changes them, so they are never asked about. */
  lockedCodes?: ReadonlySet<string>;
  /** Pages that count as covered although no kept item cites them (an item a person deleted was there). */
  coveredPages?: { documentId: string; page: number }[];
  numbering?: { examples: string[] }[];
}

/** Pages of a document from `from` to `to`, those that exist, at most MAX_QUESTION_PAGES (centred on `focus`). */
export function pageRange(pages: PageTexts | undefined, from: number, to: number, focus = from): number[] {
  const all = [...(pages?.keys() ?? [])].filter((n) => n >= Math.min(from, to) && n <= Math.max(from, to)).sort((a, b) => a - b);
  if (all.length <= MAX_QUESTION_PAGES) return all;
  const at = Math.max(0, all.findIndex((n) => n >= focus));
  const start = Math.min(Math.max(0, at - Math.floor(MAX_QUESTION_PAGES / 2)), all.length - MAX_QUESTION_PAGES);
  return all.slice(start, start + MAX_QUESTION_PAGES);
}

const STEP = 0.001;

/** Every gap in a run's merged result. Deterministic: the same input gives the same gaps in the same order. */
export function findGaps(input: GapFinderInput): FoundGap[] {
  const { merged, raw, pages, docs } = input;
  const out: FoundGap[] = [];
  const reqs = merged.requirements;
  const byCode = new Map(reqs.map((r) => [r.code, r]));
  const rawById = new Map(raw.map((r) => [r.id, r]));

  // 1. Numbering holes among siblings (extracted codes with their pages; known codes without).
  const siblings: Sibling[] = [];
  for (const r of reqs) {
    const parsed = parseCode(r.code);
    if (parsed) siblings.push({ code: r.code, parsed, documentId: r.documentId, page: r.page, seq: r.seq });
  }
  for (const code of input.knownCodes) {
    if (byCode.has(code)) continue;
    const parsed = parseCode(code);
    if (parsed) siblings.push({ code, parsed, documentId: null, page: null, seq: null });
  }
  const knownKeys = new Set(siblings.map((s) => `${siblingGroup(s.parsed)}#${s.parsed.parts.map(canonical).join('.')}`));
  for (const g of findNumberingGaps(siblings, numberingHints(input.numbering))) {
    const parsed = parseCode(g.code);
    if (!parsed || knownKeys.has(`${siblingGroup(parsed)}#${parsed.parts.map(canonical).join('.')}`)) continue;
    const anchor = g.prev?.page != null ? g.prev : g.next!;
    const doc = anchor.documentId!;
    const from = g.prev?.page != null && g.prev.documentId === doc ? g.prev.page : Math.max(1, (g.next!.page ?? 1) - 1);
    const to = g.next?.page != null && g.next.documentId === doc ? g.next.page : from + 1;
    const where = g.prev && g.next ? `between ${g.prev.code} and ${g.next.code}` : g.next ? `before ${g.next.code}` : `after ${g.prev!.code}`;
    out.push({
      key: `req:${normalizeCode(g.code)}`, kind: 'numbering_gap', code: g.code, documentId: doc, page: anchor.page, detail: where,
      pages: pageRange(pages.get(doc), from, to, anchor.page ?? from),
      anchorSeq: g.prev?.seq != null ? g.prev.seq + STEP * 10 : (g.next?.seq ?? 0) - STEP * 10,
    });
  }

  // 2. Parents referenced but never extracted (their children are orphans).
  const missingParents = new Map<string, { child: string; documentId: string; page: number; seq: number }>();
  for (const r of reqs) {
    const orphan = r.flags.find((f) => f.startsWith('orphan:'));
    if (orphan) {
      const code = orphan.slice('orphan:'.length);
      if (!missingParents.has(code)) missingParents.set(code, { child: r.code, documentId: r.documentId, page: r.page, seq: r.seq });
    }
  }
  for (const n of merged.orphanNoteRefs) {
    if (!missingParents.has(n.code)) missingParents.set(n.code, { child: `a note on page ${n.page}`, ...n });
  }
  for (const [code, c] of missingParents) {
    if (input.knownCodes.has(code) || out.some((g) => g.key === `req:${code}`)) continue;
    out.push({
      key: `req:${code}`, kind: 'missing_parent', code, documentId: c.documentId, page: c.page, detail: `named as the parent of ${c.child}`,
      pages: pageRange(pages.get(c.documentId), c.page - 2, c.page, c.page), anchorSeq: c.seq - STEP * 10,
    });
  }

  // 3 and 4. Items whose quote or wording did not check out, then those the model was unsure about.
  for (const r of reqs) {
    if (input.lockedCodes?.has(r.code)) continue;
    const textMissing = r.flags.includes('text_not_in_source');
    const confidences = r.from.map((id) => rawById.get(id)?.item.confidence).filter((c): c is number => c != null);
    const low = confidences.length > 0 && Math.max(...confidences) < LOW_CONFIDENCE;
    if (r.quoteVerified && !textMissing && !low) continue;
    const kind: AnalysisGapKind = !r.quoteVerified || textMissing ? 'unverified_quote' : 'low_confidence';
    out.push({
      key: `req:${r.code}`, kind, code: r.code, documentId: r.documentId, page: r.page,
      detail: !r.quoteVerified ? 'its quote was not found on the page' : textMissing ? 'its wording is not on the page' : `confidence ${Math.max(...confidences)}`,
      pages: pageRange(pages.get(r.documentId), r.page - 1, r.page + 1, r.page), anchorSeq: r.seq,
      item: { kind: 'requirement', code: r.code, text: r.text, quote: r.quote },
    });
  }
  for (const n of merged.notes) {
    if (n.quoteVerified || input.lockedCodes?.has(n.requirementCode)) continue;
    out.push({
      key: `note:${n.requirementCode}:${noteFingerprint(n.text)}`, kind: 'unverified_quote', code: n.requirementCode, documentId: n.documentId, page: n.page,
      detail: 'a note whose quote was not found on the page', pages: pageRange(pages.get(n.documentId), n.page - 1, n.page + 1, n.page), anchorSeq: n.seq,
      item: { kind: 'note', code: n.requirementCode, text: n.text, quote: n.quote },
    });
  }

  // 5. Substantive pages of the standards documents that no checked item cites. A page is also covered when it only
  // continues the wording of an item that starts on the page before (its opening words are in that item's text).
  const cited = new Map<string, Set<number>>();
  const textsFrom = new Map<string, string[]>();
  for (const c of input.coveredPages ?? []) {
    if (!cited.has(c.documentId)) cited.set(c.documentId, new Set());
    cited.get(c.documentId)!.add(c.page);
  }
  for (const r of raw) {
    const check = merged.checks.get(r.id);
    if (!check?.quoteVerified) continue;
    if (!cited.has(r.documentId)) cited.set(r.documentId, new Set());
    cited.get(r.documentId)!.add(check.page);
    const k = `${r.documentId}:${check.page}`;
    textsFrom.set(k, [...(textsFrom.get(k) ?? []), normalizeQuoteText(r.item.text)]);
  }
  for (const [docId, texts] of pages) {
    if (!REQUIREMENT_ROLES.has(docs.get(docId)?.role ?? '')) continue;
    const seqs = raw.filter((r) => r.documentId === docId);
    for (const [pageNo, text] of [...texts].sort((a, b) => a[0] - b[0])) {
      if (cited.get(docId)?.has(pageNo)) continue;
      const opening = normalizeQuoteText(text).slice(0, 60);
      if (opening.length >= 20 && (textsFrom.get(`${docId}:${pageNo - 1}`) ?? []).some((t) => t.includes(opening))) continue;
      if (!substantivePage(text).substantive) continue;
      const before = seqs.filter((r) => (merged.checks.get(r.id)?.page ?? r.item.source.page) < pageNo).map((r) => r.seq);
      out.push({
        key: `page:${docId}:${pageNo}`, kind: 'uncovered_page', code: null, documentId: docId, page: pageNo, detail: substantivePage(text).why,
        pages: pageRange(texts, pageNo - 1, pageNo + 1, pageNo),
        anchorSeq: before.length ? Math.max(...before) + STEP * 10 : Math.min(0, ...seqs.map((r) => r.seq)) - STEP * 10,
      });
    }
  }

  // 6. Conflicts: the same code, materially different wording, from two documents or windows. One copy containing the
  // other (a window cut it short) is not a conflict.
  const groups = new Map<string, RawItem[]>();
  for (const r of reqs) groups.set(r.code, r.from.map((id) => rawById.get(id)!).filter(Boolean));
  for (const [code, list] of groups) {
    let found: [RawItem, RawItem] | null = null;
    for (let i = 0; i < list.length && !found; i++) {
      for (let j = i + 1; j < list.length && !found; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.documentId === b.documentId && a.window === b.window) continue;
        const ta = normalizeQuoteText(a.item.text);
        const tb = normalizeQuoteText(b.item.text);
        if (!ta || !tb || ta.includes(tb) || tb.includes(ta)) continue;
        const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
        if (bestSubstringSimilarity(short, long) < QUOTE_MATCH_THRESHOLD) found = [a, b];
      }
    }
    if (!found) continue;
    const [a, b] = found;
    const pa = merged.checks.get(a.id)?.page ?? a.item.source.page;
    const pb = merged.checks.get(b.id)?.page ?? b.item.source.page;
    out.push({
      key: `conflict:${code}`, kind: 'conflict', code, documentId: a.documentId, page: pa,
      detail: a.documentId === b.documentId ? `different wording on pages ${pa} and ${pb}` : `different wording in two documents (pages ${pa} and ${pb})`,
      pages: [], anchorSeq: a.seq,
      variants: [{ documentId: a.documentId, page: pa, text: a.item.text }, { documentId: b.documentId, page: pb, text: b.item.text }],
    });
  }
  return out;
}
