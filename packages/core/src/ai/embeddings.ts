// Embeddings of framework text (DEC-023): stored as plain real[] rows, ranked by exact cosine here. Worker/job path only,
// because upsertEmbeddings calls embed(). Scores rank candidates and are never shown as a match, coverage or confidence.
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { embedding, requirement } from '@ams/db';
import type { Ctx } from '../ctx.js';
import { embed, type AiRuntime, type AiUsage } from './index.js';

export interface EmbeddingItem {
  ownerType: 'requirement';
  ownerId: string;
  text: string;
}

export const textHash = (text: string) => createHash('sha256').update(text.normalize('NFC')).digest('hex');

/**
 * The text embedded for a requirement: its level path (ancestors' titles), then code, title and description. Framework text
 * only (external standards and the IQF).
 */
export async function requirementEmbeddingItems(ctx: Ctx, ids: string[]): Promise<EmbeddingItem[]> {
  if (ids.length === 0) return [];
  const rows = await ctx.tx.select().from(requirement).where(inArray(requirement.id, ids));
  // Ancestors are in the same version; load it whole to walk the parent chain.
  const versionIds = [...new Set(rows.map((r) => r.frameworkVersionId))];
  const all = await ctx.tx.select().from(requirement).where(inArray(requirement.frameworkVersionId, versionIds));
  const byId = new Map(all.map((r) => [r.id, r]));
  return rows.map((r) => {
    const path: string[] = [];
    for (let p = r.parentId ? byId.get(r.parentId) : undefined, guard = 0; p && guard < 50; p = p.parentId ? byId.get(p.parentId) : undefined, guard++) path.unshift(`${p.code} ${p.title}`.trim());
    const text = [path.length ? `Path: ${path.join(' > ')}` : '', `${r.code} ${r.title}`.trim(), r.officialText ?? ''].filter(Boolean).join('\n');
    return { ownerType: 'requirement' as const, ownerId: r.id, text };
  });
}

/**
 * Embeds the items whose text hash or model is new, and keeps the rest as they are. Returns what was done and the usage
 * record of the embedding call (null when nothing needed embedding).
 */
export async function upsertEmbeddings(ctx: Ctx, items: EmbeddingItem[], runtime: AiRuntime): Promise<{ embedded: number; skipped: number; usage: AiUsage | null }> {
  const cfg = runtime.embedding;
  const model = cfg?.model ?? 'test-embedder';
  const dimension = cfg?.dimension ?? 32;
  if (items.length === 0) return { embedded: 0, skipped: 0, usage: null };
  const existing = await ctx.tx.select({ ownerId: embedding.ownerId, textHash: embedding.textHash, dimension: embedding.dimension }).from(embedding)
    .where(and(eq(embedding.model, model), inArray(embedding.ownerId, items.map((i) => i.ownerId))));
  const have = new Map(existing.map((e) => [e.ownerId, e]));
  const todo = items.filter((i) => {
    const e = have.get(i.ownerId);
    return !(e && e.textHash === textHash(i.text) && e.dimension === dimension);
  });
  if (todo.length === 0) return { embedded: 0, skipped: items.length, usage: null };
  const { vectors, usage } = await embed(todo.map((t) => t.text), { runtime });
  for (const [n, item] of todo.entries()) {
    const values = {
      institutionId: ctx.caller.institutionId, ownerType: item.ownerType, ownerId: item.ownerId, model, dimension,
      textHash: textHash(item.text), vector: vectors[n]!,
    };
    await ctx.tx.insert(embedding).values(values).onConflictDoUpdate({
      target: [embedding.ownerType, embedding.ownerId, embedding.model],
      set: { dimension: values.dimension, textHash: values.textHash, vector: values.vector },
    });
  }
  return { embedded: todo.length, skipped: items.length - todo.length, usage };
}

/** Cosine similarity of two vectors; 0 when either is all zeros or the sizes differ. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * The `k` candidates whose stored vector (for `model`) is closest to the query, best first. An exact scan: fine for
 * thousands of items. Candidates without a vector are left out. `similarity` is for ordering only.
 */
export async function rankBySimilarity(
  ctx: Ctx, queryVector: readonly number[], candidateOwnerIds: string[], k: number, model: string,
): Promise<{ ownerId: string; similarity: number }[]> {
  if (candidateOwnerIds.length === 0 || k <= 0) return [];
  const rows = await ctx.tx.select({ ownerId: embedding.ownerId, vector: embedding.vector }).from(embedding)
    .where(and(eq(embedding.model, model), eq(embedding.ownerType, 'requirement'), inArray(embedding.ownerId, candidateOwnerIds)));
  return rows
    .map((r) => ({ ownerId: r.ownerId, similarity: cosine(queryVector, r.vector) }))
    .sort((x, y) => y.similarity - x.similarity || x.ownerId.localeCompare(y.ownerId))
    .slice(0, k);
}
