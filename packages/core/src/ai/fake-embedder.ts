import { createHash } from 'node:crypto';
import type { TestEmbedder } from './model.js';

/**
 * A deterministic embedder for tests: each word (lower-cased) adds weight to a few dimensions chosen by its hash, so
 * texts that share words get similar vectors and unrelated ones do not. Counts its calls.
 */
export function createFakeEmbedder(): TestEmbedder & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((texts: string[], config: { dimension: number }) => {
    const dim = config.dimension > 0 ? config.dimension : 32; // 0: a probe, the size is being detected
    calls.push(texts);
    const vectors = texts.map((t) => {
      const v = new Array<number>(dim).fill(0);
      for (const word of t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
        const h = createHash('sha256').update(word).digest();
        for (let i = 0; i < 3; i++) v[h.readUInt16BE(i * 2) % dim]! += 1;
      }
      return v;
    });
    return { vectors, tokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
  }) as unknown as TestEmbedder & { calls: string[][] };
  fn.calls = calls;
  return fn;
}
