// Applicability tags (PRD 7.3). `applies_when` is an object of tag lists: a requirement applies when, for every key
// present, the subject matches at least one value. Empty or null means it always applies. No rule engine, and no
// key ever refers to an accreditor (DEC-002).
import type { z } from 'zod';
import type { AppliesWhenSchema } from '@ams/shared';

export type AppliesWhen = z.infer<typeof AppliesWhenSchema>;

/** What a requirement is matched against: the engagement's subject and kind. */
export interface Subject {
  scope: 'institution' | 'program';
  /** Programs only. */
  degreeLevel?: string | null;
  /** Programs only. */
  programTags?: readonly string[];
  engagementKind: 'initial' | 'reaffirmation';
}

export function matchesAppliesWhen(rule: AppliesWhen | undefined, subject: Subject): boolean {
  if (!rule) return true;
  const tags = new Set(subject.programTags ?? []);
  const checks: [readonly string[] | undefined, (v: string) => boolean][] = [
    [rule.scope, (v) => v === subject.scope],
    [rule.degree_level, (v) => subject.degreeLevel === v],
    [rule.program_tags, (v) => tags.has(v)],
    [rule.engagement_kind, (v) => v === subject.engagementKind],
  ];
  // A key with an empty list constrains nothing, like an absent key.
  return checks.every(([values, test]) => !values || values.length === 0 || values.some(test));
}

export interface TreeRequirement {
  id: string;
  parentId: string | null;
  appliesWhen: AppliesWhen | undefined;
}

/**
 * Applicability for every requirement in a tree. A requirement under one that does not apply does not apply either:
 * a Program Criteria section for one discipline takes its sub-items with it.
 */
export function applicabilityByRequirement(reqs: readonly TreeRequirement[], subject: Subject): Map<string, boolean> {
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const out = new Map<string, boolean>();
  const visit = (r: TreeRequirement, seen: Set<string>): boolean => {
    const known = out.get(r.id);
    if (known !== undefined) return known;
    let ok = matchesAppliesWhen(r.appliesWhen, subject);
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    if (ok && parent && !seen.has(parent.id)) ok = visit(parent, new Set([...seen, r.id]));
    out.set(r.id, ok);
    return ok;
  };
  for (const r of reqs) visit(r, new Set([r.id]));
  return out;
}
