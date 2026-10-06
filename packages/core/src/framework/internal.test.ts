// The institution's own quality framework: set up once by someone who may edit, edited and published like any
// framework, kept out of the Standards list, and never the basis of an engagement (DEC-016).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createEngagement } from '../engagement/engagements.js';
import { listExternalTerms } from '../glossary/glossary.js';
import { BUILDING_BLOCKS, DEFAULT_QMS_CYCLE } from '@ams/shared';
import { seedDefaultGlossary } from '../glossary/glossary.js';
import { getQmsModel, getQualityFramework, indentRequirement, outdentRequirement, setQmsCycle, setQualityLevels, setUpQualityFramework } from './internal.js';
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

describe('levels by depth, and the cycle', () => {
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

  it('starts from Plan, Do, Check, Act, saves a valid cycle on a draft, and draws it with the institution\'s names', async () => {
    const { versions } = await w.as('admin', (c) => getQualityFramework(c));
    const draft = versions.find((v) => v.status === 'draft')!;
    await w.as('admin', (c) => seedDefaultGlossary(c));
    const model = await w.as('contrib', (c) => getQmsModel(c, draft.id));
    expect(model.cycleIsDefault).toBe(true);
    expect(model.cycle.stages.map((s) => s.name)).toEqual(['Plan', 'Do', 'Check', 'Act']);
    expect(model.blocks.map((b) => b.key)).toEqual([...BUILDING_BLOCKS]);
    expect(model.attributes.map((a) => a.key).sort()).toEqual(['owner', 'scope']);
    expect(model.mermaid).toContain('measure["Measure / KPI"]');

    const twice = { stages: [{ key: 'a', name: 'A', blocks: ['policy'] }, { key: 'b', name: 'B', blocks: ['policy'] }], flows: [] };
    await expect(w.as('alo', (c) => setQmsCycle(c, draft.id, twice))).rejects.toThrow(ValidationError);
    await expect(w.as('alo', (c) => setQmsCycle(c, draft.id, { stages: [{ key: 'a', name: 'A', blocks: ['policy'] }], flows: [{ from: 'policy', to: 'evidence' }] }))).rejects.toThrow(ValidationError);
    await expect(w.as('contrib', (c) => setQmsCycle(c, draft.id, DEFAULT_QMS_CYCLE))).rejects.toThrow(ForbiddenError);
    const mine = { stages: [{ key: 'plan', name: 'Plan', blocks: ['policy', 'objective'] }, { key: 'review', name: 'Review', blocks: ['internal_review'] }], flows: [{ from: 'policy', to: 'objective' }, { from: 'objective', to: 'internal_review', label: 'checked by' }] };
    await w.as('alo', (c) => setQmsCycle(c, draft.id, mine));
    const after = await w.as('contrib', (c) => getQmsModel(c, draft.id));
    expect(after.cycleIsDefault).toBe(false);
    expect(after.mermaid).toBe([
      'flowchart LR', '  subgraph plan["Plan"]', '    policy["Policy"]', '    objective["Objective"]', '  end',
      '  subgraph review["Review"]', '    internal_review["Internal review"]', '  end',
      '  objective -->|"checked by"| internal_review', '  policy --> objective', // arrows to later stages first
    ].join('\n'));
    await expect(w.as('alo', (c) => getQmsModel(c, w.ids.abet!))).rejects.toThrow(ValidationError); // external standards have no cycle
    const published = versions.find((v) => v.status === 'published')!;
    await expect(w.as('alo', (c) => setQmsCycle(c, published.id, mine))).rejects.toThrow(ConflictError);
  });
});
