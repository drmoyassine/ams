// Loading programs, PEOs and PLOs from a workbook (the Integrated Assessment Plan): the browser reads the Programs, PEOs and PLOs
// sheets and sends the rows. Additive only: units and programs that are missing are created, empty program fields are filled, new
// outcomes are added as drafts with their source; nothing recorded is overwritten (a different wording is reported, not applied).
// With apply false it says what would happen and changes nothing. Runs through the ordinary services as the person.
import { learningOutcome, orgUnit, orgUnitType, program, programReviewFinding } from '@ams/db';
import { OutcomesWorkbookSchema, type OutcomesWorkbook, type OutcomesWorkbookResult } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';
import { createProgram, updateProgram } from '../org/programs.js';
import { createOrgUnit } from '../org/units.js';
import { createOutcome } from './outcomes.js';
import { addReviewFinding, findingKey, getReviewRubric, resolveReviewLevel } from './reviews.js';

/** Case, spacing, dash and Unicode differences do not make two names different. */
const key = (s: string | null | undefined) => (s ?? '').normalize('NFKC').toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
const text = (s: string | null | undefined) => (s ? s.normalize('NFC').trim() : '');
const codeOf = (id: string) => (id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id).trim();
function degreeOf(title: string): 'associate' | 'bachelor' | 'master' | 'doctorate' | 'diploma' | 'certificate' {
  const t = title.toLowerCase();
  if (/\bmaster|^m\.?s\.?c?\b|^m\.?ed\b|^mba\b/.test(t)) return 'master';
  if (/doctor|ph\.?d/.test(t)) return 'doctorate';
  if (/diploma/.test(t)) return 'diploma';
  if (/certificate/.test(t)) return 'certificate';
  if (/associate/.test(t)) return 'associate';
  return 'bachelor';
}
/** "School of Engineering and Computing (SEC)" -> name and code. */
function schoolOf(s: string): { name: string; code: string | null } {
  const m = /^(.*?)\s*\(([^()]{1,20})\)\s*$/.exec(s.trim());
  return m ? { name: m[1]!.trim(), code: m[2]!.trim() } : { name: s.trim(), code: null };
}

export async function loadOutcomesWorkbook(ctx: Ctx, raw: OutcomesWorkbook): Promise<OutcomesWorkbookResult> {
  assertHuman(ctx);
  const input = OutcomesWorkbookSchema.parse(raw);
  await assertPermitted(ctx, 'org:write', { type: 'institution' });
  await assertPermitted(ctx, 'program:write', { type: 'institution' });
  const apply = input.apply;
  const result: OutcomesWorkbookResult = { applied: apply, unitsCreated: [], programsCreated: [], programsUpdated: [], outcomesCreated: 0, outcomesUnchanged: 0, findingsAdded: 0, findingsUnchanged: 0, skipped: [] };

  const units = await ctx.tx.select().from(orgUnit);
  const types = await ctx.tx.select().from(orgUnitType);
  const unitType = (['school', 'college', 'faculty'].map((k) => types.find((t) => t.key === k)).find(Boolean) ?? types[0])?.key;
  const programs = await ctx.tx.select().from(program);
  const unitByKey = new Map<string, string>();
  for (const u of units) { unitByKey.set(key(u.nameEn), u.id); if (u.code) unitByKey.set(`code:${key(u.code)}`, u.id); }
  const progByKey = new Map<string, string>();
  for (const p of programs) { progByKey.set(key(p.nameEn), p.id); if (p.code) progByKey.set(`code:${key(p.code)}`, p.id); }
  const usedCodes = new Set(programs.map((p) => key(p.code)).filter(Boolean));

  async function unitFor(school: string): Promise<string | null> {
    const { name, code } = schoolOf(school);
    const found = (code && unitByKey.get(`code:${key(code)}`)) || unitByKey.get(key(name)) || unitByKey.get(key(school));
    if (found) return found;
    if (!unitType) return null;
    let id = `new:${key(name)}`;
    if (apply) id = (await createOrgUnit(ctx, { parentId: null, type: unitType, nameEn: name, ...(code ? { code } : {}) })).id;
    unitByKey.set(key(name), id); if (code) unitByKey.set(`code:${key(code)}`, id);
    result.unitsCreated.push(name);
    return id;
  }

  for (const row of input.programs) {
    const title = text(row.title);
    const pid = text(row.programId);
    const existingId = (pid && progByKey.get(`code:${key(pid)}`)) || progByKey.get(key(title));
    if (!existingId) {
      if (!row.school) { result.skipped.push({ sheet: 'Programs', row: title, reason: 'not in the system and no school given to place it in' }); continue; }
      const unitId = await unitFor(row.school);
      if (!unitId) { result.skipped.push({ sheet: 'Programs', row: title, reason: 'no unit type to create its school with' }); continue; }
      const code = pid && !usedCodes.has(key(pid)) ? pid : null;
      let id = `new:${key(title)}`;
      if (apply) {
        id = (await createProgram(ctx, {
          orgUnitId: unitId, nameEn: title, degreeLevel: degreeOf(title), tags: [],
          ...(code ? { code } : {}), ...(text(row.mission) ? { mission: text(row.mission) } : {}), ...(text(row.vision) ? { vision: text(row.vision) } : {}),
        })).id;
      }
      if (code) usedCodes.add(key(code));
      progByKey.set(key(title), id); if (code) progByKey.set(`code:${key(code)}`, id);
      result.programsCreated.push(title);
      continue;
    }
    const cur = programs.find((p) => p.id === existingId)!;
    const patch: { code?: string; mission?: string; vision?: string } = {};
    if (pid && !cur.code && !usedCodes.has(key(pid))) { patch.code = pid; usedCodes.add(key(pid)); }
    for (const f of ['mission', 'vision'] as const) {
      const v = text(row[f]);
      if (!v) continue;
      if (!cur[f]) patch[f] = v;
      else if (key(cur[f]) !== key(v)) result.skipped.push({ sheet: 'Programs', row: title, reason: `the recorded ${f} differs from the workbook's; the recorded one is kept` });
    }
    if (Object.keys(patch).length) {
      if (apply) await updateProgram(ctx, cur.id, patch);
      result.programsUpdated.push({ program: cur.nameEn, fields: Object.keys(patch) });
    }
  }

  const existing = await ctx.tx.select({ kind: learningOutcome.kind, programId: learningOutcome.programId, code: learningOutcome.code, textEn: learningOutcome.textEn })
    .from(learningOutcome);
  const known = new Map(existing.filter((o) => o.programId).map((o) => [`${o.kind}|${o.programId}|${key(o.code)}`, o.textEn]));
  for (const [kind, rows, sheet] of [['peo', input.peos, 'PEOs'], ['plo', input.plos, 'PLOs']] as const) {
    for (const r of rows) {
      const programId = progByKey.get(key(r.program));
      if (!programId) { result.skipped.push({ sheet, row: r.id, reason: `no program named "${r.program}"` }); continue; }
      const code = codeOf(r.id);
      const k = `${kind}|${programId}|${key(code)}`;
      const had = known.get(k);
      if (had !== undefined) {
        if (key(had) === key(r.text)) result.outcomesUnchanged++;
        else result.skipped.push({ sheet, row: r.id, reason: 'already recorded with other words; the recorded text is kept' });
        continue;
      }
      if (apply) await createOutcome(ctx, { kind, programId, code, textEn: text(r.text), source: input.source });
      known.set(k, r.text);
      result.outcomesCreated++;
    }
  }

  // Program review findings (Baseline Findings sheet): appended in row order; a row already recorded is not added twice.
  if (input.findings.length) {
    const rubric = await getReviewRubric(ctx);
    const seen = new Set((await ctx.tx.select().from(programReviewFinding)).map((f) => findingKey(f.programId, f)));
    for (const f of input.findings) {
      const programId = progByKey.get(key(f.program));
      const row = `${f.program} #${f.criterionNo}`;
      if (!programId) { result.skipped.push({ sheet: 'Baseline Findings', row, reason: `no program named "${f.program}"` }); continue; }
      const level = resolveReviewLevel(rubric, f.level);
      if (!level) { result.skipped.push({ sheet: 'Baseline Findings', row, reason: `"${f.level}" is not one of the rubric's levels` }); continue; }
      if (!rubric.criteria.some((c) => c.no === f.criterionNo)) { result.skipped.push({ sheet: 'Baseline Findings', row, reason: `the rubric has no criterion ${f.criterionNo}` }); continue; }
      const k = findingKey(programId, { ...f, level });
      if (seen.has(k)) { result.findingsUnchanged++; continue; }
      const date = f.auditDate && /^\d{4}-\d{2}-\d{2}/.test(f.auditDate) ? f.auditDate.slice(0, 10) : undefined;
      if (apply) {
        await addReviewFinding(ctx, programId, {
          criterionNo: f.criterionNo, level, finding: f.finding, evidence: f.evidence ?? null, gaps: f.gaps ?? null, basis: f.basis ?? null,
          ...(date ? { auditDate: date } : {}), ...(f.pass ? { pass: f.pass } : {}), source: input.source,
        }, { rubric });
      }
      seen.add(k);
      result.findingsAdded++;
    }
  }
  return result;
}

export const _forTests = { degreeOf, schoolOf };
