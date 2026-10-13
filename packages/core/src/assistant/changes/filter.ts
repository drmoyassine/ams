// The filter engine: which requirements of a version a condition set picks. Pure (rows in, rows out), shared by the recipes that
// change things and by the read tool `find_requirements`, so "what would this touch" is answered by the same code that touches.
import { treeOrder, type RequirementFilter } from '@ams/shared';
import { normalizeQuoteText } from '../../framework/quote-match.js';
import { compileRegex } from './regex.js';

/** The part of a requirement row the rules read. */
export interface ReqRow {
  id: string;
  parentId: string | null;
  code: string;
  levelLabel: string;
  title: string;
  officialText: string | null;
  translationEn: string | null;
  language: string;
  isAssessable: boolean;
  displayOrder: number;
  origin: string;
  sourceQuote: string | null;
  quoteVerified: boolean;
  editedByPerson: boolean;
}

/** A tree of rows with the lookups the filters need. Cheap to build; rebuilt after rows change. */
export class RowIndex {
  readonly byId = new Map<string, ReqRow>();
  readonly children = new Map<string | null, string[]>();
  readonly order: string[];
  private readonly depthOf = new Map<string, number>();
  constructor(readonly rows: readonly ReqRow[], readonly noteCounts: ReadonlyMap<string, number> = new Map()) {
    for (const r of rows) this.byId.set(r.id, r);
    this.order = treeOrder(rows);
    for (const id of this.order) {
      const r = this.byId.get(id)!;
      const k = r.parentId ?? null;
      this.children.set(k, [...(this.children.get(k) ?? []), id]);
    }
    const depth = (id: string, guard = 0): number => {
      const hit = this.depthOf.get(id);
      if (hit !== undefined) return hit;
      const p = this.byId.get(id)?.parentId;
      const d = p && guard < 64 ? depth(p, guard + 1) + 1 : 0;
      this.depthOf.set(id, d);
      return d;
    };
    for (const r of rows) depth(r.id);
  }
  depth(id: string): number { return this.depthOf.get(id) ?? 0; }
  /** The row and everything under it, in tree order. */
  subtree(id: string): string[] {
    const out: string[] = [];
    const walk = (x: string) => { out.push(x); for (const c of this.children.get(x) ?? []) walk(c); };
    if (this.byId.has(id)) walk(id);
    return out;
  }
  descendants(id: string): string[] { return this.subtree(id).slice(1); }
  hasAncestorIn(id: string, set: ReadonlySet<string>): boolean {
    for (let p = this.byId.get(id)?.parentId; p; p = this.byId.get(p)?.parentId) if (set.has(p)) return true;
    return false;
  }
  byCode(code: string): ReqRow | undefined {
    const c = looseCode(code);
    return this.rows.find((r) => r.code === code) ?? this.rows.find((r) => looseCode(r.code) === c);
  }
}

/** A code compared loosely: NFC, case, spacing and separators ignored ("1-1" , "1.1" and "1 . 1" are the same). */
export const looseCode = (code: string): string => code.normalize('NFC').toLowerCase().replace(/\s+/g, '').replace(/[.\-_/\\]+/g, '.').replace(/\.+$/g, '');

const norm = (s: string | null | undefined) => normalizeQuoteText(s ?? '');
const blank = (s: string | null | undefined) => !s || !s.trim();
const compact = (s: string) => s.replace(/\s+/g, '').toLowerCase();

export interface FilterOutcome { rows: ReqRow[]; problems: string[] }

/**
 * Applies a filter. Returns the matching rows in tree order. A filter that names something that does not exist (a parent code,
 * a bad pattern) reports it in `problems` and matches nothing, instead of silently matching everything.
 */
export function matchFilter(index: RowIndex, f: RequirementFilter | undefined): FilterOutcome {
  const problems: string[] = [];
  const filter = f ?? {};
  const picks: Set<string>[] = [];
  const narrow = (ids: Iterable<string>) => { picks.push(new Set(ids)); };

  if (filter.ids) narrow(filter.ids.filter((id) => index.byId.has(id)));
  if (filter.parentId !== undefined) narrow(index.children.get(filter.parentId) ?? []);
  if (filter.parentCode !== undefined) {
    const p = index.byCode(filter.parentCode);
    if (!p) problems.push(`there is no item with the code ${filter.parentCode} (parentCode)`); else narrow(index.children.get(p.id) ?? []);
  }
  if (filter.underId !== undefined) {
    if (!index.byId.has(filter.underId)) problems.push('the item named in underId is not in this version'); else narrow(index.descendants(filter.underId));
  }
  if (filter.underCode !== undefined) {
    const p = index.byCode(filter.underCode);
    if (!p) problems.push(`there is no item with the code ${filter.underCode} (underCode)`); else narrow(index.descendants(p.id));
  }
  let pattern: RegExp | null = null;
  if (filter.codePattern !== undefined) {
    const c = compileRegex(filter.codePattern, 'u');
    if (!c.ok) problems.push(c.message); else pattern = c.re;
  }
  if (problems.length) return { rows: [], problems };

  const levels = filter.level === undefined ? null : new Set((Array.isArray(filter.level) ? filter.level : [filter.level]).map(norm));
  const codes = filter.codeEquals ? new Set(filter.codeEquals.map(looseCode)) : null;
  const prefix = filter.codeStartsWith !== undefined ? looseCode(filter.codeStartsWith) : null;
  const text = filter.textContains !== undefined ? norm(filter.textContains) : null;
  const title = filter.titleContains !== undefined ? norm(filter.titleContains) : null;
  const desc = filter.descriptionContains !== undefined ? norm(filter.descriptionContains) : null;
  const seenLoose = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of index.order) {
    const k = looseCode(index.byId.get(id)!.code);
    if (seenLoose.has(k)) duplicates.add(id); else seenLoose.add(k);
  }

  const out: ReqRow[] = [];
  for (const id of index.order) {
    if (picks.some((p) => !p.has(id))) continue;
    const r = index.byId.get(id)!;
    if (levels && !levels.has(norm(r.levelLabel))) continue;
    if (filter.depth !== undefined && index.depth(id) !== filter.depth) continue;
    if (codes && !codes.has(looseCode(r.code))) continue;
    if (prefix !== null) { const c = looseCode(r.code); if (!(c === prefix || c.startsWith(`${prefix}.`))) continue; }
    if (pattern && !pattern.test(r.code.normalize('NFC'))) continue;
    if (text !== null && !`${norm(r.title)} ${norm(r.officialText)}`.includes(text)) continue;
    if (title !== null && !norm(r.title).includes(title)) continue;
    if (desc !== null && !norm(r.officialText).includes(desc)) continue;
    if (filter.titleIsCode !== undefined && (compact(r.title) === compact(r.code)) !== filter.titleIsCode) continue;
    if (filter.descriptionEmpty !== undefined && blank(r.officialText) !== filter.descriptionEmpty) continue;
    const kids = (index.children.get(id) ?? []).length;
    if (filter.hasChildren !== undefined && (kids > 0) !== filter.hasChildren) continue;
    const notes = index.noteCounts.get(id) ?? 0;
    if (filter.hasNotes !== undefined && (notes > 0) !== filter.hasNotes) continue;
    if (filter.emptyHeading !== undefined && (blank(r.officialText) && kids === 0 && notes === 0) !== filter.emptyHeading) continue;
    if (filter.duplicateCode !== undefined && duplicates.has(id) !== filter.duplicateCode) continue;
    if (filter.isAssessable !== undefined && r.isAssessable !== filter.isAssessable) continue;
    if (filter.language !== undefined && r.language.toLowerCase() !== filter.language.toLowerCase()) continue;
    if (filter.quoteNotFound !== undefined && (!!r.sourceQuote && !r.quoteVerified) !== filter.quoteNotFound) continue;
    if (filter.editedByPerson !== undefined && r.editedByPerson !== filter.editedByPerson) continue;
    if (filter.origin !== undefined && r.origin !== filter.origin) continue;
    out.push(r);
  }
  return { rows: out, problems };
}
