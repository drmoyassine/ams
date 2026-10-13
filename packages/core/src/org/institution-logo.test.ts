// The institution logo: the type comes from the bytes, SVG and big files are refused, replacing deletes the old file,
// and who may change it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity } from '@ams/db';
import { ForbiddenError, NotFoundError, ValidationError, type Ctx } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { getInstitution } from './institution.js';
import { readInstitutionLogo, removeInstitutionLogo, setInstitutionLogo } from './institution-logo.js';

let w: World;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);

/** Like World.as, but runs the after-commit hooks, as the API does. */
async function asCommitted<T>(who: string, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const hooks: (() => Promise<void>)[] = [];
  const caller = { userId: w.ids[who]!, institutionId: w.ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  const out = await withIdentity(w.pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: (h) => { hooks.push(h); }, store: w.store }));
  for (const h of hooks) await h();
  return out;
}

beforeAll(async () => { w = await buildWorld('instlogosvc'); }, 120000);
afterAll(() => w.close());

describe('institution logo service', () => {
  it('is for administrators to change and for anyone who reads the organization to see', async () => {
    await expect(w.as('alo', (c) => setInstitutionLogo(c, PNG))).rejects.toThrow(ForbiddenError);
    await expect(w.as('contrib', (c) => removeInstitutionLogo(c))).rejects.toThrow(ForbiddenError);
    await expect(w.as('contrib', (c) => readInstitutionLogo(c))).rejects.toThrow(NotFoundError);
  });

  it('refuses SVG, an unknown type, an empty file and a file over 512 KB, whatever the caller says it is', async () => {
    await expect(w.as('admin', (c) => setInstitutionLogo(c, new TextEncoder().encode('<svg onload="x()"/>')))).rejects.toThrow(/PNG, JPEG or WebP/);
    await expect(w.as('admin', (c) => setInstitutionLogo(c, new TextEncoder().encode('GIF89a....')))).rejects.toThrow(ValidationError);
    await expect(w.as('admin', (c) => setInstitutionLogo(c, new Uint8Array(0)))).rejects.toThrow(/empty/);
    await expect(w.as('admin', (c) => setInstitutionLogo(c, new Uint8Array(512 * 1024 + 1)))).rejects.toThrow(/512 KB/);
    expect(w.store.objects.size).toBe(0);
  });

  it('stores the type the bytes are, versions it, replaces the old file and removes it', async () => {
    await asCommitted('admin', (c) => setInstitutionLogo(c, PNG));
    const got = await w.as('contrib', (c) => readInstitutionLogo(c));
    expect(got.mime).toBe('image/png');
    expect([...got.bytes]).toEqual([...PNG]);
    const v1 = (await w.as('contrib', (c) => getInstitution(c))).logoVersion;
    expect(v1).toMatch(/^\d+$/);
    expect(w.store.objects.size).toBe(1);
    const oldKey = [...w.store.objects.keys()][0]!;
    await new Promise((r) => setTimeout(r, 5));
    await asCommitted('admin', (c) => setInstitutionLogo(c, WEBP));
    expect(w.store.objects.has(oldKey)).toBe(false);
    expect(w.store.objects.size).toBe(1);
    expect((await w.as('contrib', (c) => readInstitutionLogo(c))).mime).toBe('image/webp');
    expect((await w.as('contrib', (c) => getInstitution(c))).logoVersion).not.toBe(v1);
    await asCommitted('admin', (c) => removeInstitutionLogo(c));
    expect(w.store.objects.size).toBe(0);
    expect((await w.as('contrib', (c) => getInstitution(c))).logoVersion).toBeNull();
    await expect(w.as('contrib', (c) => readInstitutionLogo(c))).rejects.toThrow(NotFoundError);
    await asCommitted('admin', (c) => removeInstitutionLogo(c)); // removing none is fine
  });
});
