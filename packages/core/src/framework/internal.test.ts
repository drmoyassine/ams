// The institution's own quality framework: set up once by someone who may edit, edited and published like any
// framework, kept out of the Standards list, and never the basis of an engagement (DEC-016).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createEngagement } from '../engagement/engagements.js';
import { listExternalTerms } from '../glossary/glossary.js';
import { addQualityItem, applyQualityTemplate, editQualityItem, getQualityFramework, indentRequirement, newQualityVersion, publishQualityVersion, outdentRequirement, setQualityLevels, setUpQualityFramework } from './internal.js';
import { createRequirement, listRequirements, reviewRequirement } from './requirements.js';
import { getVersionDetail, listFrameworks, newVersionFrom, publishVersion, returnToDraft, submitForReview, validateVersion } from './versions.js';

let w: World;
beforeAll(async () => { w = await buildWorld('internalfw'); }, 60000);
afterAll(() => w.close());

describe('quality framework', () => {
  it('starts unset, is set up once by an editor with a draft version and default level names', async () => {
    expect((await w.as('contrib', (c) => getQualityFramework(c))).framework).toBeNull();
    await expect(w.as('contrib', (c) => setUpQualityFramework(c))).rejects.toThrow(ForbiddenError);
    const set = await w.as('alo', (c) => setUpQualityFramework(c));
    expect(set.framework?.name).toBe('Internal Quality Framework');
    expect(set.versions).toHaveLength(1);
    expect(set.versions[0]).toMatchObject({ edition: '1', status: 'draft', levelLabels: ['Standard', 'Sub-standard'] });
    await expect(w.as('alo', (c) => setUpQualityFramework(c))).rejects.toThrow(ConflictError);
    expect((await w.as('contrib', (c) => getQualityFramework(c))).versions).toHaveLength(1);
  });

  it('is not an external standard: hidden from the Standards list and the glossary mapping', async () => {
    const list = await w.as('admin', (c) => listFrameworks(c));
    expect(list.map((f) => f.name)).not.toContain('Internal Quality Framework');
    expect((await w.as('admin', (c) => listExternalTerms(c))).map((s) => s.name)).not.toContain('Internal Quality Framework');
  });

  it('needs only level names and one approved requirement to be published, then is frozen', async () => {
    const { versions } = await w.as('admin', (c) => getQualityFramework(c));
    const id = versions[0]!.id;
    expect((await w.as('admin', (c) => getVersionDetail(c, id))).internal).toBe(true);
    expect(await w.as('admin', (c) => validateVersion(c, id))).toEqual({ ok: true });
    await expect(w.as('alo', (c) => submitForReview(c, id))).rejects.toThrow(ValidationError); // no requirement yet
    const std = await w.as('alo', (c) => createRequirement(c, { versionId: id, code: 'Q1', levelLabel: 'Standard', title: 'Teaching quality' }));
    const sub = await w.as('alo', (c) => createRequirement(c, { versionId: id, code: 'Q1.1', levelLabel: 'Sub-standard', title: 'Course review', parentId: std.id }));
    await w.as('alo', (c) => submitForReview(c, id));
    await expect(w.as('admin', (c) => publishVersion(c, id))).rejects.toThrow(ConflictError); // requirements not approved
    await w.as('admin', (c) => returnToDraft(c, id));
    for (const r of [std, sub]) await w.as('admin', (c) => reviewRequirement(c, r.id, 'approved'));
    await w.as('alo', (c) => submitForReview(c, id));
    expect((await w.as('admin', (c) => publishVersion(c, id))).status).toBe('published');
    await expect(w.as('alo', (c) => createRequirement(c, { versionId: id, code: 'Q2', levelLabel: 'Standard', title: 'More' }))).rejects.toThrow(ConflictError);
    const next = await w.as('alo', (c) => newVersionFrom(c, id, { edition: '2' }));
    expect(next.requirementsCopied).toBe(2);
  });

  it('cannot be the basis of an engagement', async () => {
    const { versions } = await w.as('admin', (c) => getQualityFramework(c));
    await expect(w.as('alo', (c) => createEngagement(c, {
      frameworkVersionId: versions[0]!.id, subjectType: 'institution', subjectId: w.ids.inst!, kind: 'initial', reviewYear: 2027, leadUserId: w.ids.alo!,
    }))).rejects.toThrow(/own quality framework/);
  });
});

describe('levels by depth', () => {
  it('names each requirement by its depth, follows renames, and indents or outdents it', async () => {
    const w2 = await buildWorld('internallevels');
    try {
      const set = await w2.as('alo', (c) => setUpQualityFramework(c, { levelLabels: ['A', 'B', 'C'] }));
      const v = set.versions[0]!.id;
      // whatever level is sent, the depth decides it
      const top = await w2.as('alo', (c) => createRequirement(c, { versionId: v, code: 'Q1', levelLabel: 'anything', title: 'One' }));
      const sub = await w2.as('alo', (c) => createRequirement(c, { versionId: v, code: 'Q1.1', levelLabel: 'anything', title: 'Two', parentId: top.id }));
      const two = await w2.as('alo', (c) => createRequirement(c, { versionId: v, code: 'Q2', levelLabel: 'anything', title: 'Three' }));
      const labels = async () => (await w2.as('alo', (c) => listRequirements(c, v))).map((r) => [r.code, r.levelLabel]);
      expect(await labels()).toEqual([['Q1', 'A'], ['Q1.1', 'B'], ['Q2', 'A']]);
      await w2.as('admin', (c) => reviewRequirement(c, top.id, 'approved'));

      await expect(w2.as('contrib', (c) => setQualityLevels(c, ['A', 'B']))).rejects.toThrow(ForbiddenError);
      await expect(w2.as('alo', (c) => setQualityLevels(c, ['A', 'a']))).rejects.toThrow(ValidationError);
      await w2.as('alo', (c) => setQualityLevels(c, ['Theme', 'A']));
      expect(await labels()).toEqual([['Q1', 'Theme'], ['Q1.1', 'A'], ['Q2', 'Theme']]);
      expect((await w2.as('alo', (c) => listRequirements(c, v)))[0]!.reviewStatus).toBe('approved'); // renaming a level is not a change of content

      await w2.as('alo', (c) => indentRequirement(c, two.id)); // under Q1, after Q1.1
      expect(await labels()).toEqual([['Q1', 'Theme'], ['Q1.1', 'A'], ['Q2', 'A']]);
      await w2.as('alo', (c) => indentRequirement(c, two.id)); // under Q1.1: deeper than the named levels
      expect(await labels()).toEqual([['Q1', 'Theme'], ['Q1.1', 'A'], ['Q2', 'Level 3']]);
      await expect(w2.as('alo', (c) => indentRequirement(c, top.id))).rejects.toThrow(/nothing above/);
      await w2.as('alo', (c) => outdentRequirement(c, two.id));
      await w2.as('alo', (c) => outdentRequirement(c, two.id));
      expect(await labels()).toEqual([['Q1', 'Theme'], ['Q1.1', 'A'], ['Q2', 'Theme']]);
      await expect(w2.as('alo', (c) => outdentRequirement(c, two.id))).rejects.toThrow(/top level/);
      void sub;
    } finally { await w2.close(); }
  });

  it('starts from the generic template on an empty draft, and only there', async () => {
    const w3 = await buildWorld('internaltemplate');
    try {
      const set = await w3.as('alo', (c) => setUpQualityFramework(c, { levelLabels: ['Area', 'Standard'], template: true }));
      const rows = await w3.as('contrib', (c) => listRequirements(c, set.versions[0]!.id));
      const tops = rows.filter((r) => r.depth === 0);
      expect(tops.map((r) => r.title)).toEqual([
        'Mission and governance', 'Programs and curriculum', 'Teaching and learning', 'Students and support',
        'Faculty and staff', 'Research and community engagement', 'Resources and infrastructure', 'Quality assurance and improvement',
      ]);
      expect(tops.every((r) => r.levelLabel === 'Area' && !r.isAssessable)).toBe(true);
      expect(rows.filter((r) => r.depth === 1).every((r) => r.levelLabel === 'Standard')).toBe(true);
      expect(rows.find((r) => r.code === '1.1')!.title).toBe('Mission, vision and values');
      await expect(w3.as('alo', (c) => applyQualityTemplate(c, set.versions[0]!.id))).rejects.toThrow(/already has items/);
      await expect(w3.as('alo', (c) => applyQualityTemplate(c, w3.ids.abet!))).rejects.toThrow(ValidationError);
    } finally { await w3.close(); }
  });

  it('publishes a draft in one step (a person approving all of it), then starts the next version from it', async () => {
    const w4 = await buildWorld('internalpublish');
    try {
      const set = await w4.as('alo', (c) => setUpQualityFramework(c, { template: true }));
      const v1 = set.versions[0]!.id;
      await expect(w4.as('alo', (c) => publishQualityVersion(c, v1))).rejects.toThrow(ForbiddenError); // publishing is the admin's
      expect((await w4.as('admin', (c) => publishQualityVersion(c, v1))).status).toBe('published');
      expect((await w4.as('admin', (c) => listRequirements(c, v1))).every((r) => r.reviewStatus === 'approved')).toBe(true);
      await expect(w4.as('admin', (c) => publishQualityVersion(c, v1))).rejects.toThrow(/already published/);
      const v2 = await w4.as('alo', (c) => newQualityVersion(c));
      expect(v2).toMatchObject({ edition: '2', status: 'draft' });
      expect((await w4.as('alo', (c) => listRequirements(c, v2.id))).length).toBe((await w4.as('alo', (c) => listRequirements(c, v1))).length);
      await expect(w4.as('alo', (c) => newQualityVersion(c))).rejects.toThrow(/still a draft/);
    } finally { await w4.close(); }
  });

  it('places items by their code, moves them when the code changes, and renumbers sub-standards with their standard', async () => {
    const w5 = await buildWorld('internalcodes');
    try {
      const v = (await w5.as('alo', (c) => setUpQualityFramework(c))).versions[0]!.id;
      const one = await w5.as('alo', (c) => addQualityItem(c, v, { code: '1.0', title: 'Teaching' }));
      expect(one).toMatchObject({ code: '1', parentId: null, levelLabel: 'Standard' });
      const sub = await w5.as('alo', (c) => addQualityItem(c, v, { code: '1.2', title: 'Course review', description: 'Each course is reviewed yearly.' }));
      expect(sub).toMatchObject({ parentId: one.id, levelLabel: 'Sub-standard', officialText: 'Each course is reviewed yearly.' });
      await expect(w5.as('alo', (c) => addQualityItem(c, v, { code: '7.1', title: 'Orphan' }))).rejects.toThrow(/no Standard 7.0/);
      await expect(w5.as('alo', (c) => addQualityItem(c, v, { code: '1.2', title: 'Again' }))).rejects.toThrow(/code 1.2 is already used/);
      await expect(w5.as('alo', (c) => addQualityItem(c, v, { code: 'A', title: 'Bad' }))).rejects.toThrow(ValidationError);
      const three = await w5.as('alo', (c) => addQualityItem(c, v, { code: '3', title: 'Students' }));
      expect((await w5.as('alo', (c) => editQualityItem(c, sub.id, { code: '3.1', title: 'Course review' }))).parentId).toBe(three.id); // moved
      await expect(w5.as('alo', (c) => editQualityItem(c, three.id, { code: '1.5', title: 'Students' }))).rejects.toThrow(/cannot become a sub-standard/);
      await w5.as('alo', (c) => editQualityItem(c, three.id, { code: '4', title: 'Students' }));
      expect((await w5.as('alo', (c) => listRequirements(c, v))).map((r) => r.code)).toEqual(['1', '4', '4.1']);
    } finally { await w5.close(); }
  });
});
