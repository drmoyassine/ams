/**
 * "Version 2019" for the edition "2019"; an edition that already starts with "Version" ("Version 2019-V2",
 * "version 3") is returned as it is, so the label never reads "Version Version …".
 */
export function versionLabel(edition: string): string {
  const e = edition.trim();
  return /^version\s/i.test(e) ? e : `Version ${e}`;
}
