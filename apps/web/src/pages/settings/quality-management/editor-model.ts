// The template editor's working model (TASK-079): a draft-friendly copy of a template's stages that may be unfinished (empty
// names, half-chosen rules), converted to and from the stored `StageDef`s, and checked in plain words. Inputs that read an earlier
// output point at it by an id of this editor (`uid`), so moving or renaming stages never breaks them; the stored key of a stage
// and of its outputs is fixed once saved (cycles launched from a version, and `previousCycle` inputs, refer to it).
import {
  validateTemplateStages, type CycleOutputKind, type CyclePickKind, type PersonRule, type StageDef, type TemplateIssue, type UnitRule,
} from '@ams/shared';

let counter = 0;
export const uid = () => { counter += 1; return `e${counter}`; };

export type InputSource = 'stage_output' | 'previous_cycle' | 'pick';
export interface EOutput { uid: string; key: string; name: string; nameAr: string; kind: CycleOutputKind; required: boolean; reportTemplateKey: string; approver: PersonRule | null }
/** `refStage` and `refOutput` are editor ids, or `raw:<key>` for a key the template holds that matches nothing (a draft saved with a mistake). */
export interface EInput { uid: string; key: string; name: string; nameAr: string; required: boolean; source: InputSource; refStage: string; refOutput: string; pick: CyclePickKind }
export interface EStage {
  uid: string; key: string; name: string; nameAr: string; process: string; /** One item per line. */ checklist: string; unit: UnitRule; owner: PersonRule;
  start: string; length: string; outputs: EOutput[]; inputs: EInput[]; child?: StageDef['child'];
}

// ---- Keys ----------------------------------------------------------------------------------------------------------------

/** A stored key from a name: lower-case letters, digits and _, starting with a letter (Arabic-only names fall back to `fallback`). */
export function slug(name: string, fallback: string): string {
  const s = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/, '');
  if (!s) return fallback;
  return /^[a-z]/.test(s) ? s : `${fallback}_${s}`.slice(0, 48);
}
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) { const k = `${base.slice(0, 44)}_${n}`; if (!used.has(k)) return k; }
}

// ---- Stored <-> editing --------------------------------------------------------------------------------------------------

export function fromDefs(defs: readonly StageDef[]): EStage[] {
  const stageUid = new Map<string, string>();
  const outUid = new Map<string, string>();
  const stages: EStage[] = defs.map((d) => {
    const u = uid();
    stageUid.set(d.key, u);
    return {
      uid: u, key: d.key, name: d.name, nameAr: d.nameAr ?? '', process: d.process, checklist: d.checklist.join('\n'), unit: d.unit, owner: d.owner,
      start: String(d.startOffsetDays), length: String(d.lengthDays), ...(d.child ? { child: d.child } : {}),
      outputs: d.outputs.map((o) => {
        const ou = uid();
        outUid.set(`${d.key}/${o.key}`, ou);
        return { uid: ou, key: o.key, name: o.name, nameAr: o.nameAr ?? '', kind: o.kind, required: o.required, reportTemplateKey: o.reportTemplateKey ?? '', approver: o.approver ?? null };
      }),
      inputs: [],
    };
  });
  defs.forEach((d, i) => {
    stages[i]!.inputs = d.inputs.map((inp) => {
      const base = { uid: uid(), key: inp.key, name: inp.name, nameAr: inp.nameAr ?? '', required: inp.required };
      if ('stage' in inp.from) {
        return { ...base, source: 'stage_output' as const, pick: 'any' as const, refStage: stageUid.get(inp.from.stage) ?? `raw:${inp.from.stage}`, refOutput: outUid.get(`${inp.from.stage}/${inp.from.output}`) ?? `raw:${inp.from.output}` };
      }
      if ('previousCycle' in inp.from) {
        const pc = inp.from.previousCycle;
        return { ...base, source: 'previous_cycle' as const, pick: 'any' as const, refStage: stageUid.get(pc.stage) ?? `raw:${pc.stage}`, refOutput: outUid.get(`${pc.stage}/${pc.output}`) ?? `raw:${pc.output}` };
      }
      return { ...base, source: 'pick' as const, pick: inp.from.pick, refStage: '', refOutput: '' };
    });
  });
  return stages;
}

const toDays = (s: string) => { const n = Math.trunc(Number(s)); return Number.isFinite(n) ? Math.min(36500, Math.max(0, n)) : 0; };
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * The stored shape. Items without a key get one made from their name (unique within their level); `forCheck` fills an empty name with a
 * placeholder so the rules between stages can still be checked while a name is being typed.
 */
export function toDefs(stages: readonly EStage[], mode: 'save' | 'check' = 'save'): StageDef[] {
  const nm = (s: string) => (mode === 'check' && !s.trim() ? '…' : s.trim());
  const stageKeys = new Map<string, string>();
  const taken = new Set(stages.map((s) => s.key).filter(Boolean));
  for (const s of stages) { if (s.key) stageKeys.set(s.uid, s.key); else { const k = uniqueKey(slug(s.name, 'stage'), taken); taken.add(k); stageKeys.set(s.uid, k); } }
  const outKeys = new Map<string, string>();
  const outOf = new Map<string, string>();   // output uid -> stage uid
  for (const s of stages) {
    const used = new Set(s.outputs.map((o) => o.key).filter(Boolean));
    for (const o of s.outputs) {
      outOf.set(o.uid, s.uid);
      if (o.key) outKeys.set(o.uid, o.key); else { const k = uniqueKey(slug(o.name, 'output'), used); used.add(k); outKeys.set(o.uid, k); }
    }
  }
  const ref = (stageRef: string, outRef: string) => ({
    stage: stageRef.startsWith('raw:') ? stageRef.slice(4) : (stageKeys.get(stageRef) ?? ''),
    output: outRef.startsWith('raw:') ? outRef.slice(4) : (outKeys.get(outRef) ?? ''),
  });
  return stages.map((s) => {
    const inUsed = new Set(s.inputs.map((i) => i.key).filter(Boolean));
    return {
      key: stageKeys.get(s.uid)!, name: nm(s.name), ...(s.nameAr.trim() ? { nameAr: s.nameAr.trim() } : {}), process: s.process, checklist: lines(s.checklist),
      unit: s.unit, owner: s.owner, startOffsetDays: toDays(s.start), lengthDays: toDays(s.length), ...(s.child ? { child: s.child } : {}),
      outputs: s.outputs.map((o) => ({
        key: outKeys.get(o.uid)!, name: nm(o.name), ...(o.nameAr.trim() ? { nameAr: o.nameAr.trim() } : {}), kind: o.kind, required: o.required,
        ...(o.kind === 'report' && o.reportTemplateKey.trim() ? { reportTemplateKey: o.reportTemplateKey.trim() } : {}),
        ...(o.kind === 'approval' && o.approver ? { approver: o.approver } : {}),
      })),
      inputs: s.inputs.map((i) => {
        let key = i.key;
        if (!key) { key = uniqueKey(slug(i.name, 'input'), inUsed); inUsed.add(key); }
        const from = i.source === 'pick' ? { pick: i.pick } : i.source === 'stage_output' ? ref(i.refStage, i.refOutput) : { previousCycle: ref(i.refStage, i.refOutput) };
        return { key, name: nm(i.name), ...(i.nameAr.trim() ? { nameAr: i.nameAr.trim() } : {}), from, required: i.required } as StageDef['inputs'][number];
      }),
    };
  });
}

/** After a save, the keys that were made on the way are fixed from then on. */
export function adoptKeys(stages: EStage[], saved: readonly StageDef[]): EStage[] {
  return stages.map((s, i) => {
    const d = saved[i];
    if (!d) return s;
    return {
      ...s, key: s.key || d.key,
      outputs: s.outputs.map((o, j) => ({ ...o, key: o.key || d.outputs[j]?.key || '' })),
      inputs: s.inputs.map((inp, j) => ({ ...inp, key: inp.key || d.inputs[j]?.key || '' })),
    };
  });
}

// ---- Editing helpers -----------------------------------------------------------------------------------------------------

export function move<T>(list: readonly T[], from: number, dir: -1 | 1): T[] {
  const to = from + dir;
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x!);
  return next;
}

export function newStage(name: string, after: EStage | undefined): EStage {
  const start = after ? toDays(after.start) + toDays(after.length) : 0;
  return { uid: uid(), key: '', name, nameAr: '', process: '', checklist: '', unit: { kind: 'cycle' }, owner: { kind: 'cycle_lead' }, start: String(start), length: '14', outputs: [], inputs: [] };
}
export function newOutput(name: string): EOutput { return { uid: uid(), key: '', name, nameAr: '', kind: 'note', required: true, reportTemplateKey: '', approver: null }; }
export function newInput(name: string): EInput { return { uid: uid(), key: '', name, nameAr: '', required: true, source: 'pick', refStage: '', refOutput: '', pick: 'any' }; }

/** Inputs that read something gone are turned back into "something the stage owner picks"; returns the stages and how many were changed. */
function detach(stages: EStage[], gone: (i: EInput) => boolean): { stages: EStage[]; changed: number } {
  let changed = 0;
  const next = stages.map((s) => ({
    ...s,
    inputs: s.inputs.map((i) => {
      if (i.source === 'pick' || !gone(i)) return i;
      changed += 1;
      return { ...i, source: 'pick' as const, pick: 'any' as const, refStage: '', refOutput: '' };
    }),
  }));
  return { stages: next, changed };
}
export const removeStage = (stages: EStage[], stageUid: string) => detach(stages.filter((s) => s.uid !== stageUid), (i) => i.refStage === stageUid);
export const removeOutput = (stages: EStage[], outputUid: string) =>
  detach(stages.map((s) => ({ ...s, outputs: s.outputs.filter((o) => o.uid !== outputUid) })), (i) => i.refOutput === outputUid);

/** The outputs an input of stage `at` may read from earlier stages: [stage uid, output uid, stage name, output name]. */
export function earlierOutputs(stages: readonly EStage[], at: number) {
  return stages.slice(0, at).flatMap((s, k) => s.outputs.map((o) => ({ stageUid: s.uid, outputUid: o.uid, stageNo: k + 1, stageName: s.name, outputName: o.name })));
}
export function allOutputs(stages: readonly EStage[]) {
  return stages.flatMap((s, k) => s.outputs.map((o) => ({ stageUid: s.uid, outputUid: o.uid, stageNo: k + 1, stageName: s.name, outputName: o.name })));
}

// ---- Checking, in plain words --------------------------------------------------------------------------------------------

export type Level = 'save' | 'publish' | 'note';
export interface Problem {
  /** 0-based stage the problem belongs to; null for the template as a whole. */
  stage: number | null; scope: 'template' | 'stage' | 'output' | 'input'; index: number | null;
  /** The catalogue key (qmt.err.<code>) and its values. */
  code: string; params: Record<string, string | number>;
  /** `save`: the stored shape cannot hold it, so saving waits; `publish`: saves fine, blocks publishing; `note`: worth knowing. */
  level: Level;
}
export interface TemplateHead { name: string }

const stageLabel = (s: EStage | undefined, i: number) => s?.name.trim() || `#${i + 1}`;

export function check(head: TemplateHead, stages: readonly EStage[]): Problem[] {
  const out: Problem[] = [];
  const add = (p: Problem) => out.push(p);
  if (!head.name.trim()) add({ stage: null, scope: 'template', index: null, code: 'templateName', params: {}, level: 'save' });
  if (stages.length === 0) add({ stage: null, scope: 'template', index: null, code: 'noStages', params: {}, level: 'publish' });
  stages.forEach((s, i) => {
    const sn = i + 1;
    const stage = stageLabel(s, i);
    if (!s.name.trim()) add({ stage: i, scope: 'stage', index: null, code: 'stageName', params: { n: sn }, level: 'save' });
    for (const [field, v] of [['start', s.start], ['length', s.length]] as const) {
      const n = Number(v);
      if (v.trim() === '' || !Number.isInteger(n) || n < 0 || n > 36500) add({ stage: i, scope: 'stage', index: null, code: field === 'start' ? 'startDays' : 'lengthDays', params: { n: sn, stage }, level: 'save' });
    }
    if (s.unit.kind === 'unit_type' && !s.unit.type) add({ stage: i, scope: 'stage', index: null, code: 'unitType', params: { n: sn, stage }, level: 'save' });
    s.outputs.forEach((o, j) => {
      if (!o.name.trim()) add({ stage: i, scope: 'output', index: j, code: 'outputName', params: { n: sn, o: j + 1 }, level: 'save' });
      if (o.kind === 'approval' && !o.approver) add({ stage: i, scope: 'output', index: j, code: 'noApprover', params: { stage, output: o.name.trim() || `#${j + 1}` }, level: 'note' });
    });
    s.inputs.forEach((inp, j) => {
      if (!inp.name.trim()) add({ stage: i, scope: 'input', index: j, code: 'inputName', params: { n: sn, o: j + 1 }, level: 'save' });
    });
  });
  // The rules between stages: the one function the server publishes with, explained from what the editor knows.
  const defs = toDefs(stages, 'check');
  for (const issue of validateTemplateStages(defs)) add(explain(issue, stages, defs));
  return out;
}

const PATH = /^stages\.(\d+)(?:\.(inputs|outputs)\.(\d+))?(?:\.(.+))?$/;

/** One issue of `validateTemplateStages` in the words of the screen: who, what and what to do. */
export function explain(issue: TemplateIssue, stages: readonly EStage[], defs: readonly StageDef[]): Problem {
  const m = PATH.exec(issue.path);
  if (!m) {
    const loop = /loop: (.+)$/.exec(issue.message);
    if (loop) {
      const names = loop[1]!.split(' -> ').map((k) => { const at = defs.findIndex((d) => d.key === k); return at >= 0 ? stageLabel(stages[at], at) : k; });
      return { stage: null, scope: 'template', index: null, code: 'loop', params: { chain: names.join(' → ') }, level: 'publish' };
    }
    return { stage: null, scope: 'template', index: null, code: 'other', params: { message: issue.message }, level: 'publish' };
  }
  const i = Number(m[1]);
  const part = m[2];
  const j = m[3] === undefined ? null : Number(m[3]);
  const rest = m[4] ?? '';
  const stage = stages[i];
  const sn = i + 1;
  const inp = part === 'inputs' && j !== null ? stage?.inputs[j] : undefined;
  const inName = inp?.name.trim() || (j !== null ? `#${j + 1}` : '');
  const at = { stage: i, scope: 'input' as const, index: j, level: 'publish' as const };
  if (inp && rest.startsWith('from')) {
    const refIdx = stages.findIndex((s) => s.uid === inp.refStage);
    const refName = refIdx >= 0 ? stageLabel(stages[refIdx], refIdx) : inp.refStage.replace(/^raw:/, '');
    const outName = stages.flatMap((s) => s.outputs).find((o) => o.uid === inp.refOutput)?.name ?? inp.refOutput.replace(/^raw:/, '');
    if (rest === 'from.stage' || rest === 'from.previousCycle.stage') {
      if (refIdx < 0) return { ...at, code: rest === 'from.stage' ? 'missingStage' : 'missingPreviousStage', params: { n: sn, input: inName, stage: refName } };
      if (refIdx === i) return { ...at, code: 'ownOutput', params: { n: sn, input: inName, stage: refName } };
      return { ...at, code: 'later', params: { n: sn, input: inName, stage: stageLabel(stage, i), from: refName } };
    }
    return { ...at, code: rest === 'from.output' ? 'missingOutput' : 'missingPreviousOutput', params: { n: sn, input: inName, stage: refName, output: outName } };
  }
  if (rest === 'key') return { stage: i, scope: part === 'inputs' ? 'input' : part === 'outputs' ? 'output' : 'stage', index: j, code: 'dupKey', params: { n: sn, message: issue.message }, level: 'publish' };
  return { stage: i, scope: part === 'inputs' ? 'input' : part === 'outputs' ? 'output' : 'stage', index: j, code: 'other', params: { message: issue.message }, level: 'publish' };
}

// ---- The timeline --------------------------------------------------------------------------------------------------------

export interface TimelineRow { uid: string; no: number; name: string; start: number; end: number; outputs: number; inputs: number }
export function timeline(stages: readonly EStage[]): { rows: TimelineRow[]; total: number } {
  const rows = stages.map((s, i) => ({ uid: s.uid, no: i + 1, name: s.name.trim(), start: toDays(s.start), end: toDays(s.start) + toDays(s.length), outputs: s.outputs.length, inputs: s.inputs.length }));
  return { rows, total: Math.max(1, ...rows.map((r) => r.end)) };
}

/** A stable text of what would be saved: the editor is "dirty" when it differs from the last saved one. */
export const snapshot = (head: { name: string; nameAr: string; description: string; anchorKinds: readonly string[] }, stages: readonly EStage[]) =>
  JSON.stringify({ n: head.name.trim(), a: head.nameAr.trim(), d: head.description.trim(), k: [...head.anchorKinds].sort(), s: toDefs(stages, 'save') });
