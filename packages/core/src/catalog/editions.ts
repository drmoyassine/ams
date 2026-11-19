// Catalog editions and versions (DEC-046, step 4). The structure being edited (concentrations, block credits, study plans, slots, General
// education, courses with their approved content, requisites) is the working draft of the one edition that is `working`. Publishing freezes
// it as the next version of that edition (a snapshot nothing can change), with the list of what changed since the version before. A new
// edition starts from what is live, which is the last published state plus the draft. Publishing needs program:write for the whole
// institution (Academic Affairs); the approval of a version is a later workflow module.
import { desc, eq, inArray, sql } from 'drizzle-orm';
import {
  appUser, catalogEdition, catalogVersion, concentration, course, courseProgram, courseRequisite, genedArea, genedAreaCourse, institution, learningOutcome, orgUnit, outcomeLink, program, programBlock,
  studyPlanSlot,
} from '@ams/db';
import {
  BLOCK_LABEL, type CatalogChange, type CatalogEdition, type CatalogEditions, type CatalogSnapshot, type CatalogVersion, type CatalogVersionSummary, type RequirementBlock, type SnapCourse, type SnapProgram,
} from '@ams/shared';
import { ConflictError, NotFoundError, ValidationError, type Ctx } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { unitPaths, type UnitRow } from '../org/programs-sheets.js';
import { assertPermitted } from '../permissions.js';
import { getCatalogSettings, getProgramRequirements } from './catalog.js';

const ALL = { type: 'institution' } as const;
const num = (v: string | number | null) => (v === null ? null : Number(v));
const blockLabel = (b: string) => BLOCK_LABEL[b as RequirementBlock] ?? b;

// ---- The snapshot -----------------------------------------------------------------------------------------------------------------

/** Everything the catalog prints, from the live records. A course's content is its approved content (the facts approval wrote to the course). */
export async function buildCatalogSnapshot(ctx: Ctx): Promise<CatalogSnapshot> {
  const [inst] = await ctx.tx.select({ nameEn: institution.nameEn, nameAr: institution.nameAr }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  const units: UnitRow[] = await ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId, nameEn: orgUnit.nameEn, code: orgUnit.code, active: orgUnit.active }).from(orgUnit);
  const paths = unitPaths(units);
  const top = (id: string | null): string | null => { let u = units.find((x) => x.id === id); while (u?.parentId) u = units.find((x) => x.id === u!.parentId); return u?.nameEn ?? null; };
  const settings = await getCatalogSettings(ctx);
  const programs = (await ctx.tx.select().from(program).where(eq(program.active, true))).sort((a, b) => (a.code ?? a.nameEn).localeCompare(b.code ?? b.nameEn, 'en', { numeric: true }));
  const allCourses = await ctx.tx.select().from(course).where(eq(course.active, true));
  const codeById = new Map(allCourses.map((c) => [c.id, c.code]));
  const outcomes = await ctx.tx.select().from(learningOutcome).where(inArray(learningOutcome.kind, ['ilo', 'peo', 'plo']));
  const links = await ctx.tx.select({ fromId: outcomeLink.fromId, toId: outcomeLink.toId }).from(outcomeLink);
  const concs = await ctx.tx.select().from(concentration).where(eq(concentration.active, true));
  const blocks = await ctx.tx.select().from(programBlock);
  const slots = await ctx.tx.select().from(studyPlanSlot);
  const plan = await ctx.tx.select().from(courseProgram);
  const areas = (await ctx.tx.select().from(genedArea).where(eq(genedArea.active, true))).sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code));
  const pools = await ctx.tx.select().from(genedAreaCourse);
  const reqs = await ctx.tx.select().from(courseRequisite);
  const concCode = (id: string | null) => (id ? concs.find((c) => c.id === id)?.code ?? null : null);
  const areaCode = (id: string | null) => (id ? areas.find((a) => a.id === id)?.code ?? null : null);
  const iloById = new Map(outcomes.filter((o) => o.kind === 'ilo' && o.status !== 'retired').map((o) => [o.id, o]));
  const alive = (o: { status: string }) => o.status !== 'retired';

  const snapPrograms: SnapProgram[] = programs.map((p) => {
    const mine = outcomes.filter((o) => o.programId === p.id && alive(o)).sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code, 'en', { numeric: true }));
    const pc = concs.filter((c) => c.programId === p.id).sort((a, b) => a.displayOrder - b.displayOrder);
    const ids = new Set(pc.map((c) => c.id));
    return {
      code: p.code ?? p.nameEn, nameEn: p.nameEn, nameAr: p.nameAr, type: p.programType, level: p.degreeLevel, unit: paths.get(p.orgUnitId) ?? null, college: top(p.orgUnitId),
      mode: p.mode, credits: p.credits, durationYears: num(p.durationYears), contactHours: p.contactHours, language: p.languageOfInstruction, mission: p.mission, vision: p.vision, description: p.description,
      peos: mine.filter((o) => o.kind === 'peo').map((o) => ({ code: o.code, textEn: o.textEn, textAr: o.textAr })),
      plos: mine.filter((o) => o.kind === 'plo').map((o) => ({ code: o.code, textEn: o.textEn, textAr: o.textAr, ilos: links.filter((l) => l.fromId === o.id && iloById.has(l.toId)).map((l) => iloById.get(l.toId)!.code).sort() })),
      concentrations: pc.map((c) => ({ code: c.code, nameEn: c.nameEn, nameAr: c.nameAr })),
      blocks: blocks.filter((b) => b.programId === p.id && (!b.concentrationId || ids.has(b.concentrationId))).map((b) => ({ concentration: concCode(b.concentrationId), block: b.block, requirement: b.requirement, credits: Number(b.credits) })),
      plan: plan.filter((x) => x.programId === p.id && codeById.has(x.courseId)).map((x) => ({ course: codeById.get(x.courseId)!, role: x.role, block: x.block, concentration: concCode(x.concentrationId), year: x.year, term: x.term }))
        .sort((a, b) => (a.year ?? 99) - (b.year ?? 99) || (a.term ?? 99) - (b.term ?? 99) || a.course.localeCompare(b.course, 'en', { numeric: true })),
      slots: slots.filter((s) => s.programId === p.id && (!s.concentrationId || ids.has(s.concentrationId))).map((s) => ({ concentration: concCode(s.concentrationId), block: s.block, requirement: s.requirement, area: areaCode(s.areaId), name: s.name, rule: s.rule, credits: Number(s.credits), year: s.year, term: s.term }))
        .sort((a, b) => (a.year ?? 99) - (b.year ?? 99) || (a.term ?? 99) - (b.term ?? 99) || a.name.localeCompare(b.name)),
    };
  });
  // The courses a catalog lists: those in a study plan or a General education pool.
  const used = new Set([...plan.filter((x) => programs.some((p) => p.id === x.programId)).map((x) => x.courseId), ...pools.map((x) => x.courseId)]);
  const groupsOf = (courseId: string, kind: 'prerequisite' | 'corequisite'): string[][] => {
    const out: string[][] = []; const byNo = new Map<number, string[]>();
    for (const r of reqs.filter((x) => x.courseId === courseId && x.kind === kind)) {
      const code = codeById.get(r.requisiteId); if (!code) continue;
      if (r.groupNo === null) { out.push([code]); continue; }
      let g = byNo.get(r.groupNo); if (!g) { g = []; byNo.set(r.groupNo, g); out.push(g); }
      g.push(code);
    }
    return out;
  };
  const snapCourses: SnapCourse[] = allCourses.filter((c) => used.has(c.id)).sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true })).map((c) => ({
    code: c.code, titleEn: c.titleEn, credits: num(c.credits), lecture: num(c.contactLecture), lab: num(c.contactLab), other: num(c.contactOther), unit: c.orgUnitId ? paths.get(c.orgUnitId) ?? null : null, year: c.level,
    description: c.description, language: c.languageOfInstruction, prerequisites: groupsOf(c.id, 'prerequisite'), corequisites: groupsOf(c.id, 'corequisite'), otherRequirements: c.otherRequirements,
  }));
  return {
    schema: 1, generatedAt: new Date().toISOString(), institution: { nameEn: inst?.nameEn ?? '', nameAr: inst?.nameAr ?? null, mission: null, vision: null },
    gened: { credits: settings.genedCredits, areas: areas.map((a) => ({ code: a.code, nameEn: a.nameEn, nameAr: a.nameAr, minCredits: Number(a.minCredits), courses: pools.filter((x) => x.areaId === a.id).map((x) => codeById.get(x.courseId)).filter((x): x is string => !!x).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) })) },
    ilos: [...iloById.values()].map((o) => ({ code: o.code, textEn: o.textEn, textAr: o.textAr })).sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true })),
    programs: snapPrograms, courses: snapCourses,
  };
}

// ---- What changed -------------------------------------------------------------------------------------------------------------------

const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? 'none' : String(v));
const when = (y: number | null, t: number | null) => (y ? `year ${y}${t ? ` term ${t}` : ''}` : 'no year');
const reqText = (g: string[][]) => g.map((x) => x.join(' or ')).join(' and ') || 'none';

/** The changes from one snapshot to the next, in words, grouped by what they are about. */
export function diffSnapshots(prev: CatalogSnapshot | null, next: CatalogSnapshot): CatalogChange[] {
  const out: CatalogChange[] = [];
  const add = (area: string, subject: string, text: string) => out.push({ area, subject, text });
  if (!prev) { add('Catalog', next.institution.nameEn, `First version: ${next.programs.length} program${next.programs.length === 1 ? '' : 's'} and ${next.courses.length} course${next.courses.length === 1 ? '' : 's'}.`); return out; }
  // General education
  if (prev.gened.credits !== next.gened.credits) add('General education', 'Credits', `General education credits: ${fmt(prev.gened.credits)} → ${fmt(next.gened.credits)}.`);
  for (const a of next.gened.areas) {
    const was = prev.gened.areas.find((x) => x.code === a.code);
    if (!was) { add('General education', a.code, `Area ${a.nameEn} added (at least ${a.minCredits} credits).`); continue; }
    if (was.minCredits !== a.minCredits) add('General education', a.code, `${a.nameEn}: minimum ${was.minCredits} → ${a.minCredits} credits.`);
    for (const c of a.courses.filter((x) => !was.courses.includes(x))) add('General education', a.code, `${c} added to ${a.nameEn}.`);
    for (const c of was.courses.filter((x) => !a.courses.includes(x))) add('General education', a.code, `${c} removed from ${a.nameEn}.`);
  }
  for (const a of prev.gened.areas.filter((x) => !next.gened.areas.some((y) => y.code === x.code))) add('General education', a.code, `Area ${a.nameEn} removed.`);
  // Programs
  for (const p of next.programs) {
    const was = prev.programs.find((x) => x.code === p.code);
    if (!was) { add('Program', p.code, `${p.nameEn} added${p.type === 'minor' ? ' (minor)' : ''}.`); continue; }
    const fields: [string, unknown, unknown][] = [['name', was.nameEn, p.nameEn], ['Arabic name', was.nameAr, p.nameAr], ['level', was.level, p.level], ['type', was.type, p.type], ['unit', was.unit, p.unit], ['mode', was.mode, p.mode],
      ['credits', was.credits, p.credits], ['years', was.durationYears, p.durationYears], ['contact hours', was.contactHours, p.contactHours], ['language', was.language, p.language], ['mission', was.mission, p.mission], ['vision', was.vision, p.vision]];
    for (const [name, a, b] of fields) if ((a ?? null) !== (b ?? null)) add('Program', p.code, name === 'mission' || name === 'vision' ? `The ${name} changed.` : `${name[0]!.toUpperCase()}${name.slice(1)}: ${fmt(a)} → ${fmt(b)}.`);
    for (const k of ['peos', 'plos'] as const) {
      const label = k === 'peos' ? 'PEO' : 'PLO';
      for (const o of p[k]) { const w = was[k].find((x) => x.code === o.code); if (!w) add('Program', p.code, `${label} ${o.code} added.`); else if (w.textEn !== o.textEn) add('Program', p.code, `${label} ${o.code} reworded.`); }
      for (const o of was[k].filter((x) => !p[k].some((y) => y.code === x.code))) add('Program', p.code, `${label} ${o.code} removed.`);
    }
    for (const c of p.concentrations.filter((x) => !was.concentrations.some((y) => y.code === x.code))) add('Program', p.code, `Concentration ${c.nameEn} added.`);
    for (const c of was.concentrations.filter((x) => !p.concentrations.some((y) => y.code === x.code))) add('Program', p.code, `Concentration ${c.nameEn} removed.`);
    const bkey = (b: SnapProgram['blocks'][number]) => `${b.concentration ?? ''}|${b.block}|${b.requirement}`;
    for (const b of p.blocks) { const w = was.blocks.find((x) => bkey(x) === bkey(b)); if (!w || w.credits !== b.credits) add('Program', p.code, `${b.concentration ? `${b.concentration} ` : ''}${blockLabel(b.block)} ${b.requirement} credits: ${w ? w.credits : 'none'} → ${b.credits}.`); }
    for (const b of was.blocks.filter((x) => !p.blocks.some((y) => bkey(y) === bkey(x)))) add('Program', p.code, `${b.concentration ? `${b.concentration} ` : ''}${blockLabel(b.block)} ${b.requirement} credits (${b.credits}) no longer asked.`);
    // The study plan
    for (const r of p.plan) {
      const w = was.plan.find((x) => x.course === r.course);
      if (!w) { add('Study plan', p.code, `${r.course} added (${blockLabel(r.block ?? '')}, ${r.role}, ${when(r.year, r.term)}).`); continue; }
      if (w.year !== r.year || w.term !== r.term) add('Study plan', p.code, `${r.course} moved from ${when(w.year, w.term)} to ${when(r.year, r.term)}.`);
      if (w.block !== r.block || w.role !== r.role || w.concentration !== r.concentration) add('Study plan', p.code, `${r.course}: now ${blockLabel(r.block ?? '')}, ${r.role}${r.concentration ? `, ${r.concentration}` : ''} (was ${blockLabel(w.block ?? '')}, ${w.role}${w.concentration ? `, ${w.concentration}` : ''}).`);
    }
    for (const r of was.plan.filter((x) => !p.plan.some((y) => y.course === x.course))) add('Study plan', p.code, `${r.course} removed.`);
    const skey = (s: SnapProgram['slots'][number]) => `${s.concentration ?? ''}|${s.block}|${s.name}`;
    for (const s of p.slots) { const w = was.slots.find((x) => skey(x) === skey(s)); if (!w) add('Study plan', p.code, `Slot "${s.name}" added (${s.credits} credits, ${when(s.year, s.term)}).`); else if (w.credits !== s.credits || w.year !== s.year || w.term !== s.term || w.rule !== s.rule) add('Study plan', p.code, `Slot "${s.name}" changed.`); }
    for (const s of was.slots.filter((x) => !p.slots.some((y) => skey(y) === skey(x)))) add('Study plan', p.code, `Slot "${s.name}" removed.`);
  }
  for (const p of prev.programs.filter((x) => !next.programs.some((y) => y.code === x.code))) add('Program', p.code, `${p.nameEn} removed.`);
  // Courses
  for (const c of next.courses) {
    const w = prev.courses.find((x) => x.code === c.code);
    if (!w) { add('Course', c.code, `${c.titleEn} added.`); continue; }
    const fields: [string, unknown, unknown][] = [['title', w.titleEn, c.titleEn], ['credit hours', w.credits, c.credits], ['lecture hours', w.lecture, c.lecture], ['lab hours', w.lab, c.lab], ['unit', w.unit, c.unit]];
    for (const [name, a, b] of fields) if ((a ?? null) !== (b ?? null)) add('Course', c.code, `${name[0]!.toUpperCase()}${name.slice(1)}: ${fmt(a)} → ${fmt(b)}.`);
    if ((w.description ?? '') !== (c.description ?? '')) add('Course', c.code, 'Description changed.');
    if (reqText(w.prerequisites) !== reqText(c.prerequisites)) add('Course', c.code, `Prerequisites: ${reqText(w.prerequisites)} → ${reqText(c.prerequisites)}.`);
    if (reqText(w.corequisites) !== reqText(c.corequisites)) add('Course', c.code, `Co-requisites: ${reqText(w.corequisites)} → ${reqText(c.corequisites)}.`);
    if ((w.otherRequirements ?? '') !== (c.otherRequirements ?? '')) add('Course', c.code, `Other requirements: ${fmt(w.otherRequirements)} → ${fmt(c.otherRequirements)}.`);
  }
  for (const c of prev.courses.filter((x) => !next.courses.some((y) => y.code === x.code))) add('Course', c.code, `${c.titleEn} removed.`);
  return out;
}

// ---- Editions and versions --------------------------------------------------------------------------------------------------------

async function names(ctx: Ctx, ids: (string | null)[]): Promise<Map<string, string>> {
  const set = [...new Set(ids.filter((x): x is string => !!x))];
  if (!set.length) return new Map();
  return new Map((await ctx.tx.select({ id: appUser.id, name: appUser.fullName }).from(appUser).where(inArray(appUser.id, set))).map((u) => [u.id, u.name]));
}
const summary = (v: Omit<typeof catalogVersion.$inferSelect, 'snapshot'>, who: Map<string, string>): CatalogVersionSummary => ({
  id: v.id, editionId: v.editionId, versionNo: v.versionNo, note: v.note, publishedAt: v.publishedAt.toISOString(), publishedByName: v.publishedBy ? who.get(v.publishedBy) ?? null : null, changeCount: (v.changes ?? []).length,
});

/** The editions with their versions, and the draft of the working edition (what publishing now would add, and what the checks flag). */
export async function listCatalogEditions(ctx: Ctx): Promise<CatalogEditions> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const editions = (await ctx.tx.select().from(catalogEdition).orderBy(desc(catalogEdition.createdAt)));
  const versions = await ctx.tx.select({ id: catalogVersion.id, createdAt: catalogVersion.createdAt, createdBy: catalogVersion.createdBy, updatedAt: catalogVersion.updatedAt, updatedBy: catalogVersion.updatedBy, institutionId: catalogVersion.institutionId,
    editionId: catalogVersion.editionId, versionNo: catalogVersion.versionNo, note: catalogVersion.note, changes: catalogVersion.changes, publishedAt: catalogVersion.publishedAt, publishedBy: catalogVersion.publishedBy }).from(catalogVersion).orderBy(desc(catalogVersion.versionNo));
  const who = await names(ctx, versions.map((v) => v.publishedBy));
  const working = editions.find((e) => e.status === 'working') ?? null;
  let draft: CatalogEditions['draft'] = null;
  if (working) {
    const mine = versions.filter((v) => v.editionId === working.id);
    const last = mine[0] ? (await ctx.tx.select({ s: catalogVersion.snapshot }).from(catalogVersion).where(eq(catalogVersion.id, mine[0].id)))[0]!.s as unknown as CatalogSnapshot : null;
    // Before the working edition has a version, the draft is compared with the last version of the edition before it.
    const base = last ?? (await previousSnapshot(ctx, working.id));
    draft = { nextVersionNo: (mine[0]?.versionNo ?? 0) + 1, changes: diffSnapshots(base, await buildCatalogSnapshot(ctx)), problems: await catalogProblems(ctx) };
  }
  return {
    editions: editions.map((e): CatalogEdition => ({ id: e.id, label: e.label, status: e.status, versions: versions.filter((v) => v.editionId === e.id).map((v) => summary(v, who)) })),
    workingId: working?.id ?? null, draft,
  };
}

/** The snapshot of the newest version of any edition other than `editionId` (the base a new edition's first version is compared with). */
async function previousSnapshot(ctx: Ctx, editionId: string): Promise<CatalogSnapshot | null> {
  const [row] = await ctx.tx.select({ s: catalogVersion.snapshot }).from(catalogVersion).where(sql`${catalogVersion.editionId} <> ${editionId}::uuid`).orderBy(desc(catalogVersion.publishedAt)).limit(1);
  return (row?.s as unknown as CatalogSnapshot) ?? null;
}

/** What the checks flag across the degree programs (a publish is never refused for them; the person sees them first). */
async function catalogProblems(ctx: Ctx): Promise<string[]> {
  const programs = await ctx.tx.select({ id: program.id, code: program.code, nameEn: program.nameEn }).from(program).where(eq(program.active, true));
  const out: string[] = [];
  for (const p of programs) for (const i of (await getProgramRequirements(ctx, p.id)).issues) out.push(`${p.code ?? p.nameEn}: ${i.message}`);
  return out;
}

/** Starts an edition (a new academic year). The edition being worked on is closed; the live data, which already holds its last state, is the new edition's draft. */
export async function startCatalogEdition(ctx: Ctx, label: string): Promise<CatalogEdition> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'program:write', ALL);
  const text = label.normalize('NFC').trim();
  if (!text) throw new ValidationError('an edition needs a label, for example 2026-27');
  const working = (await ctx.tx.select().from(catalogEdition).where(eq(catalogEdition.status, 'working')))[0];
  if (working) {
    const n = (await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(catalogVersion).where(eq(catalogVersion.editionId, working.id)))[0]!.n;
    if (!n) throw new ConflictError(`${working.label} has no published version yet: publish one, or keep working on it`);
    await ctx.tx.update(catalogEdition).set({ status: 'closed' }).where(eq(catalogEdition.id, working.id));
  }
  const [row] = await guardIntegrity(() => ctx.tx.insert(catalogEdition).values({ institutionId: ctx.caller.institutionId, label: text, status: 'working' }).returning());
  return { id: row!.id, label: row!.label, status: row!.status, versions: [] };
}

/** Freezes the live structure as the next version of the working edition. A first-ever publish also starts the edition if none is open. */
export async function publishCatalogVersion(ctx: Ctx, input: { note?: string | null | undefined }): Promise<CatalogVersionSummary> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'program:write', ALL);
  const working = (await ctx.tx.select().from(catalogEdition).where(eq(catalogEdition.status, 'working')))[0];
  if (!working) throw new ConflictError('there is no edition being worked on: start one first (for example 2026-27)');
  const [last] = await ctx.tx.select().from(catalogVersion).where(eq(catalogVersion.editionId, working.id)).orderBy(desc(catalogVersion.versionNo)).limit(1);
  const base = last ? (last.snapshot as unknown as CatalogSnapshot) : await previousSnapshot(ctx, working.id);
  const snapshot = await buildCatalogSnapshot(ctx);
  const changes = diffSnapshots(base, snapshot);
  if (last && !changes.length) throw new ConflictError(`nothing has changed since version ${last.versionNo} of ${working.label}`);
  const [row] = await ctx.tx.insert(catalogVersion).values({
    institutionId: ctx.caller.institutionId, editionId: working.id, versionNo: (last?.versionNo ?? 0) + 1, note: input.note?.trim() ? input.note.normalize('NFC').trim() : null,
    snapshot: snapshot as unknown as Record<string, unknown>, changes, publishedBy: ctx.caller.userId,
  }).returning();
  const who = await names(ctx, [row!.publishedBy]);
  const { snapshot: _s, ...rest } = row!; void _s;
  return summary(rest, who);
}

export async function getCatalogVersion(ctx: Ctx, id: string): Promise<CatalogVersion> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const [v] = await ctx.tx.select().from(catalogVersion).where(eq(catalogVersion.id, id));
  if (!v) throw new NotFoundError(`catalog version ${id}`);
  const [e] = await ctx.tx.select().from(catalogEdition).where(eq(catalogEdition.id, v.editionId));
  const who = await names(ctx, [v.publishedBy]);
  const { snapshot, ...rest } = v;
  return { ...summary(rest, who), editionLabel: e?.label ?? '', changes: v.changes, snapshot: snapshot as unknown as CatalogSnapshot };
}

/** The draft as a snapshot (what the next version would freeze), for preview. */
export async function previewCatalogSnapshot(ctx: Ctx): Promise<CatalogSnapshot> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  return buildCatalogSnapshot(ctx);
}

