import { createHash } from 'node:crypto';
import type { ObjectStore } from '../ctx.js';

/** An object store kept in memory: for tests and for running without storage configured. */
export class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; mime: string }>();
  async put(key: string, body: Uint8Array, mime: string) {
    this.objects.set(key, { body: new Uint8Array(body), mime });
    return { size: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') };
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
}
