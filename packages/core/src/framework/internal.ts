import { and, asc, eq } from 'drizzle-orm';
import { accreditor, framework, frameworkVersion, requirement } from '@ams/db';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { syncLevelTerms } from '../glossary/glossary.js';
import { assertHuman, getDraftVersion, getRequirement, getVersion, isInternalVersion, require_ } from './common.js';
import { newVersionFrom, publishVersion, submitForReview } from './versions.js';
import { INTERNAL_TEMPLATE } from './internal-template.js';
import { createRequirement, listRequirements, moveRequirement, relabelByDepth, updateRequirement } from './requirements.js';

/**
 * The institution's own quality framework (DEC-016) lives in the framework library like any standard, but is owned
 * by the institution and names its own levels. There is at most one per institution (a partial unique index).
 */
export const DEFAULT_INTERNAL_LEVELS = ['Standard', 'Sub-standard'];

export const SetUpQualityFrameworkSchema = z.object({
  name: z.string().trim().min(1).default('Internal Quality Framework'),
  levelLabels: z.array(z.string().trim().min(1)).min(1).default(DEFAULT_INTERNAL_LEVELS),
  /** Start from the generic template rather than an empty tree. */
  template: z.boolean().default(false),
});

export async function getQualityFramework(ctx: Ctx) {
  await require_(ctx, 'framework:read');
  const [fw] = await ctx.tx.select({ id: framework.id, name: framework.name }).from(framework).where(eq(framework.internal, true));
  if (!fw) return { framework: null, versions: [] };
  const versions = await ctx.tx.select().from(frameworkVersion).where(eq(frameworkVersion.frameworkId, fw.id)).orderBy(asc(frameworkVersion.createdAt));
  return { framework: fw, versions };
}

/** Creates the framework and its first draft version, once. */
export async function setUpQualityFramework(ctx: Ctx, input: z.input<typeof SetUpQualityFrameworkSchema> = {}) {
  await require_(ctx, 'framework:write');
  const data = SetUpQualityFrameworkSchema.parse(input);
  const existing = await getQualityFramework(ctx);
  if (existing.framework) throw new ConflictError('the quality framework is already set up');
  const institutionId = ctx.caller.institutionId;
  // The framework table needs an accreditor; the institution stands in for it, and the Standards list never shows it.
  let [own] = await ctx.tx.select({ id: accreditor.id }).from(accreditor).where(eq(accreditor.shortName, 'Internal'));
  if (!own) {
    [own] = await ctx.tx.insert(accreditor).values({ institutionId, name: 'Our institution', shortName: 'Internal', type: 'institutional' }).returning({ id: accreditor.id });
  }
  const [fw] = await guardIntegrity(() => ctx.tx.insert(framework).values({
    institutionId, accreditorId: own!.id, name: data.name, scope: 'both', internal: true,
  }).returning());
  const [version] = await ctx.tx.insert(frameworkVersion).values({
    institutionId, frameworkId: fw!.id, edition: '1', levelLabels: data.levelLabels,
  }).returning();
  await syncLevelTerms(ctx);
  if (data.template) await applyQualityTemplate(ctx, version!.id);
  return { framework: { id: fw!.id, name: fw!.name }, versions: [version!] };
}

/** Sets the level names of the internal quality framework, top first, on its newest version, which must still be a draft. */
export async function setQualityLevels(ctx: Ctx, levelLabels: string[]) {
  await require_(ctx, 'framework:write');
  const labels = z.array(z.string().trim().min(1)).min(1).parse(levelLabels);
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw new ValidationError('level names must be different from each other');
  const { versions } = await getQualityFramework(ctx);
  const latest = versions[versions.length - 1];
  if (!latest) throw new ConflictError('set up the quality framework first');
  if (latest.status !== 'draft') throw new ConflictError(`the newest version is ${latest.status.replace('_', ' ')}; create a new version to change the level names`);
  await guardIntegrity(() => ctx.tx.update(frameworkVersion).set({ levelLabels: labels }).where(eq(frameworkVersion.id, latest.id)));
  await relabelByDepth(ctx, latest.id);
  await syncLevelTerms(ctx);
  return getQualityFramework(ctx);
}

async function internalVersion(ctx: Ctx, versionId: string) {
  const v = await getVersion(ctx, versionId);
  if (!(await isInternalVersion(ctx, versionId))) throw new ValidationError('this belongs to the internal quality framework');
  return v;
}

/**
 * Fills an empty draft of the internal framework with the generic starting template (eight areas, each with a few
 * items), numbered 1, 1.1 and so on. Refused once the draft has anything in it, so it never mixes with real content.
 */
export async function applyQualityTemplate(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:write');
  await internalVersion(ctx, versionId);
  await getDraftVersion(ctx, versionId);
  if ((await listRequirements(ctx, versionId)).length > 0) throw new ConflictError('the framework already has items; the template only fills an empty one');
  for (const [i, area] of INTERNAL_TEMPLATE.entries()) {
    const top = await createRequirement(ctx, { versionId, code: String(i + 1), levelLabel: 'Level 1', title: area.title, displayOrder: i, isAssessable: false });
    for (const [j, title] of area.children.entries()) {
      await createRequirement(ctx, { versionId, parentId: top.id, code: `${i + 1}.${j + 1}`, levelLabel: 'Level 2', title, displayOrder: j });
    }
  }
  return listRequirements(ctx, versionId);
}

/** Indents a requirement under the sibling just above it; its level (and its subtree's) follows its new depth. */
export async function indentRequirement(ctx: Ctx, id: string) {
  await require_(ctx, 'framework:write');
  const r = await getRequirement(ctx, id);
  await internalVersion(ctx, r.frameworkVersionId);
  await getDraftVersion(ctx, r.frameworkVersionId);
  const rows = await listRequirements(ctx, r.frameworkVersionId);
  const siblings = rows.filter((x) => (x.parentId ?? null) === (r.parentId ?? null));
  const at = siblings.findIndex((x) => x.id === id);
  if (at <= 0) throw new ConflictError('there is nothing above it to indent under');
  const newParent = siblings[at - 1]!;
  const lastChild = rows.filter((x) => x.parentId === newParent.id).reduce((m, x) => Math.max(m, x.displayOrder), -1);
  await moveRequirement(ctx, id, newParent.id, lastChild + 1);
  return getRequirement(ctx, id);
}

/** Outdents a requirement to sit just after its parent; its level (and its subtree's) follows its new depth. */
export async function outdentRequirement(ctx: Ctx, id: string) {
  await require_(ctx, 'framework:write');
  const r = await getRequirement(ctx, id);
  await internalVersion(ctx, r.frameworkVersionId);
  await getDraftVersion(ctx, r.frameworkVersionId);
  if (!r.parentId) throw new ConflictError('it is already at the top level');
  const parent = await getRequirement(ctx, r.parentId);
  // Make room right after the parent among its siblings, then move there.
  const rows = await listRequirements(ctx, r.frameworkVersionId);
  for (const x of rows.filter((y) => (y.parentId ?? null) === (parent.parentId ?? null) && y.displayOrder > parent.displayOrder)) {
    await ctx.tx.update(requirement).set({ displayOrder: x.displayOrder + 1 }).where(eq(requirement.id, x.id));
  }
  await moveRequirement(ctx, id, parent.parentId ?? null, parent.displayOrder + 1);
  return getRequirement(ctx, id);
}

/**
 * Publishes a draft of the internal framework in one step: the person publishing approves every item in it, then it is
 * submitted and published, and from then on it is frozen like any published version. Only a person may do this.
 */
export async function publishQualityVersion(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:publish');
  assertHuman(ctx);
  await internalVersion(ctx, versionId);
  const v = await getVersion(ctx, versionId);
  if (v.status === 'draft') {
    if ((await listRequirements(ctx, versionId)).length === 0) throw new ValidationError('add at least one standard before publishing');
    await ctx.tx.update(requirement).set({ reviewStatus: 'approved', reviewedBy: ctx.caller.userId, reviewedAt: new Date() })
      .where(eq(requirement.frameworkVersionId, versionId));
    await submitForReview(ctx, versionId);
  } else if (v.status !== 'in_review') throw new ConflictError(`this version is already ${v.status}`);
  return publishVersion(ctx, versionId);
}

/** Starts the next draft from the newest version, numbered one up (1, 2, 3 …); its items, mappings and evidence carry over by code. */
export async function newQualityVersion(ctx: Ctx) {
  await require_(ctx, 'framework:write');
  const { versions } = await getQualityFramework(ctx);
  const latest = versions[versions.length - 1];
  if (!latest) throw new ConflictError('set up the quality framework first');
  if (latest.status === 'draft' || latest.status === 'in_review') throw new ConflictError('the newest version is still a draft; edit that one');
  const next = Math.max(0, ...versions.map((x) => Number.parseInt(x.edition, 10)).filter((n) => Number.isFinite(n))) + 1;
  const { version } = await newVersionFrom(ctx, latest.id, { edition: String(next) });
  return version;
}

export const QualityItemSchema = z.object({
  code: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().optional(),
});

/** "1" or "1.0" is Standard 1.0; "1.2" is a sub-standard of it. Anything else is refused. */
function parseQualityCode(raw: string): { code: string; parent: string | null } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) throw new ValidationError('use a number for a standard (e.g. 1) or two for a sub-standard (e.g. 1.2)');
  if (m[2] === undefined || m[2] === '0') return { code: m[1]!, parent: null };
  return { code: `${m[1]}.${m[2]}`, parent: m[1]! };
}

async function placeFor(ctx: Ctx, versionId: string, parentCode: string | null) {
  if (parentCode === null) return null;
  const [p] = await ctx.tx.select({ id: requirement.id, parentId: requirement.parentId }).from(requirement)
    .where(and(eq(requirement.frameworkVersionId, versionId), eq(requirement.code, parentCode)));
  if (!p || p.parentId) throw new ValidationError(`there is no Standard ${parentCode}.0 to put it under; add that standard first`);
  return p.id;
}

const friendlyDuplicate = (code: string) => (e: unknown) => {
  if (e instanceof ConflictError && /requirement_version_code_idx|duplicate/.test(e.message)) throw new ConflictError(`code ${code} is already used`);
  throw e;
};

/**
 * Adds a standard or a sub-standard to a draft of the internal framework. Where it goes follows from its code: 1 is a
 * standard, 1.2 sits under standard 1.
 */
export async function addQualityItem(ctx: Ctx, versionId: string, input: z.input<typeof QualityItemSchema>) {
  await require_(ctx, 'framework:write');
  await internalVersion(ctx, versionId);
  await getDraftVersion(ctx, versionId);
  const d = QualityItemSchema.parse(input);
  const { code, parent } = parseQualityCode(d.code);
  const parentId = await placeFor(ctx, versionId, parent);
  return createRequirement(ctx, {
    versionId, code, title: d.title, levelLabel: parent ? 'Sub-standard' : 'Standard', ...(parentId ? { parentId } : {}),
    ...(d.description?.trim() ? { officialText: d.description.trim() } : {}), isAssessable: parent !== null,
  }).catch(friendlyDuplicate(code));
}

/**
 * Edits a standard or sub-standard. A new code can move it (1.2 → 3.1 moves it under standard 3); renumbering a standard
 * renumbers its sub-standards with it (1 → 4 makes 1.2 into 4.2).
 */
export async function editQualityItem(ctx: Ctx, id: string, input: z.input<typeof QualityItemSchema>) {
  await require_(ctx, 'framework:write');
  const current = await getRequirement(ctx, id);
  await internalVersion(ctx, current.frameworkVersionId);
  await getDraftVersion(ctx, current.frameworkVersionId);
  const d = QualityItemSchema.parse(input);
  const { code, parent } = parseQualityCode(d.code);
  const children = await ctx.tx.select().from(requirement).where(eq(requirement.parentId, id));
  if (parent !== null && children.length) throw new ConflictError('a standard with sub-standards cannot become a sub-standard; move its sub-standards first');
  if (parent === current.code) throw new ValidationError('a standard cannot sit under itself');
  const parentId = await placeFor(ctx, current.frameworkVersionId, parent);
  if ((current.parentId ?? null) !== parentId) await moveRequirement(ctx, id, parentId);
  const updated = await updateRequirement(ctx, id, { code, title: d.title, officialText: d.description ?? '', isAssessable: parent !== null }).catch(friendlyDuplicate(code));
  if (parent === null && code !== current.code) {
    for (const c of children) {
      const renumbered = c.code.startsWith(`${current.code}.`) ? `${code}${c.code.slice(current.code.length)}` : c.code;
      if (renumbered !== c.code) await updateRequirement(ctx, c.id, { code: renumbered }).catch(friendlyDuplicate(renumbered));
    }
  }
  return updated;
}
