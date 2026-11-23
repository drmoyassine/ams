// Quality Management as the IQF in operation (DEC-048): the settings on a standard (frequency, approval steps, the QA office), the
// tabs a person sees, the submissions of each scoped course, program, unit or the institution per period, and their approval.
// The rules that resolve people never guess: a step nobody can take is flagged, and the QA office may take it.
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  appUser, course, courseProgram, evidenceItem, evidenceLink, evidenceVersion, framework, institution, orgUnit, program, qualitySubmission,
  qualitySubmissionEvidence, qualitySubmissionStep, requirement, requirementApproval, requirementFrequency, roleAssignment,
} from '@ams/db';
import {
  ApprovalStepSchema, describeFrequency, FrequencyRuleSchema, SetRequirementApprovalSchema, SetRequirementFrequencySchema,
  type ApprovalStep, type DecideSubmission, type FrequencyRule, type OpenSubmission, type QualityStandardNode, type QualitySubjectKind, type QualityTabDetail,
  type QualityTabs, type RequirementQuality, type SaveSubmissionEvidence, type SetRequirementApproval, type SetRequirementFrequency, type SubmissionDetail,
  type SubmissionEvidence, type SubmissionStatus, type SubmissionStep, type SubmissionSummary,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';
import { calendarEntries } from '../cycles/calendar.js';
import { readVersionData } from '../evidence/dataset.js';
import { loadAssignments, referenceVersion, treeOf } from '../scope/assignments.js';
import { periodsBetween, type Period } from './frequency.js';

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

// ---- Settings on a standard ---------------------------------------------------------------------------------------------------

/** The institution's own framework (the IQF) and the version whose tree stands for it. */
async function iqf(ctx: Ctx): Promise<{ frameworkId: string; versionId: string } | null> {
  const [f] = await ctx.tx.select({ id: framework.id }).from(framework).where(eq(framework.internal, true));
  if (!f) return null;
  const versionId = await referenceVersion(ctx, f.id);
  return versionId ? { frameworkId: f.id, versionId } : null;
}

interface OwnQuality { rule: FrequencyRule | null; optOut: boolean; steps: ApprovalStep[] | null }
async function ownQuality(ctx: Ctx, frameworkId: string): Promise<Map<string, OwnQuality>> {
  const out = new Map<string, OwnQuality>();
  const at = (code: string) => { let o = out.get(code); if (!o) { o = { rule: null, optOut: false, steps: null }; out.set(code, o); } return o; };
  for (const f of await ctx.tx.select().from(requirementFrequency).where(eq(requirementFrequency.frameworkId, frameworkId))) {
    const o = at(f.code); o.optOut = f.optOut;
    const r = f.rule ? FrequencyRuleSchema.safeParse(f.rule) : null; o.rule = r?.success ? r.data : null;
  }
  for (const a of await ctx.tx.select().from(requirementApproval).where(eq(requirementApproval.frameworkId, frameworkId))) {
    const r = ApprovalStepSchema.array().safeParse(a.steps); at(a.code).steps = r.success ? r.data : [];
  }
  return out;
}

interface Effective { rule: FrequencyRule | null; anchor: string | null; steps: ApprovalStep[]; stepsFrom: string | null; ruleFrom: string | null }
/** Each node's frequency (own, else its parent's; an opt-out stops it) with the code it comes from, and its approval steps likewise. */
function resolveQuality(nodes: { code: string; parentCode: string | null }[], own: Map<string, OwnQuality>): Map<string, Effective> {
  const parentOf = new Map(nodes.map((n) => [n.code, n.parentCode] as const));
  const memo = new Map<string, Effective>();
  const get = (code: string, depth = 0): Effective => {
    const hit = memo.get(code); if (hit) return hit;
    const o = own.get(code);
    const p = parentOf.get(code) ?? null;
    const parent: Effective = p && depth < 50 ? get(p, depth + 1) : { rule: null, anchor: null, steps: [], stepsFrom: null, ruleFrom: null };
    const freq = o?.optOut ? { rule: null, anchor: null, ruleFrom: code } : o?.rule ? { rule: o.rule, anchor: code, ruleFrom: code } : { rule: parent.rule, anchor: parent.anchor, ruleFrom: parent.ruleFrom };
    const appr = o?.steps ? { steps: o.steps, stepsFrom: code } : { steps: parent.steps, stepsFrom: parent.stepsFrom };
    const r = { ...freq, ...appr };
    memo.set(code, r); return r;
  };
  for (const n of nodes) get(n.code);
  return memo;
}

/** Every standard's frequency and approval steps in a version: own, effective, and where it comes from. */
export async function getRequirementQuality(ctx: Ctx, versionId: string, frameworkId: string): Promise<RequirementQuality[]> {
  await assertPermitted(ctx, 'framework:read', { type: 'any' });
  const nodes = await treeOf(ctx, versionId);
  const own = await ownQuality(ctx, frameworkId);
  const eff = resolveQuality(nodes, own);
  return nodes.map((n) => {
    const o = own.get(n.code); const e = eff.get(n.code)!;
    return {
      code: n.code,
      frequency: { own: o?.rule ?? null, optOut: o?.optOut ?? false, effective: e.rule, source: e.rule && e.ruleFrom ? { kind: e.ruleFrom === n.code ? 'own' : 'parent', code: e.ruleFrom === n.code ? null : e.ruleFrom } : null, text: e.rule ? describeFrequency(e.rule) : null },
      approval: { own: o?.steps ?? null, effective: e.steps, source: e.stepsFrom ? { kind: e.stepsFrom === n.code ? 'own' : 'parent', code: e.stepsFrom === n.code ? null : e.stepsFrom } : null },
    };
  });
}

export async function setRequirementFrequency(ctx: Ctx, input: SetRequirementFrequency): Promise<void> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'framework:write', { type: 'any' });
  const d = SetRequirementFrequencySchema.parse(input);
  const where = and(eq(requirementFrequency.frameworkId, d.frameworkId), eq(requirementFrequency.code, d.code));
  await ctx.tx.delete(requirementFrequency).where(where);
  if (d.rule || d.optOut) await ctx.tx.insert(requirementFrequency).values({ institutionId: ctx.caller.institutionId, frameworkId: d.frameworkId, code: d.code, rule: d.rule, optOut: d.optOut });
}

export async function setRequirementApproval(ctx: Ctx, input: SetRequirementApproval): Promise<void> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'framework:write', { type: 'any' });
  const d = SetRequirementApprovalSchema.parse(input);
  const where = and(eq(requirementApproval.frameworkId, d.frameworkId), eq(requirementApproval.code, d.code));
  await ctx.tx.delete(requirementApproval).where(where);
  if (d.steps) await ctx.tx.insert(requirementApproval).values({ institutionId: ctx.caller.institutionId, frameworkId: d.frameworkId, code: d.code, steps: d.steps });
}

/** The unit whose head and members are the QA office step of every chain. */
export async function getQualityOffice(ctx: Ctx): Promise<{ unitId: string | null }> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const [r] = await ctx.tx.select({ u: institution.qualityOfficeUnitId }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  return { unitId: r?.u ?? null };
}
export async function setQualityOffice(ctx: Ctx, unitId: string | null): Promise<{ unitId: string | null }> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'org:write', { type: 'institution' });
  if (unitId && !(await ctx.tx.select({ id: orgUnit.id }).from(orgUnit).where(eq(orgUnit.id, unitId))).length) throw new ValidationError('No such unit.');
  await ctx.tx.update(institution).set({ qualityOfficeUnitId: unitId }).where(eq(institution.id, ctx.caller.institutionId));
  return { unitId };
}

// ---- The world a tab is computed from -----------------------------------------------------------------------------------------

interface Subject { kind: QualitySubjectKind; id: string | null; name: string; unitId: string | null; submitterId: string | null; programIds: string[] }
interface Anchor { code: string; title: string; rule: FrequencyRule; steps: ApprovalStep[]; subjects: Subject[]; champions: Map<string | null, string | null>; codes: string[] }
interface World {
  frameworkId: string; versionId: string;
  nodes: { code: string; parentCode: string | null; title: string; statement: string | null; order: number }[];
  anchors: Anchor[]; topOf: Map<string, string>;
  units: Map<string, { parentId: string | null; type: string; headUserId: string | null }>;
  programCoordinator: Map<string, string | null>;
  qaIds: Set<string>; names: Map<string, string>; me: string; readAll: boolean;
  terms: Awaited<ReturnType<typeof calendarEntries>>;
  evidenceByCode: Map<string, { id: string; title: string }[]>;
}

async function loadWorld(ctx: Ctx): Promise<World | null> {
  const fw = await iqf(ctx);
  if (!fw) return null;
  const reqs = await ctx.tx.select({ id: requirement.id, code: requirement.code, parentId: requirement.parentId, title: requirement.title, text: requirement.officialText, order: requirement.displayOrder })
    .from(requirement).where(eq(requirement.frameworkVersionId, fw.versionId)).orderBy(asc(requirement.displayOrder));
  const codeOf = new Map(reqs.map((r) => [r.id, r.code]));
  const nodes = reqs.map((r) => ({ code: r.code, parentCode: r.parentId ? codeOf.get(r.parentId) ?? null : null, title: r.title, statement: r.text, order: r.order }));
  const topOf = new Map<string, string>();
  const parentOf = new Map(nodes.map((n) => [n.code, n.parentCode] as const));
  for (const n of nodes) { let c = n.code; for (let i = 0; i < 50 && parentOf.get(c); i++) c = parentOf.get(c)!; topOf.set(n.code, c); }

  const eff = resolveQuality(nodes, await ownQuality(ctx, fw.frameworkId));
  const assignments = await loadAssignments(ctx, fw.versionId);
  const units = new Map((await ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId, type: orgUnit.type, head: orgUnit.headUserId, name: orgUnit.nameEn, active: orgUnit.active }).from(orgUnit))
    .map((u) => [u.id, { parentId: u.parentId, type: u.type, headUserId: u.head, name: u.name, active: u.active }]));
  const progs = await ctx.tx.select({ id: program.id, name: program.nameEn, code: program.code, unit: program.orgUnitId, coord: program.coordinatorUserId, active: program.active }).from(program);
  const programCoordinator = new Map(progs.map((p) => [p.id, p.coord]));
  const courses = await ctx.tx.select({ id: course.id, code: course.code, title: course.titleEn, unit: course.orgUnitId, coord: course.coordinatorUserId, active: course.active }).from(course);
  const placements = await ctx.tx.select({ c: courseProgram.courseId, p: courseProgram.programId }).from(courseProgram);
  const programsOf = new Map<string, string[]>();
  for (const x of placements) programsOf.set(x.c, [...(programsOf.get(x.c) ?? []), x.p]);

  const [inst] = await ctx.tx.select({ name: institution.nameEn, qa: institution.qualityOfficeUnitId }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  const qaIds = new Set<string>();
  if (inst?.qa) {
    const head = units.get(inst.qa)?.headUserId; if (head) qaIds.add(head);
    for (const r of await ctx.tx.select({ u: roleAssignment.userId }).from(roleAssignment).where(and(eq(roleAssignment.scopeType, 'org_unit'), eq(roleAssignment.scopeId, inst.qa)))) qaIds.add(r.u);
  }
  const me = ctx.caller.userId ?? '';
  const admin = (await ctx.tx.select({ r: roleAssignment.role }).from(roleAssignment).where(and(eq(roleAssignment.userId, me), eq(roleAssignment.role, 'admin')))).length > 0;
  const names = new Map((await ctx.tx.select({ id: appUser.id, n: appUser.fullName }).from(appUser)).map((u) => [u.id, u.n]));

  // The evidence linked to each standard (approved links only), by code.
  const links = await ctx.tx.select({ code: evidenceLink.internalCode, itemId: evidenceVersion.evidenceItemId, title: evidenceItem.title, status: evidenceItem.status })
    .from(evidenceLink).innerJoin(evidenceVersion, eq(evidenceVersion.id, evidenceLink.evidenceVersionId)).innerJoin(evidenceItem, eq(evidenceItem.id, evidenceVersion.evidenceItemId))
    .where(and(eq(evidenceLink.internalFrameworkId, fw.frameworkId), eq(evidenceLink.reviewStatus, 'approved')));
  const evidenceByCode = new Map<string, { id: string; title: string }[]>();
  for (const l of links) {
    if (!l.code || l.status !== 'active') continue;
    const list = evidenceByCode.get(l.code) ?? [];
    if (!list.some((x) => x.id === l.itemId)) list.push({ id: l.itemId, title: l.title });
    evidenceByCode.set(l.code, list);
  }

  // Anchors: the standards whose own frequency applies; the sub-standards that inherit it join their submission.
  const anchors: Anchor[] = [];
  for (const n of nodes) {
    const e = eff.get(n.code)!;
    if (!e.rule || e.anchor !== n.code) continue;
    const a = assignments.get(n.code);
    const subjects: Subject[] = [];
    for (const lvl of a?.scope.effective?.levels ?? []) {
      const ids = new Set(lvl.items.map((i) => i.id));
      if (lvl.kind === 'course') for (const c of courses) { if ((lvl.all ? c.active : ids.has(c.id))) subjects.push({ kind: 'course', id: c.id, name: `${c.code} ${c.title}`, unitId: c.unit, submitterId: c.coord, programIds: programsOf.get(c.id) ?? [] }); }
      if (lvl.kind === 'program') for (const p of progs) { if ((lvl.all ? p.active : ids.has(p.id))) subjects.push({ kind: 'program', id: p.id, name: p.name, unitId: p.unit, submitterId: p.coord, programIds: [p.id] }); }
      if (lvl.kind === 'org_unit') for (const [id, u] of units) { if ((lvl.all ? u.active : ids.has(id))) subjects.push({ kind: 'org_unit', id, name: u.name, unitId: id, submitterId: u.headUserId, programIds: [] }); }
      if (lvl.kind === 'institution') subjects.push({ kind: 'institution', id: null, name: inst?.name ?? 'The institution', unitId: null, submitterId: null, programIds: [] });
    }
    const champions = new Map<string | null, string | null>((a?.champion.effective ?? []).map((c) => [c.itemKind && c.itemId ? `${c.itemKind}:${c.itemId}` : null, c.userId]));
    for (const s of subjects) if (s.kind === 'institution') s.submitterId = champions.get(null) ?? null;
    const codes = nodes.filter((m) => eff.get(m.code)?.anchor === n.code).map((m) => m.code);
    anchors.push({ code: n.code, title: n.title, rule: e.rule, steps: e.steps, subjects, champions, codes });
  }
  return {
    frameworkId: fw.frameworkId, versionId: fw.versionId, nodes, anchors, topOf, units, programCoordinator, qaIds, names, me,
    readAll: admin || qaIds.has(me), terms: await calendarEntries(ctx), evidenceByCode,
  };
}

/** The head of the nearest unit of a type at or above a unit. */
function headOfType(w: World, unitId: string | null, type: string): string | null {
  for (let u = unitId, i = 0; u && i < 50; i++) { const x = w.units.get(u); if (!x) return null; if (x.type === type) return x.headUserId; u = x.parentId; }
  return null;
}

interface ResolvedStep { kind: string; label: string; approverIds: string[] }
/** The chain of a subject: the standard's steps, then the QA office, then the champion. */
function chainOf(w: World, a: Anchor, s: Subject): ResolvedStep[] {
  const steps: ResolvedStep[] = a.steps.map((st) => {
    if (st.kind === 'program_coordinator') return { kind: st.kind, label: st.label ?? 'Program coordinator', approverIds: [...new Set(s.programIds.map((p) => w.programCoordinator.get(p)).filter((x): x is string => !!x))] };
    if (st.kind === 'unit_head') { const h = headOfType(w, s.unitId, st.unitType); return { kind: st.kind, label: st.label ?? `Head of the ${st.unitType}`, approverIds: h ? [h] : [] }; }
    return { kind: st.kind, label: st.label ?? (w.names.get(st.userId) ?? 'Approver'), approverIds: [st.userId] };
  });
  steps.push({ kind: 'qa_office', label: 'QA office', approverIds: [...w.qaIds] });
  const champ = (s.id ? a.champions.get(`${s.kind}:${s.id}`) : undefined) ?? a.champions.get(null) ?? null;
  steps.push({ kind: 'champion', label: 'Champion', approverIds: champ ? [champ] : [] });
  return steps;
}

const periodsOf = (w: World, a: Anchor, from: string, to: string): Period[] => periodsBetween(a.rule, from, to, w.terms.map((t) => ({ name: t.name, kind: t.kind, start: t.start, end: t.end })));
/** The periods a tab offers: the last year's and the next one to come. */
function windowOf(w: World, a: Anchor): Period[] {
  const t = today();
  const past = periodsOf(w, a, shift(t, -366), t);
  const next = periodsOf(w, a, shift(t, 1), shift(t, 400))[0];
  return [...past, ...(next ? [next] : [])];
}

// ---- Tabs --------------------------------------------------------------------------------------------------------------------

type Row = typeof qualitySubmission.$inferSelect;
async function storedFor(ctx: Ctx, w: World, codes: string[]): Promise<Row[]> {
  if (!codes.length) return [];
  return ctx.tx.select().from(qualitySubmission).where(and(eq(qualitySubmission.frameworkId, w.frameworkId), inArray(qualitySubmission.code, codes)));
}
const subjectKey = (kind: string, id: string | null) => `${kind}:${id ?? ''}`;

/** The tabs of Quality Management for the caller: the top-level standards they submit or approve for (DEC-048). */
export async function qualityTabs(ctx: Ctx): Promise<QualityTabs> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const w = await loadWorld(ctx);
  if (!w) return { frameworkId: null, versionId: null, tabs: [] };
  const tabs = new Map<string, { roles: Set<'submit' | 'approve' | 'read'>; toSubmit: number; toApprove: number }>();
  const stored = await storedFor(ctx, w, w.anchors.map((a) => a.code));
  const steps = stored.length ? await ctx.tx.select().from(qualitySubmissionStep).where(inArray(qualitySubmissionStep.submissionId, stored.map((s) => s.id))) : [];
  for (const a of w.anchors) {
    const top = w.topOf.get(a.code)!;
    const current = windowOf(w, a).filter((p) => p.due >= shift(today(), -366));
    for (const s of a.subjects) {
      const chain = chainOf(w, a, s);
      const submit = s.submitterId === w.me;
      const approve = chain.some((c) => c.approverIds.includes(w.me));
      if (!submit && !approve) continue;
      const t = tabs.get(top) ?? { roles: new Set(), toSubmit: 0, toApprove: 0 }; tabs.set(top, t);
      if (submit) t.roles.add('submit'); if (approve) t.roles.add('approve');
      for (const p of current) {
        const row = stored.find((r) => r.code === a.code && subjectKey(r.subjectKind, r.subjectId) === subjectKey(s.kind, s.id) && r.periodKey === p.key);
        if (submit && (!row || row.status === 'draft' || row.status === 'returned') && p.due <= shift(today(), 31)) t.toSubmit++;
        if (row?.status === 'submitted') {
          const pend = steps.filter((x) => x.submissionId === row.id && x.round === row.round && x.decision === 'pending').sort((x, y) => x.ordinal - y.ordinal)[0];
          if (pend && (pend.approverIds.includes(w.me) || (!pend.approverIds.length && w.qaIds.has(w.me)))) t.toApprove++;
        }
      }
    }
  }
  if (w.readAll) for (const n of w.nodes.filter((x) => !x.parentCode)) if (!tabs.has(n.code)) tabs.set(n.code, { roles: new Set(['read']), toSubmit: 0, toApprove: 0 });
  const order = new Map(w.nodes.map((n, i) => [n.code, i]));
  return {
    frameworkId: w.frameworkId, versionId: w.versionId,
    tabs: [...tabs].sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).map(([code, t]) => ({
      frameworkId: w.frameworkId, code, title: w.nodes.find((n) => n.code === code)?.title ?? code, roles: [...t.roles], toSubmit: t.toSubmit, toApprove: t.toApprove,
    })),
  };
}

function standardTree(w: World, code: string, depth = 0): QualityStandardNode {
  const n = w.nodes.find((x) => x.code === code)!;
  const a = w.anchors.find((x) => x.codes.includes(code));
  return {
    code, title: n.title, statement: n.statement, depth,
    frequency: a && a.code === code ? describeFrequency(a.rule) : null,
    evidence: w.evidenceByCode.get(code) ?? [],
    children: w.nodes.filter((x) => x.parentCode === code).map((x) => standardTree(w, x.code, depth + 1)),
  };
}

function summarize(w: World, a: Anchor, s: Subject, p: { key: string; label: string; start: string; dueAt: Date }, row: Row | undefined, steps: (typeof qualitySubmissionStep.$inferSelect)[], done: number): SubmissionSummary {
  const status: SubmissionStatus = row ? row.status : 'not_started';
  const now = Date.now();
  const pend = row ? steps.filter((x) => x.submissionId === row.id && x.round === row.round && x.decision === 'pending').sort((x, y) => x.ordinal - y.ordinal)[0] : undefined;
  const open = status === 'not_started' || status === 'draft' || status === 'returned';
  const mine = s.submitterId === w.me;
  return {
    id: row?.id ?? null, frameworkId: w.frameworkId, code: a.code, title: a.title,
    subjectKind: s.kind, subjectId: s.id, subjectName: s.name,
    periodKey: p.key, periodLabel: p.label, periodStart: p.start, dueAt: (row?.dueAt ?? p.dueAt).toISOString(),
    status, late: open && p.dueAt.getTime() < now, dueSoon: open && p.dueAt.getTime() >= now && p.dueAt.getTime() - now < 7 * DAY,
    submitter: s.submitterId ? { id: s.submitterId, name: w.names.get(s.submitterId) ?? '' } : null,
    can: { edit: mine && open, submit: mine && open, decide: status === 'submitted' && !!pend && (pend.approverIds.includes(w.me) || (!pend.approverIds.length && w.qaIds.has(w.me))) },
    waitingOn: status === 'submitted' && pend ? pend.label : null,
    evidenceDone: done, evidenceTotal: requiredOf(w, a).length,
  };
}

/** The evidence a submission of an anchor asks for: what is linked to it and to the sub-standards sharing its frequency. */
function requiredOf(w: World, a: Anchor): { id: string; title: string; codes: string[] }[] {
  const out = new Map<string, { id: string; title: string; codes: string[] }>();
  for (const c of a.codes) for (const e of w.evidenceByCode.get(c) ?? []) { const x = out.get(e.id) ?? { ...e, codes: [] }; x.codes.push(c); out.set(e.id, x); }
  return [...out.values()];
}

/** One tab: the standard read-only and the caller's submissions for a period (`current`: the open ones and the next to come). */
export async function qualityTab(ctx: Ctx, code: string, periodKey = 'current'): Promise<QualityTabDetail> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const w = await loadWorld(ctx);
  if (!w || !w.nodes.some((n) => n.code === code && !n.parentCode)) throw new NotFoundError(`standard ${code}`);
  const anchors = w.anchors.filter((a) => w.topOf.get(a.code) === code);
  const stored = await storedFor(ctx, w, anchors.map((a) => a.code));
  const steps = stored.length ? await ctx.tx.select().from(qualitySubmissionStep).where(inArray(qualitySubmissionStep.submissionId, stored.map((s) => s.id))) : [];
  const answered = stored.length ? await ctx.tx.select({ s: qualitySubmissionEvidence.submissionId, v: qualitySubmissionEvidence.evidenceVersionId }).from(qualitySubmissionEvidence).where(inArray(qualitySubmissionEvidence.submissionId, stored.map((s) => s.id))) : [];
  const periods = new Map<string, string>();
  const submissions: SubmissionSummary[] = [];
  for (const a of anchors) {
    const win = windowOf(w, a);
    for (const p of win) periods.set(p.key, p.label);
    const next = win[win.length - 1];
    for (const s of a.subjects) {
      const chain = chainOf(w, a, s);
      const mine = s.submitterId === w.me || chain.some((c) => c.approverIds.includes(w.me)) || (chain.some((c) => c.kind === 'qa_office') && w.qaIds.has(w.me));
      if (!mine && !w.readAll) continue;
      for (const p of win) {
        const row = stored.find((r) => r.code === a.code && subjectKey(r.subjectKind, r.subjectId) === subjectKey(s.kind, s.id) && r.periodKey === p.key);
        const show = periodKey === 'current'
          ? p === next || (row ? row.status !== 'approved' : p.dueAt.getTime() < Date.now() && p.due >= shift(today(), -100))
          : p.key === periodKey;
        if (!show) continue;
        submissions.push(summarize(w, a, s, p, row, steps, row ? answered.filter((x) => x.s === row.id && x.v).length : 0));
      }
    }
  }
  submissions.sort((x, y) => x.dueAt.localeCompare(y.dueAt) || x.subjectName.localeCompare(y.subjectName));
  return { standard: standardTree(w, code), periods: [...periods].reverse().map(([key, label]) => ({ key, label })), submissions };
}

// ---- One submission ----------------------------------------------------------------------------------------------------------

interface Located { w: World; a: Anchor; s: Subject; p: Period; row: Row | undefined }
async function locate(ctx: Ctx, input: { code: string; subjectKind: string; subjectId: string | null; periodKey: string }): Promise<Located> {
  const w = await loadWorld(ctx);
  if (!w) throw new NotFoundError('the institution\'s framework');
  const a = w.anchors.find((x) => x.code === input.code);
  if (!a) throw new NotFoundError(`a standard with a frequency, ${input.code}`);
  const s = a.subjects.find((x) => x.kind === input.subjectKind && x.id === input.subjectId);
  if (!s) throw new NotFoundError('that item in the standard\'s scope');
  const p = periodsOf(w, a, '1900-01-01', shift(today(), 400)).find((x) => x.key === input.periodKey);
  if (!p) throw new NotFoundError(`the period ${input.periodKey}`);
  const [row] = await ctx.tx.select().from(qualitySubmission).where(and(eq(qualitySubmission.frameworkId, w.frameworkId), eq(qualitySubmission.code, a.code), eq(qualitySubmission.subjectKind, s.kind), eq(qualitySubmission.periodKey, p.key)))
    .then((rows) => rows.filter((r) => r.subjectId === s.id));
  return { w, a, s, p, row };
}
async function locateById(ctx: Ctx, id: string): Promise<Located & { row: Row }> {
  const [row] = await ctx.tx.select().from(qualitySubmission).where(eq(qualitySubmission.id, id));
  if (!row) throw new NotFoundError(`submission ${id}`);
  const l = await locate(ctx, { code: row.code, subjectKind: row.subjectKind, subjectId: row.subjectId, periodKey: row.periodKey });
  return { ...l, row };
}
function assertMayRead(l: Located) {
  const chain = chainOf(l.w, l.a, l.s);
  if (l.s.submitterId === l.w.me || l.w.readAll || chain.some((c) => c.approverIds.includes(l.w.me))) return;
  throw new ForbiddenError('This submission is not yours to see.');
}

async function detail(ctx: Ctx, l: Located): Promise<SubmissionDetail> {
  const rows = l.row ? await ctx.tx.select().from(qualitySubmissionStep).where(eq(qualitySubmissionStep.submissionId, l.row.id)).orderBy(asc(qualitySubmissionStep.round), asc(qualitySubmissionStep.ordinal)) : [];
  const answers = l.row ? await ctx.tx.select().from(qualitySubmissionEvidence).where(eq(qualitySubmissionEvidence.submissionId, l.row.id)) : [];
  const required = requiredOf(l.w, l.a);
  const items = required.length ? await ctx.tx.select().from(evidenceItem).where(inArray(evidenceItem.id, required.map((r) => r.id))) : [];
  const versions = required.length ? await ctx.tx.select().from(evidenceVersion).where(inArray(evidenceVersion.evidenceItemId, required.map((r) => r.id))) : [];
  const evidence: SubmissionEvidence[] = [];
  for (const r of required) {
    const it = items.find((x) => x.id === r.id)!;
    const ans = answers.find((x) => x.evidenceItemId === r.id);
    const mineVersions = versions.filter((v) => v.evidenceItemId === r.id).sort((x, y) => y.versionNo - x.versionNo);
    const v = ans?.evidenceVersionId ? mineVersions.find((x) => x.id === ans.evidenceVersionId) : undefined;
    const latest = mineVersions[0];
    let rows: Record<string, unknown>[] | null = null;
    const dataVersion = v ?? (it.type === 'dataset' ? latest : undefined);
    if (it.type === 'dataset' && dataVersion) {
      try { rows = sliceRows(await readVersionData(ctx, dataVersion.id), l); } catch { rows = null; }
    }
    evidence.push({
      itemId: r.id, title: it.title, type: it.type, method: it.method, codes: r.codes,
      versionId: v?.id ?? null, versionNo: v?.versionNo ?? null, fileName: v?.fileName ?? null, asOfDate: v?.asOfDate ?? null,
      latestVersionId: latest?.id ?? null, latestVersionNo: latest?.versionNo ?? null, rows, note: ans?.note ?? null,
    });
  }
  const summary = summarize(l.w, l.a, l.s, l.p, l.row, rows, answers.filter((x) => x.evidenceVersionId).length);
  const chain = chainOf(l.w, l.a, l.s);
  const steps: SubmissionStep[] = rows.length
    ? rows.map((x) => ({ round: x.round, ordinal: x.ordinal, kind: x.kind, label: x.label, approvers: x.approverIds.map((id) => ({ id, name: l.w.names.get(id) ?? '' })), unresolved: !x.approverIds.length, decision: x.decision, decidedBy: x.decidedBy ? l.w.names.get(x.decidedBy) ?? null : null, decidedAt: x.decidedAt?.toISOString() ?? null, note: x.note }))
    : chain.map((c, i) => ({ round: 1, ordinal: i, kind: c.kind, label: c.label, approvers: c.approverIds.map((id) => ({ id, name: l.w.names.get(id) ?? '' })), unresolved: !c.approverIds.length, decision: 'pending' as const, decidedBy: null, decidedAt: null, note: null }));
  return { ...summary, evidence, steps, round: l.row?.round ?? 1 };
}

/** A dataset's rows for the item and period: matched on a course/program/unit column and a term column when the dataset has them. */
function sliceRows(data: { columns: { key: string }[]; rows: Record<string, unknown>[] }, l: Located): Record<string, unknown>[] {
  const keys = new Set(data.columns.map((c) => c.key));
  const norm = (x: unknown) => String(x ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const subjectCol = l.s.kind === 'course' ? 'course' : l.s.kind === 'program' ? 'program' : l.s.kind === 'org_unit' ? 'unit' : null;
  const subjectText = norm(l.s.kind === 'course' ? l.s.name.split(' ')[0] : l.s.name);
  return data.rows.filter((r) => {
    if (subjectCol && keys.has(subjectCol) && !norm(r[subjectCol]).startsWith(subjectText)) return false;
    if (keys.has('term') && l.a.rule.every === 'semester' && norm(r.term) !== norm(l.p.label)) return false;
    return true;
  });
}

/** The submission of a standard for an item and a period, as it is (not started when nobody has opened it). */
export async function getSubmission(ctx: Ctx, input: OpenSubmission): Promise<SubmissionDetail> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const l = await locate(ctx, input);
  assertMayRead(l);
  return detail(ctx, l);
}
export async function getSubmissionById(ctx: Ctx, id: string): Promise<SubmissionDetail> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const l = await locateById(ctx, id);
  assertMayRead(l);
  return detail(ctx, l);
}

/** Starts the submission (the submitter only): a draft row for the item and period. */
export async function openSubmission(ctx: Ctx, input: OpenSubmission): Promise<SubmissionDetail> {
  assertHuman(ctx);
  const l = await locate(ctx, input);
  if (l.s.submitterId !== l.w.me) throw new ForbiddenError('Only the person who submits for this item can start it.');
  if (!l.row) {
    const [row] = await ctx.tx.insert(qualitySubmission).values({
      institutionId: ctx.caller.institutionId, frameworkId: l.w.frameworkId, code: l.a.code, subjectKind: l.s.kind, subjectId: l.s.id,
      periodKey: l.p.key, periodLabel: l.p.label, periodStart: l.p.start, dueAt: l.p.dueAt,
    }).returning();
    l.row = row!;
  }
  return detail(ctx, l);
}

/** Answers one evidence item with a version of it (a new upload or one to reuse); null clears it. */
export async function saveSubmissionEvidence(ctx: Ctx, id: string, input: SaveSubmissionEvidence): Promise<SubmissionDetail> {
  assertHuman(ctx);
  const l = await locateById(ctx, id);
  if (l.s.submitterId !== l.w.me) throw new ForbiddenError('Only the person who submits for this item can change it.');
  if (l.row.status === 'submitted' || l.row.status === 'approved') throw new ConflictError('It is with the approvers: it changes only when it is returned.');
  if (!requiredOf(l.w, l.a).some((r) => r.id === input.itemId)) throw new ValidationError('That evidence is not asked for by this standard.');
  if (input.versionId) {
    const [v] = await ctx.tx.select({ item: evidenceVersion.evidenceItemId }).from(evidenceVersion).where(eq(evidenceVersion.id, input.versionId));
    if (!v || v.item !== input.itemId) throw new ValidationError('That version is not one of this evidence item.');
  }
  await ctx.tx.delete(qualitySubmissionEvidence).where(and(eq(qualitySubmissionEvidence.submissionId, id), eq(qualitySubmissionEvidence.evidenceItemId, input.itemId)));
  if (input.versionId || input.note) await ctx.tx.insert(qualitySubmissionEvidence).values({ institutionId: ctx.caller.institutionId, submissionId: id, evidenceItemId: input.itemId, evidenceVersionId: input.versionId, note: input.note ?? null });
  return detail(ctx, l);
}

/** Submits it: every item answered; the round's steps are made, a step of the submitter's own is skipped. */
export async function submitSubmission(ctx: Ctx, id: string): Promise<SubmissionDetail> {
  assertHuman(ctx);
  const l = await locateById(ctx, id);
  if (l.s.submitterId !== l.w.me) throw new ForbiddenError('Only the person who submits for this item can submit it.');
  if (l.row.status !== 'draft' && l.row.status !== 'returned') throw new ConflictError('It has been submitted already.');
  const answers = await ctx.tx.select().from(qualitySubmissionEvidence).where(eq(qualitySubmissionEvidence.submissionId, id));
  const missing = requiredOf(l.w, l.a).filter((r) => !answers.some((x) => x.evidenceItemId === r.id && x.evidenceVersionId));
  if (missing.length) throw new ValidationError(`Provide the evidence first: ${missing.map((m) => m.title).join(', ')}.`);
  const round = l.row.status === 'returned' ? l.row.round + 1 : l.row.round;
  const chain = chainOf(l.w, l.a, l.s);
  await ctx.tx.insert(qualitySubmissionStep).values(chain.map((c, i) => {
    const self = c.approverIds.length > 0 && c.approverIds.every((x) => x === l.w.me);
    return { institutionId: ctx.caller.institutionId, submissionId: id, round, ordinal: i, kind: c.kind, label: c.label, approverIds: c.approverIds, decision: self ? 'skipped' as const : 'pending' as const, note: self ? 'The submitter\'s own step.' : null };
  }));
  await ctx.tx.update(qualitySubmission).set({ status: 'submitted', round, submittedBy: l.w.me, submittedAt: new Date() }).where(eq(qualitySubmission.id, id));
  const [row] = await ctx.tx.select().from(qualitySubmission).where(eq(qualitySubmission.id, id));
  return detail(ctx, { ...l, row: row! });
}

/** The current step decides: approve (the last approval makes it "Internally approved") or return it to the submitter with a note. */
export async function decideSubmission(ctx: Ctx, id: string, input: DecideSubmission): Promise<SubmissionDetail> {
  assertHuman(ctx);
  const l = await locateById(ctx, id);
  if (l.row.status !== 'submitted') throw new ConflictError('It is not waiting for a decision.');
  const pending = (await ctx.tx.select().from(qualitySubmissionStep).where(and(eq(qualitySubmissionStep.submissionId, id), eq(qualitySubmissionStep.round, l.row.round), eq(qualitySubmissionStep.decision, 'pending'))))
    .sort((a, b) => a.ordinal - b.ordinal);
  const step = pending[0];
  if (!step) throw new ConflictError('No step is waiting.');
  const mayTake = step.approverIds.includes(l.w.me) || (!step.approverIds.length && l.w.qaIds.has(l.w.me));
  if (!mayTake) throw new ForbiddenError(`It is waiting for ${step.label}.`);
  await ctx.tx.update(qualitySubmissionStep).set({ decision: input.decision, decidedBy: l.w.me, decidedAt: new Date(), note: input.note ?? null }).where(eq(qualitySubmissionStep.id, step.id));
  if (input.decision === 'returned') await ctx.tx.update(qualitySubmission).set({ status: 'returned' }).where(eq(qualitySubmission.id, id));
  else if (pending.length === 1) await ctx.tx.update(qualitySubmission).set({ status: 'approved', approvedAt: new Date() }).where(eq(qualitySubmission.id, id));
  const [row] = await ctx.tx.select().from(qualitySubmission).where(eq(qualitySubmission.id, id));
  return detail(ctx, { ...l, row: row! });
}
