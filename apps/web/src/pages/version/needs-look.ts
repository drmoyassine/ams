// "Needs a look": the pure part of the Requirements tab's filter. The server says which requirements and notes have a reason
// to be checked (listReviewItems); this turns that into the chips, their counts, the visible part of the tree and the order
// "Next item that needs a look" walks.
import type { Requirement, ReviewItems } from '../../lib/framework-api';

export type LookKind = 'quoteNotFound' | 'lowConfidence' | 'orphan' | 'suggested';
export const LOOK_KINDS: LookKind[] = ['quoteNotFound', 'lowConfidence', 'orphan', 'suggested'];
export const LOOK_LABEL: Record<LookKind, string> = {
  quoteNotFound: 'Quote not found', lowConfidence: 'Low confidence', orphan: 'No parent found', suggested: 'Suggested by the analysis',
};
export const LOOK_HINT: Record<LookKind, string> = {
  quoteNotFound: 'The quote it cites is not on the stored page.',
  lowConfidence: 'The analysis itself was unsure about it.',
  orphan: 'The analysis named a parent that does not exist, so it sits at the top level.',
  suggested: 'A note the analysis suggested; the source does not say it in so many words.',
};

export interface LookItem { kind: 'requirement' | 'note'; id: string; requirementId: string; reasons: LookKind[] }

/** Flagged requirements and notes in the order of the list: each requirement, then its flagged notes. */
export function lookItems(review: ReviewItems | undefined, ordered: Requirement[]): LookItem[] {
  if (!review) return [];
  const reqs = new Map(review.requirements.map((r) => [r.id, r]));
  const notes = new Map<string, ReviewItems['notes']>();
  for (const n of review.notes) notes.set(n.requirementId, [...(notes.get(n.requirementId) ?? []), n]);
  const out: LookItem[] = [];
  for (const r of ordered) {
    const f = reqs.get(r.id);
    if (f) {
      const reasons = (['quoteNotFound', 'lowConfidence', 'orphan'] as const).filter((k) => f[k]);
      if (reasons.length) out.push({ kind: 'requirement', id: r.id, requirementId: r.id, reasons });
    }
    for (const n of notes.get(r.id) ?? []) {
      const reasons = (['quoteNotFound', 'lowConfidence', 'suggested'] as const).filter((k) => n[k]);
      if (reasons.length) out.push({ kind: 'note', id: n.id, requirementId: r.id, reasons });
    }
  }
  return out;
}

/** How many items (requirements and notes together) have each reason. */
export function lookCounts(items: LookItem[]): Record<LookKind, number> {
  const c: Record<LookKind, number> = { quoteNotFound: 0, lowConfidence: 0, orphan: 0, suggested: 0 };
  for (const i of items) for (const k of i.reasons) c[k]++;
  return c;
}

/**
 * The requirements to show while a filter is on: the ones that have the reason themselves or through a note, and their
 * ancestors (so the tree still makes sense). null: no filter, show everything.
 */
export function visibleRequirements(filter: LookKind | null, items: LookItem[], all: Requirement[]): Set<string> | null {
  if (!filter) return null;
  const byId = new Map(all.map((r) => [r.id, r]));
  const out = new Set<string>();
  for (const i of items) {
    if (!i.reasons.includes(filter)) continue;
    for (let at = byId.get(i.requirementId); at && !out.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) out.add(at.id);
  }
  return out;
}

/** The item after `currentId` in `items` (the first if none is current or it was the last): what "Next" goes to. */
export function nextLookItem(items: LookItem[], currentId: string | null, filter: LookKind | null): LookItem | null {
  const list = filter ? items.filter((i) => i.reasons.includes(filter)) : items;
  if (!list.length) return null;
  const at = currentId ? list.findIndex((i) => i.id === currentId) : -1;
  return list[(at + 1) % list.length]!;
}

/** All descendants of a requirement (not itself). */
export function descendantIds(all: Requirement[], id: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const r of all) if (r.parentId) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r.id]);
  const out = new Set<string>();
  const walk = (x: string) => { for (const k of kids.get(x) ?? []) { if (!out.has(k)) { out.add(k); walk(k); } } };
  walk(id);
  return out;
}
