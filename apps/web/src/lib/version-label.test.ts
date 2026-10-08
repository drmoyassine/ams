import { describe, expect, it } from 'vitest';
import { versionLabel } from './version-label';

describe('versionLabel', () => {
  it('prefixes a bare edition with "Version"', () => {
    expect(versionLabel('2019')).toBe('Version 2019');
    expect(versionLabel('2028-29')).toBe('Version 2028-29');
    expect(versionLabel('Versioning 2')).toBe('Version Versioning 2');
  });
  it('keeps an edition that already starts with "Version", in any case', () => {
    expect(versionLabel('Version 2019-V2')).toBe('Version 2019-V2');
    expect(versionLabel('version 3')).toBe('version 3');
    expect(versionLabel('VERSION 4')).toBe('VERSION 4');
    expect(versionLabel('  Version 5 ')).toBe('Version 5');
  });
});
