// Pre- and co-requisites (DEC-046, step 3): an expression of course ids, AND of OR-groups. `[['MATH 101'], ['PHYS 101', 'PHYS 111']]` reads "MATH 101
// and (PHYS 101 or PHYS 111)". Written as text with ; (or , or a new line) for AND and | (or the word "or") for OR: "MATH 101; PHYS 101 | PHYS 111".

/** AND of OR-groups of course ids: every group must be satisfied, by any one of its courses. */
export type Requisites = string[][];

const norm = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toUpperCase();

/**
 * Reads the text into groups of course ids. A code that is not a course (`resolve` returns undefined) is reported in `unknown` and left out;
 * a group that becomes empty is dropped. A course named twice is kept once, in the first group that names it.
 */
export function parseRequisites(text: string, resolve: (code: string) => string | undefined): { groups: Requisites; unknown: string[] } {
  const groups: Requisites = []; const unknown: string[] = []; const seen = new Set<string>();
  for (const part of text.split(/[;,\n]/)) {
    const group: string[] = [];
    for (const raw of part.split(/\||\bor\b/i)) {
      const code = norm(raw);
      if (!code) continue;
      const id = resolve(code);
      if (!id) { unknown.push(code); continue; }
      if (!seen.has(id)) { seen.add(id); group.push(id); }
    }
    if (group.length) groups.push(group);
  }
  return { groups, unknown };
}

/** The groups as text, in the syntax `parseRequisites` reads: "MATH 101; PHYS 101 | PHYS 111". */
export function formatRequisites(groups: Requisites, codeOf: (id: string) => string): string {
  return groups.map((g) => g.map(codeOf).filter(Boolean).join(' | ')).filter(Boolean).join('; ');
}

/** The groups as words for a catalog: "MATH 101 and (PHYS 101 or PHYS 111)". */
export function describeRequisites(groups: Requisites, codeOf: (id: string) => string): string {
  const parts = groups.map((g) => g.map(codeOf).filter(Boolean)).filter((g) => g.length);
  return parts.map((g) => (g.length > 1 && parts.length > 1 ? `(${g.join(' or ')})` : g.join(' or '))).join(' and ');
}

/** Every course id in the groups, once. */
export const requisiteIds = (groups: Requisites): string[] => [...new Set(groups.flat())];

/** Older documents list prerequisites and co-requisites as flat ids: each is a group of its own (all required). */
export const groupsOfIds = (ids: string[]): Requisites => [...new Set(ids)].map((id) => [id]);
