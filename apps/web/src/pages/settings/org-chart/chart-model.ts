// What a box of the org chart says and how tall it is (pure; the chart view and its tests share it). Names wrap with
// `wrapText`, the same words in the box and in the exported image.
import { ORG_MAX_DEPTH, resolveDrop, wrapText, type MoveSpec, type OrgUnit, type OrgUnitType } from '@ams/shared';

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

// ---- Editing on the chart (pure; where a unit may go is @ams/shared's `resolveDrop`, the same the Tree and the server use) ----

/** The box under a point in the chart's own coordinates (the zoom and pan taken off), if any. */
export function boxAt(boxes: readonly { id: string; x: number; y: number; w: number; h: number }[], x: number, y: number): string | null {
  for (const b of boxes) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.id;
  return null;
}

export interface ChartDrop { ok: boolean; text: string; moves: MoveSpec[]; noop: boolean }

/** What dropping the unit `dragId` on the box `targetId` means: it goes last under that unit, or the reason it cannot. */
export function chartDrop(units: readonly Pick<OrgUnit, 'id' | 'parentId' | 'displayOrder' | 'nameEn'>[], dragId: string, targetId: string): ChartDrop {
  const rows = units.map((u) => ({ id: u.id, parentId: u.parentId, displayOrder: u.displayOrder, code: u.nameEn }));
  const name = new Map(units.map((u) => [u.id, u.nameEn] as const));
  const label = (id: string) => name.get(id) ?? 'a unit';
  if (dragId === targetId) return { ok: false, text: `Cannot drop here. ${label(dragId)} cannot be moved under itself.`, moves: [], noop: false };
  const d = resolveDrop(rows, [dragId], { id: targetId, position: 'inside' }, { maxLevels: ORG_MAX_DEPTH, noun: 'unit' }, label);
  if (!d.ok) return { ok: false, text: `Cannot drop here. ${d.message}`, moves: [], noop: false };
  if (d.noop) return { ok: true, text: `${label(dragId)} is already under ${label(targetId)}.`, moves: [], noop: true };
  return { ok: true, text: `Put ${label(dragId)} under ${label(targetId)}.`, moves: d.moves, noop: false };
}

/** Why a unit cannot be picked up on the chart (it is locked), or null. */
export function lockedReason(u: Pick<OrgUnit, 'nameEn' | 'locked'>): string | null {
  return u.locked ? `${u.nameEn} is locked, so it cannot be moved from the chart. Unlock it in its details first.` : null;
}

/** The type a sub-unit added on the chart starts with: its parent's type, or the first type when that one is gone. The drawer changes it. */
export function defaultChildType(parentType: string | null, types: readonly Pick<OrgUnitType, 'key'>[]): string {
  return (parentType && types.some((t) => t.key === parentType) ? parentType : types[0]?.key) ?? '';
}
