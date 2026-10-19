// The shipped default cycle templates (TASK-079): written into the institution's own templates as PUBLISHED ones with origin
// "default", only when their key is absent. The data lives in @ams/shared (`DEFAULT_CYCLE_TEMPLATES`): plain stage lists, never
// code per accreditor (DEC-002). Idempotent by key: a template that exists in any status (even edited, even retired) is left alone,
// so running it again restores only what is missing and never overwrites the institution's own changes.
import { inArray } from 'drizzle-orm';
import { cycleTemplate } from '@ams/db';
import { DEFAULT_CYCLE_TEMPLATES, TemplateStagesSchema, validateTemplateStages, type InstallDefaultsResult } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { nfc, nfcOrNull } from './common.js';
import { assertManageTemplates, normalise } from './templates.js';

export async function installDefaultTemplates(ctx: Ctx): Promise<InstallDefaultsResult> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const have = new Set((await ctx.tx.select({ key: cycleTemplate.key }).from(cycleTemplate).where(inArray(cycleTemplate.key, DEFAULT_CYCLE_TEMPLATES.map((t) => t.key)))).map((r) => r.key));
  const installed: string[] = [];
  const existing: string[] = [];
  for (const t of DEFAULT_CYCLE_TEMPLATES) {
    if (have.has(t.key)) { existing.push(t.key); continue; }
    const stages = TemplateStagesSchema.parse(t.stages);
    // A shipped template is always complete and consistent (a unit test holds the data to it); refuse to write one that is not.
    const issues = validateTemplateStages(stages);
    if (issues.length) throw new Error(`The default template ${t.key} is not valid: ${issues[0]!.message}`);
    await guardIntegrity(() => ctx.tx.insert(cycleTemplate).values({
      institutionId: ctx.caller.institutionId, key: t.key, name: nfc(t.name), nameAr: nfcOrNull(t.nameAr), description: nfcOrNull(t.description),
      anchorKinds: [...new Set(t.anchorKinds)], stages: normalise(stages), origin: 'default', version: 1, status: 'published',
    }));
    installed.push(t.key);
  }
  return { installed, existing };
}
