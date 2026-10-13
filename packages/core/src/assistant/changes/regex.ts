// Regular expressions a person (through the model) hands to a rule. They run over short strings the person can see, in the
// request that applies them, so the worst case is a slow request; still, the obvious catastrophic shapes are refused and the
// subject text is capped.
export type CompiledRegex = { ok: true; re: RegExp } | { ok: false; message: string };

/** `(a+)+`, `(.*)*`, `(\w+)*`: a quantified group that itself ends in a quantifier. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:\?)?\)[+*{]/;

export function compileRegex(pattern: string, flags = ''): CompiledRegex {
  if (pattern.length > 200) return { ok: false, message: 'the pattern is too long (at most 200 characters)' };
  if (NESTED_QUANTIFIER.test(pattern)) return { ok: false, message: `the pattern ${JSON.stringify(pattern)} could take too long to run (a repeated group inside a repeat); simplify it` };
  try {
    return { ok: true, re: new RegExp(pattern, flags.replace(/[gy]/g, '')) };
  } catch {
    return { ok: false, message: `the pattern ${JSON.stringify(pattern)} is not a valid regular expression` };
  }
}

/** The longest text a pattern is run over. */
export const MAX_SUBJECT_CHARS = 20_000;
