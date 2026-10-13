// The leaf that framework/versions.ts may import: how many texts the assistant wrote are still waiting for the person. It touches
// one table and nothing of the assistant's other modules, so the publish check can use it without an import cycle.
import { sql } from 'drizzle-orm';
import type { Ctx } from '../../ctx.js';

/** How many texts the assistant wrote in this version are still waiting for the person (the publish check shows it as a warning). */
export async function countUnreviewedWrittenTexts(ctx: Ctx, versionId: string): Promise<number> {
  const res = await ctx.tx.execute<{ n: number }>(sql`
    select count(*)::int as n from assistant_written_text w join requirement r on r.id = w.requirement_id
    where w.version_id = ${versionId} and w.state = 'pending'
      and (case w.field when 'title' then r.title when 'officialText' then r.official_text else r.translation_en end) = w.text`);
  return res.rows[0]?.n ?? 0;
}
