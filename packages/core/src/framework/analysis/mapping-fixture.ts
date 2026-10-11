// Canned model answers for the IQF mapping stages (step E), for tests of the core, API and UI without any network.
// The responder reads the JSON the stage sent (REQUIREMENTS_JSON) and answers from a script, so it works for any
// requirements and candidates: a script says which candidate fits which requirement, and what new item to draft.
import type { NewIqfAnswer } from './mapping-schemas.js';

export type ScriptRelation = 'covers' | 'partly_covers' | 'related';

export interface MappingScript {
  /** requirement code -> candidate code -> relation. Anything not listed is judged "none". */
  fit?: Record<string, Record<string, ScriptRelation>>;
  /** The new items to draft for the codes the call was asked about (default: none). */
  newItems?: (codes: string[], outline: string) => NewIqfAnswer['items'];
  /** Filled in as calls arrive: what each call was given. */
  seen?: { map: { code: string; candidates: string[] }[][]; newiqf: { codes: string[]; outline: string }[] };
}

const MAP_MARK = 'You are helping an institution relate an accreditation body';
const NEWIQF_MARK = 'You are helping an institution extend its own internal quality framework';

interface Msg { role: string; content: unknown }
const textOf = (m: Msg) => (typeof m.content === 'string' ? m.content : (m.content as { text?: string }[]).map((p) => p.text ?? '').join(''));
/** The system prompt and the user input of a model call, as plain text. */
export function promptParts(options: unknown): { system: string; user: string } {
  const msgs = ((options as { prompt?: Msg[] }).prompt ?? []);
  return { system: msgs.filter((m) => m.role === 'system').map(textOf).join('\n'), user: msgs.filter((m) => m.role === 'user').map(textOf).join('\n') };
}
const dataOf = (user: string) => JSON.parse(user.slice(user.indexOf('REQUIREMENTS_JSON:') + 'REQUIREMENTS_JSON:'.length).trim()) as unknown;

/** Wraps a responder (such as fixtureResponder) with answers for the mapping prompts. */
export function mappingResponder(base: (options: unknown) => object, script: MappingScript = {}) {
  const seen = script.seen ?? { map: [], newiqf: [] };
  script.seen = seen;
  return (options: unknown): object => {
    const { system, user } = promptParts(options);
    if (system.includes(MAP_MARK)) {
      const reqs = dataOf(user) as { code: string; title: string; text: string; candidates: { code: string; title: string; text: string }[] }[];
      seen.map.push(reqs.map((r) => ({ code: r.code, candidates: r.candidates.map((c) => c.code) })));
      return {
        results: reqs.map((r) => ({
          requirement: r.code,
          judgments: r.candidates.map((c) => {
            const relation = script.fit?.[r.code]?.[c.code] ?? 'none';
            const quote = (s: string) => s.split(/\s+/).slice(0, 3).join(' ');
            return { candidate: c.code, relation, reason: relation === 'none' ? 'A different subject.' : `"${quote(r.text || r.title)}" is asked for by "${quote(c.title)}".` };
          }),
        })),
      };
    }
    if (system.includes(NEWIQF_MARK)) {
      const reqs = dataOf(user) as { code: string }[];
      const outline = user.slice(user.indexOf('Outline of the quality framework'), user.indexOf('REQUIREMENTS_JSON:'));
      seen.newiqf.push({ codes: reqs.map((r) => r.code), outline });
      return { items: script.newItems ? script.newItems(reqs.map((r) => r.code), outline) : [] };
    }
    return base(options);
  };
}
