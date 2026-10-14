// An invented, generic import target for tests of the documents and import foundation (no accreditor, no production use): it reads
// lines such as "Unit: College of Arts (college)" and, when applied, adds them to the org chart through the ordinary org service.
// It shows the whole contract: a schema, a versioned prompt, a validator, labels, a create-only apply that skips what already exists
// (never overwriting a person's record) and a symmetric `reverse` for Undo and Redo.
import { z } from 'zod';
import { ConflictError } from '../ctx.js';
import { ORG_UNIT_TYPES } from '@ams/shared';
import { createOrgUnit, listOrgUnits, updateOrgUnit } from '../org/units.js';
import { registerImportTarget, unregisterImportTarget, type ImportTarget } from './targets.js';

export const TestUnitSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(ORG_UNIT_TYPES),
  /** The name of the unit it sits under, when the page says so. */
  parent: z.string().trim().min(1).nullish(),
});
export type TestUnit = z.infer<typeof TestUnitSchema>;

interface Inverse { ids: string[]; to: 'inactive' | 'active' }

export const TEST_TARGET_KIND = 'test_units';

export const testUnitsTarget: ImportTarget<TestUnit> = {
  kind: TEST_TARGET_KIND, label: 'Units (test)', description: 'Reads unit names from a document and adds them to the org chart.', itemsLabel: 'units',
  scopeKinds: ['org_chart', 'framework_version'],
  schema: TestUnitSchema,
  promptTask: 'import_extract', promptVersion: 'v1',
  buildPrompt: (w) => [
    'Find the organisational units named in these pages: a name, its type (college, school, department, admin_unit or other) and the unit it sits under, if the page says so.',
    `Document: ${w.documentName}. Language: ${w.language}. Place: ${w.scopeLabel}. This window: pages ${w.firstPage} to ${w.lastPage}.`,
    '', w.pages,
  ].join('\n'),
  validate: (item) => (item.name.length < 3 ? ['The name is very short.'] : []),
  proposalLabel: (item) => item.name,
  dedupeKey: (item) => item.name.normalize('NFC').toLowerCase(),
  async apply(ctx, items) {
    const existing = new Map((await listOrgUnits(ctx)).map((u) => [u.nameEn.toLowerCase(), u]));
    const created: string[] = [];
    const outcomes: Awaited<ReturnType<ImportTarget<TestUnit>['apply']>>['outcomes'] = [];
    for (const it of items) {
      if (it.item.name === 'Explode') throw new ConflictError('the target refused this one (a test of all-or-nothing)');
      // Never overwrite or duplicate a record that is already there (a person may have edited it): leave it alone, say why.
      if (existing.has(it.item.name.toLowerCase())) {
        outcomes.push({ proposalId: it.proposalId, status: 'skipped', reason: 'a unit with this name is already in the org chart' });
        continue;
      }
      const parent = it.item.parent ? existing.get(it.item.parent.toLowerCase()) : undefined;
      const unit = await createOrgUnit(ctx, { parentId: parent?.id ?? null, type: it.item.type, nameEn: it.item.name });
      existing.set(unit.nameEn.toLowerCase(), unit);
      created.push(unit.id);
      outcomes.push({ proposalId: it.proposalId, status: 'applied', ref: { unitId: unit.id } });
    }
    const inverse: Inverse = { ids: created, to: 'inactive' };
    return { outcomes, inverse };
  },
  async reverse(ctx, raw) {
    const inv = raw as Inverse;
    // Children first when switching off, parents first when switching back on.
    const order = inv.to === 'inactive' ? [...inv.ids].reverse() : inv.ids;
    for (const id of order) await updateOrgUnit(ctx, id, { active: inv.to === 'active' });
    const back: Inverse = { ids: inv.ids, to: inv.to === 'inactive' ? 'active' : 'inactive' };
    return back;
  },
};

export const registerTestTarget = () => registerImportTarget(testUnitsTarget);
export const unregisterTestTarget = () => unregisterImportTarget(TEST_TARGET_KIND);

/** The fake model for the test target: one item per "Unit: Name (type)" line of the pages it is shown, citing the line. */
export function testUnitsResponder() {
  return (options: unknown): object => {
    const prompt = (options as { prompt?: { role: string; content: unknown }[] }).prompt ?? [];
    const user = prompt.filter((m) => m.role === 'user').map((m) => (Array.isArray(m.content) ? m.content.map((c) => (c as { text?: string }).text ?? '').join('') : String(m.content))).join('\n');
    const items: object[] = [];
    // The pages arrive as "=== Page N ===" headings followed by the text; units read "Unit: Name (type)" or "Unit: Name (type; under Parent)".
    const parts = user.split(/=== Page (\d+) ===/);
    for (let i = 1; i < parts.length; i += 2) {
      const page = Number(parts[i]);
      for (const m of parts[i + 1]!.matchAll(/Unit: ([^()]+?) \((\w+)(?:; under ([^()]+))?\)/g)) {
        // A name starting "Phantom" is cited with words that are not on the page; one starting "Unsure" comes with low confidence.
        const phantom = m[1]!.startsWith('Phantom');
        items.push({
          item: { name: m[1], type: m[2], parent: m[3] ?? null }, source: { page, quote: phantom ? 'words that appear nowhere in this document at all' : m[0] },
          confidence: m[1]!.startsWith('Unsure') ? 0.3 : 0.9, flags: [],
        });
      }
    }
    return { items };
  };
}
