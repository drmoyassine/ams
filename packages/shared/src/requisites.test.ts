import { describe, expect, it } from 'vitest';
import { describeRequisites, formatRequisites, groupsOfIds, parseRequisites, requisiteIds } from './requisites.js';
import { SyllabusContentSchema } from './syllabus.js';

const ids = new Map([['MATH 101', 'm1'], ['PHYS 101', 'p1'], ['PHYS 111', 'p2'], ['CHEM 101', 'c1']]);
const resolve = (code: string) => ids.get(code);
const codeOf = (id: string) => [...ids.entries()].find(([, v]) => v === id)?.[0] ?? '';

describe('requisites', () => {
  it('reads ; as and, | and "or" as or, in any case and spacing, and names what is not a course', () => {
    expect(parseRequisites('MATH 101; PHYS 101 | PHYS 111', resolve)).toEqual({ groups: [['m1'], ['p1', 'p2']], unknown: [] });
    expect(parseRequisites('math  101, phys 101 or phys 111\nchem 101', resolve).groups).toEqual([['m1'], ['p1', 'p2'], ['c1']]);
    expect(parseRequisites('MATH 101; GHOST 1 | PHYS 101; GHOST 2', resolve)).toEqual({ groups: [['m1'], ['p1']], unknown: ['GHOST 1', 'GHOST 2'] });
    expect(parseRequisites('MATH 101; MATH 101 | PHYS 101', resolve).groups).toEqual([['m1'], ['p1']]); // a course once, in the first group that names it
    expect(parseRequisites('', resolve)).toEqual({ groups: [], unknown: [] });
  });

  it('writes them back in the same syntax and as words for a catalog', () => {
    const groups = [['m1'], ['p1', 'p2']];
    expect(formatRequisites(groups, codeOf)).toBe('MATH 101; PHYS 101 | PHYS 111');
    expect(parseRequisites(formatRequisites(groups, codeOf), resolve).groups).toEqual(groups);
    expect(describeRequisites(groups, codeOf)).toBe('MATH 101 and (PHYS 101 or PHYS 111)');
    expect(describeRequisites([['p1', 'p2']], codeOf)).toBe('PHYS 101 or PHYS 111');
    expect(describeRequisites([], codeOf)).toBe('');
    expect(requisiteIds([['m1'], ['m1', 'p1']])).toEqual(['m1', 'p1']);
    expect(groupsOfIds(['a', 'b', 'a'])).toEqual([['a'], ['b']]);
  });

  it('reads a syllabus stored with flat ids as groups of one, and keeps new groups', () => {
    const old = SyllabusContentSchema.parse({ info: { titleEn: 'X', prerequisiteIds: ['a', 'b'], corequisiteIds: ['c'] } });
    expect(old.info).toMatchObject({ prerequisites: [['a'], ['b']], corequisites: [['c']], otherRequirements: '' });
    expect(old.info).not.toHaveProperty('prerequisiteIds');
    const now = SyllabusContentSchema.parse({ info: { titleEn: 'X', prerequisites: [['a', 'b']], otherRequirements: 'Junior standing' } });
    expect(now.info).toMatchObject({ prerequisites: [['a', 'b']], corequisites: [], otherRequirements: 'Junior standing' });
  });
});
