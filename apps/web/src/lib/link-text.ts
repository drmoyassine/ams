import type { EvidenceLink } from '@ams/shared';

/** What a link points at, in words: "Internal 1.2 · Title", "IC 1.2 (external) · Title" or "Engagement · code". */
export function targetText(t: EvidenceLink['target']): string {
  const title = t.title ? ` · ${t.title}` : '';
  if (t.kind === 'internal') return `Internal ${t.code}${title}`;
  if (t.kind === 'external') return `${t.frameworkLabel ? `${t.frameworkLabel} ` : ''}${t.code} (external)${title}`;
  return `${t.engagementTitle ?? ''} · ${t.code}`;
}
