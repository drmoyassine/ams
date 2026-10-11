// The institution's quality framework (IQF) as the mapping stages and the accept services need it. Read-only helpers;
// nothing here writes. The candidates for a link are the items of the IQF's current published version (else its latest).
import { desc, eq } from 'drizzle-orm';
import { framework, frameworkVersion, requirement } from '@ams/db';
import type { Ctx } from '../../ctx.js';
import { normalizeCode } from './merge.js';
import type { RankItem } from './shortlist.js';

export interface IqfItem {
  id: string;
  code: string;
  title: string;
  text: string | null;
  parentId: string | null;
  depth: number;
  levelLabel: string;
  /** Titles of the ancestors, top first. */
  path: string[];
  displayOrder: number;
}

export interface Iqf {
  frameworkId: string;
  version: { id: string; edition: string; status: string; levelLabels: string[] } | null;
  items: IqfItem[];
}

export const naturalCompare = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

/** The IQF's requirements with depth and path, in tree order. */
export async function loadIqfItems(ctx: Ctx, versionId: string): Promise<IqfItem[]> {
  const rows = await ctx.tx.select().from(requirement).where(eq(requirement.frameworkVersionId, versionId));
  const children = new Map<string | null, typeof rows>();
  for (const r of rows) children.set(r.parentId ?? null, [...(children.get(r.parentId ?? null) ?? []), r]);
  for (const list of children.values()) list.sort((a, b) => a.displayOrder - b.displayOrder || naturalCompare(a.code, b.code));
  const out: IqfItem[] = [];
  const walk = (parent: string | null, depth: number, path: string[]) => {
    for (const r of children.get(parent) ?? []) {
      out.push({ id: r.id, code: r.code, title: r.title, text: r.officialText, parentId: r.parentId, depth, levelLabel: r.levelLabel, path, displayOrder: r.displayOrder });
      walk(r.id, depth + 1, [...path, r.title]);
    }
  };
  walk(null, 0, []);
  return out;
}

/** The IQF framework and the version candidates come from (published, else latest), with its items. Null when there is no IQF. */
export async function loadIqf(ctx: Ctx): Promise<Iqf | null> {
  const [fw] = await ctx.tx.select({ id: framework.id }).from(framework).where(eq(framework.internal, true));
  if (!fw) return null;
  const versions = await ctx.tx.select().from(frameworkVersion).where(eq(frameworkVersion.frameworkId, fw.id)).orderBy(desc(frameworkVersion.createdAt));
  const v = versions.find((x) => x.status === 'published') ?? versions[0] ?? null;
  if (!v) return { frameworkId: fw.id, version: null, items: [] };
  return {
    frameworkId: fw.id,
    version: { id: v.id, edition: v.edition, status: v.status, levelLabels: ((v.levelLabels as string[] | undefined) ?? []).filter(Boolean) },
    items: await loadIqfItems(ctx, v.id),
  };
}

/** The IQF's newest draft version, if it has one: the only place an accepted proposal can add an item. */
export async function loadIqfDraft(ctx: Ctx) {
  const [fw] = await ctx.tx.select({ id: framework.id }).from(framework).where(eq(framework.internal, true));
  if (!fw) return null;
  const versions = await ctx.tx.select().from(frameworkVersion).where(eq(frameworkVersion.frameworkId, fw.id)).orderBy(desc(frameworkVersion.createdAt));
  const v = versions.find((x) => x.status === 'draft');
  return v ? { frameworkId: fw.id, version: v } : null;
}

export const candidatesOf = (items: readonly IqfItem[]): RankItem[] =>
  items.map((i) => ({ id: i.id, code: i.code, title: i.title, text: i.text ?? '', path: i.path }));

/**
 * The next free code under a parent, following the numbering already in use ("2" -> "2.4" when 2.1 to 2.3 exist; a top
 * level "7" when 1 to 6 exist). A suggestion for a person to confirm, never a rule.
 */
export function nextFreeCode(existing: Iterable<string>, parentCode: string | null): string {
  const used = [...existing].map(normalizeCode);
  if (parentCode) {
    const prefix = `${normalizeCode(parentCode)}.`;
    let max = 0;
    for (const c of used) {
      if (!c.startsWith(prefix)) continue;
      const rest = c.slice(prefix.length);
      if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
    }
    return `${prefix}${max + 1}`;
  }
  let best: { prefix: string; n: number } | null = null;
  for (const c of used) {
    const m = /^(\D*)(\d+)$/.exec(c);
    if (m && (!best || Number(m[2]) > best.n)) best = { prefix: m[1]!, n: Number(m[2]) };
  }
  let n = (best?.n ?? 0) + 1;
  const prefix = best?.prefix ?? '';
  const taken = new Set(used);
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** A code a person could type: no spaces at the ends, no line breaks, not absurdly long. */
export const usableCode = (code: string | null | undefined): code is string => !!code && /^[^\s\n][^\n]{0,30}$/u.test(code.trim());

/** Arabic letters in a text mean the item is written in Arabic. */
export const languageOf = (text: string): string => (/[؀-ۿ]/.test(text) ? 'ar' : 'en');
