import { eq } from 'drizzle-orm';
import { appUser, institution } from '@ams/db';
import { effectiveLocale, uiLocaleProblem, type LanguageState } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';

/** The language setting that applies to the caller: the institution's, their own choice, and what is in force. */
export async function languageStateOf(ctx: Ctx): Promise<LanguageState> {
  const [inst] = await ctx.tx.select({ secondary: institution.secondaryLanguage, def: institution.defaultLocale }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  if (!inst) throw new NotFoundError('institution');
  let own: string | null = null;
  if (ctx.caller.userId) {
    const [u] = await ctx.tx.select({ ui: appUser.uiLocale }).from(appUser).where(eq(appUser.id, ctx.caller.userId));
    own = u?.ui ?? null;
  }
  const effective = effectiveLocale(own, inst.def, inst.secondary);
  // A stored choice that no longer fits (the secondary language changed) is reported as not chosen.
  return { secondaryLanguage: inst.secondary, defaultLocale: uiLocaleProblem(inst.def, inst.secondary) === null ? inst.def : 'en', uiLocale: own && uiLocaleProblem(own, inst.secondary) === null ? own : null, effectiveLocale: effective };
}

/**
 * The signed-in person's own preferences (today: the interface language). Only the caller's own row can be changed: there is
 * no person id to name. The language must be English or the institution's secondary language; null goes back to the
 * institution's default.
 */
export async function updateMyPreferences(ctx: Ctx, patch: { uiLocale: string | null }): Promise<LanguageState> {
  assertHuman(ctx);
  const state = await languageStateOf(ctx);
  const problem = uiLocaleProblem(patch.uiLocale, state.secondaryLanguage);
  if (problem) throw new ValidationError(problem, [{ path: 'uiLocale', message: problem }]);
  const [row] = await ctx.tx.update(appUser).set({ uiLocale: patch.uiLocale }).where(eq(appUser.id, ctx.caller.userId!)).returning({ id: appUser.id });
  if (!row) throw new NotFoundError('your user record');
  return languageStateOf(ctx);
}
