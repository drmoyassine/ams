// What a box of the org chart says and how tall it is (pure; the chart view and its tests share it). Names wrap with
// `wrapText`, the same words in the box and in the exported image.
import { wrapText, type OrgUnit } from '@ams/shared';

export const BOX_W = 208;
const EN_CHARS = 24;
const AR_CHARS = 26;
const HEAD_CHARS = 30;

export interface BoxModel {
  type: string;
  en: string[];
  ar: string[];
  head: string | null;
  /** Vertical positions of the text baselines, from the top of the box. */
  y: { type: number; en: number; ar: number; head: number };
  w: number;
  h: number;
}

export const ARABIC = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFE]/;
/** Text that starts with a right-to-left letter is drawn right to left. */
export const isRtlText = (s: string): boolean => {
  for (const ch of s) {
    if (ARABIC.test(ch)) return true;
    if (/\p{L}/u.test(ch)) return false;
  }
  return false;
};

export function headLabel(u: Pick<OrgUnit, 'headUserName' | 'headName'>): string | null {
  return u.headUserName ?? u.headName ?? null;
}

export function boxModel(u: Pick<OrgUnit, 'nameEn' | 'nameAr' | 'headUserName' | 'headName'>, typeLabel: string): BoxModel {
  const en = wrapText(u.nameEn, EN_CHARS, 3);
  const ar = u.nameAr ? wrapText(u.nameAr, AR_CHARS, 2) : [];
  const head = headLabel(u);
  const headLine = head ? wrapText(head, HEAD_CHARS, 1)[0] ?? null : null;
  // Baselines: the type line, then the English name (16 px a line), the Arabic name (15 px), the head (14 px).
  const typeY = 24;
  const enY = typeY + 20;
  const lastEn = enY + (en.length - 1) * 16;
  const arY = lastEn + 17;
  const lastAr = ar.length ? arY + (ar.length - 1) * 15 : lastEn;
  const headY = lastAr + 17;
  const h = Math.max(72, (headLine ? headY : lastAr) + 20);
  return { type: typeLabel, en, ar, head: headLine, y: { type: typeY, en: enY, ar: arY, head: headY }, w: BOX_W, h };
}
