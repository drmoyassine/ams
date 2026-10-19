// "My work": the stages I own and the approvals waiting for my decision, across the cycles that are running.
import { sql } from 'drizzle-orm';
import type { MyWork } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { assertPermitted } from '../permissions.js';
import { dayOf } from './common.js';

export async function getMyWork(ctx: Ctx): Promise<MyWork> {
  await assertPermitted(ctx, 'cycle:read', { type: 'any' });
  const me = ctx.caller.userId;
  if (!me) return { stages: [], approvals: [] };
  const today = dayOf();
  const [stages, approvals] = await Promise.all([
    ctx.tx.execute<{
      cycle_id: string; cycle_title: string; cycle_status: MyWork['stages'][number]['cycleStatus']; stage_id: string; stage_name: string;
      status: MyWork['stages'][number]['status']; start_date: string | null; end_date: string | null; missing_inputs: number; missing_outputs: number;
    }>(sql`
      select c.id as cycle_id, c.title as cycle_title, c.status as cycle_status, s.id as stage_id, s.name as stage_name, s.status,
             s.start_date::text, s.end_date::text,
             (select count(*)::int from cycle_input i left join cycle_output o on o.id = i.output_id
               where i.stage_id = s.id and i.required and not (case when i.source = 'pick' then i.ref_id is not null else o.state = 'final' end)) as missing_inputs,
             (select count(*)::int from cycle_output o where o.stage_id = s.id and o.required and o.state <> 'final') as missing_outputs
      from cycle_stage s join cycle c on c.id = s.cycle_id
      where s.owner_user_id = ${me}::uuid and c.status = 'active' and s.status in ('not_started', 'in_progress')
      order by s.end_date nulls last, c.title, s.display_order`),
    ctx.tx.execute<{ cycle_id: string; cycle_title: string; stage_id: string; stage_name: string; output_id: string; output_name: string; decision: string | null }>(sql`
      select c.id as cycle_id, c.title as cycle_title, s.id as stage_id, s.name as stage_name, o.id as output_id, o.name as output_name, o.decision
      from cycle_output o join cycle_stage s on s.id = o.stage_id join cycle c on c.id = s.cycle_id
      where o.kind = 'approval' and o.approver_user_id = ${me}::uuid and o.state <> 'final' and c.status = 'active' and s.status = 'in_progress'
      order by s.end_date nulls last, c.title, o.name`),
  ]);
  return {
    stages: stages.rows.map((r) => ({
      cycleId: r.cycle_id, cycleTitle: r.cycle_title, cycleStatus: r.cycle_status, stageId: r.stage_id, stageName: r.stage_name, status: r.status,
      startDate: r.start_date, endDate: r.end_date, late: r.end_date !== null && r.end_date < today, missingInputs: r.missing_inputs, missingOutputs: r.missing_outputs,
    })),
    approvals: approvals.rows.map((r) => ({
      cycleId: r.cycle_id, cycleTitle: r.cycle_title, stageId: r.stage_id, stageName: r.stage_name, outputId: r.output_id, outputName: r.output_name, returnedBefore: r.decision === 'returned',
    })),
  };
}
