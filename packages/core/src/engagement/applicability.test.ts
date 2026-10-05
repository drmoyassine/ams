import { describe, expect, it } from 'vitest';
import { applicabilityByRequirement, matchesAppliesWhen, type Subject } from './applicability.js';

const program: Subject = { scope: 'program', degreeLevel: 'bachelor', programTags: ['mechanical', 'engineering'], engagementKind: 'initial' };
const institution: Subject = { scope: 'institution', engagementKind: 'reaffirmation' };

describe('matchesAppliesWhen', () => {
  it('always applies when empty or null', () => {
    expect(matchesAppliesWhen(undefined, program)).toBe(true);
    expect(matchesAppliesWhen(null, program)).toBe(true);
    expect(matchesAppliesWhen({}, institution)).toBe(true);
    expect(matchesAppliesWhen({ scope: [] }, institution)).toBe(true);
  });

  it('needs every present key to match at least one value', () => {
    expect(matchesAppliesWhen({ scope: ['program'], degree_level: ['bachelor'], program_tags: ['mechanical'] }, program)).toBe(true);
    expect(matchesAppliesWhen({ scope: ['program'], program_tags: ['civil', 'mechanical'] }, program)).toBe(true);
    expect(matchesAppliesWhen({ scope: ['program'], program_tags: ['civil'] }, program)).toBe(false);
    expect(matchesAppliesWhen({ scope: ['program'], degree_level: ['master'] }, program)).toBe(false);
    expect(matchesAppliesWhen({ engagement_kind: ['reaffirmation'] }, program)).toBe(false);
    expect(matchesAppliesWhen({ engagement_kind: ['initial', 'reaffirmation'] }, program)).toBe(true);
  });

  it('does not match a key the subject has no value for', () => {
    expect(matchesAppliesWhen({ scope: ['program'] }, institution)).toBe(false);
    expect(matchesAppliesWhen({ program_tags: ['mechanical'] }, institution)).toBe(false);
    expect(matchesAppliesWhen({ degree_level: ['bachelor'] }, institution)).toBe(false);
    expect(matchesAppliesWhen({ scope: ['institution'] }, institution)).toBe(true);
  });
});

describe('applicabilityByRequirement', () => {
  it('takes sub-items with a parent that does not apply', () => {
    const tree = [
      { id: 'root', parentId: null, appliesWhen: undefined },
      { id: 'mech', parentId: null, appliesWhen: { program_tags: ['mechanical'] } },
      { id: 'mech-1', parentId: 'mech', appliesWhen: undefined },
      { id: 'mech-2', parentId: 'mech-1', appliesWhen: undefined },
    ];
    expect([...applicabilityByRequirement(tree, program)]).toEqual([['root', true], ['mech', true], ['mech-1', true], ['mech-2', true]]);
    expect([...applicabilityByRequirement(tree, { ...program, programTags: ['civil'] })]).toEqual([['root', true], ['mech', false], ['mech-1', false], ['mech-2', false]]);
  });
});
