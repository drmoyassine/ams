// Stable hashes. The confirmation is tied to the SHA-256 of the exact change set, so the same operations always give the same
// hash (keys sorted, no undefined) and any change to them gives another.
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const hashOf = (value: unknown): string => sha256(canonicalJson(value));
export const hashToken = (token: string): string => sha256(`assistant-confirmation:${token}`);
