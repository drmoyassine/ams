// What the External Standards page shows for each standard: its accreditor and logo, every version with its counts
// (requirements, mapped to the institution's own standards, engagements), and the logo's own rules.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createMapping, reviewMapping } from '../mapping/mapping.js';
import { readAccreditorLogo, removeAccreditorLogo, setAccreditorLogo } from './accreditor-logo.js';
import { setUpQualityFramework } from './internal.js';
import { createRequirement, listRequirements, reviewRequirement } from './requirements.js';
import { listFrameworks, newVersionFrom, publishVersion, submitForReview } from './versions.js';

let w: World;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

beforeAll(async () => {
  w = await buildWorld('cardsvc');
  const q = await w.as('admin', (c) => setUpQualityFramework(c));
  const std = await w.as('admin', (c) => createRequirement(c, { versionId: q.versions[0]!.id, code: 'Q1', levelLabel: 'Standard', title: 'Teaching quality' }));
  await w.as('admin', (c) => reviewRequirement(c, std.id, 'approved'));
  await w.as('admin', (c) => submitForReview(c, q.versions[0]!.id));
  await w.as('admin', (c) => publishVersion(c, q.versions[0]!.id));
  // Map two assessable ABET requirements; approve one.
  const assessable = (await w.as('admin', (c) => listRequirements(c, w.ids.abet!))).filter((r) => r.isAssessable);
  const first = await w.as('admin', (c) => createMapping(c, w.ids.abet!, { externalRequirementId: assessable[0]!.id, internalRequirementId: std.id, relation: 'covers' }));
  await w.as('admin', (c) => createMapping(c, w.ids.abet!, { externalRequirementId: assessable[1]!.id, internalRequirementId: std.id, relation: 'related' }));
  await w.as('admin', (c) => reviewMapping(c, first.id, 'approved'));
  await w.create('alo', { subjectType: 'program', subjectId: w.ids.mech!, kind: 'initial' });
}, 120000);
afterAll(() => w.close());

describe('standards for the External Standards page', () => {
  it('lists each accreditor and its versions with requirement, mapped and engagement counts', async () => {
    const list = await w.as('contrib', (c) => listFrameworks(c));
    const abet = list.find((f) => f.accreditorShortName === 'ABET')!;
    expect(abet).toMatchObject({ accreditorType: 'programmatic', logoVersion: null });
    expect(abet.accreditorName).toBeTruthy();
    const v = abet.versions.find((x) => x.id === w.ids.abet)!;
    expect(v).toMatchObject({ status: 'published', mappedCount: 1, engagementCount: 1 }); // only the approved mapping counts
    expect(v.requirementCount).toBeGreaterThan(v.assessableCount - 1);
    expect(v.assessableCount).toBeGreaterThan(1);
    const other = list.find((f) => f.accreditorShortName === 'WSCUC')!.versions[0]!;
    expect(other).toMatchObject({ mappedCount: 0, engagementCount: 0 });
  });

  it('shows a new draft beside the published version it came from', async () => {
    await w.as('admin', (c) => newVersionFrom(c, w.ids.puc!, { edition: '2025' }));
    const puc = (await w.as('contrib', (c) => listFrameworks(c))).find((f) => f.accreditorShortName === 'PUC')!;
    expect(puc.versions.map((x) => [x.edition, x.status])).toEqual([['2019', 'published'], ['2025', 'draft']]);
    expect(puc.versions[1]!.supersedesId).toBe(w.ids.puc);
  });
});

describe('accreditor logo', () => {
  it('stores a real image, serves it back, and changes the version the page uses', async () => {
    const accreditorId = (await w.as('alo', (c) => listFrameworks(c))).find((f) => f.accreditorShortName === 'ABET')!.accreditorId;
    await expect(w.as('contrib', (c) => setAccreditorLogo(c, accreditorId, PNG))).rejects.toThrow(ForbiddenError);
    await expect(w.as('alo', (c) => setAccreditorLogo(c, accreditorId, new TextEncoder().encode('<svg onload="x()"/>')))).rejects.toThrow(/PNG, JPEG or WebP/);
    await expect(w.as('alo', (c) => setAccreditorLogo(c, accreditorId, new Uint8Array(600 * 1024)))).rejects.toThrow(ValidationError);
    await expect(w.as('alo', (c) => readAccreditorLogo(c, accreditorId))).rejects.toThrow(NotFoundError);
    await w.as('alo', (c) => setAccreditorLogo(c, accreditorId, PNG));
    const got = await w.as('contrib', (c) => readAccreditorLogo(c, accreditorId));
    expect(got.mime).toBe('image/png');
    expect([...got.bytes]).toEqual([...PNG]);
    const v1 = (await w.as('alo', (c) => listFrameworks(c))).find((f) => f.accreditorId === accreditorId)!.logoVersion;
    expect(v1).toMatch(/^\d+$/);
    await new Promise((r) => setTimeout(r, 5));
    await w.as('alo', (c) => setAccreditorLogo(c, accreditorId, PNG));
    expect((await w.as('alo', (c) => listFrameworks(c))).find((f) => f.accreditorId === accreditorId)!.logoVersion).not.toBe(v1);
    await w.as('alo', (c) => removeAccreditorLogo(c, accreditorId));
    expect((await w.as('alo', (c) => listFrameworks(c))).find((f) => f.accreditorId === accreditorId)!.logoVersion).toBeNull();
  });
});
