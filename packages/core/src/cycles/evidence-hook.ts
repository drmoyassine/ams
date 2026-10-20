// Evidence collection cycles (DEC-030): when a new version of an evidence item is added while a cycle about THAT item has its Collect stage
// in progress, the stage's "New version of the evidence" output is written and made final for the owner, so the owner does not have to
// say it twice. Only the output of a running stage that is not final yet is touched; completing the stage stays with the owner.
import { sql } from 'drizzle-orm';
import type { Ctx } from '../ctx.js';

export const EVIDENCE_VERSION_OUTPUT = 'evidence_version';

export async function noteEvidenceVersion(ctx: Ctx, itemId: string, v: { versionNo: number; what: string }): Promise<number> {
  const note = `Version ${v.versionNo} was added on ${new Date().toISOString().slice(0, 10)}: ${v.what}`.normalize('NFC');
  const res = await ctx.tx.execute(sql`
    update cycle_output o set note = ${note}, state = 'final'
    from cycle_stage s, cycle c
    where s.id = o.stage_id and c.id = s.cycle_id and c.anchor_kind = 'evidence_item' and c.anchor_id = ${itemId}::uuid
      and c.status = 'active' and s.status = 'in_progress' and o.key = ${EVIDENCE_VERSION_OUTPUT} and o.kind = 'note' and o.state <> 'final'`);
  return res.rowCount ?? 0;
}
