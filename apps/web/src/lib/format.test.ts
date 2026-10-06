import { describe, expect, it } from 'vitest';
import { distinctTitle, requirementLabel } from './format';

describe('requirement labels', () => {
  it('shows a code once when the title only repeats it', () => {
    expect(requirementLabel('CFR 1.1', 'CFR 1.1')).toBe('CFR 1.1');
    expect(requirementLabel('1-1-1', '1-1-1')).toBe('1-1-1');
    expect(requirementLabel('Criterion 5(a)', 'Criterion 5(a)')).toBe('Criterion 5(a)');
  });

  it('shows a code once when it already ends with the title', () => {
    expect(requirementLabel('Standard 1 - Integrity and Transparency', 'Integrity and Transparency')).toBe('Standard 1 - Integrity and Transparency');
  });

  it('drops the code from a title that starts with it, and keeps real titles', () => {
    expect(requirementLabel('Criterion 1', 'Criterion 1: Students')).toBe('Criterion 1 Students');
    expect(requirementLabel('Standard 1', 'Standard 1 Defining Mission')).toBe('Standard 1 Defining Mission');
    expect(requirementLabel('CFR 2.4', 'Assessment of student learning')).toBe('CFR 2.4 Assessment of student learning');
    expect(requirementLabel('Mechanical 1', 'Mechanical 1. Curriculum', ' — ')).toBe('Mechanical 1 — Curriculum');
    expect(requirementLabel('1', 'المعيار (1): الرسالة، الأهداف')).toBe('1 المعيار (1): الرسالة، الأهداف');
  });

  it('is case and spacing tolerant, and handles an empty title', () => {
    expect(distinctTitle('CFR  1.1', 'cfr 1.1')).toBeNull();
    expect(distinctTitle('CFR 1.1', '')).toBeNull();
  });
});
