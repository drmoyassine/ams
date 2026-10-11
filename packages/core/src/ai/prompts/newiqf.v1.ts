/**
 * Framework analysis, stage "propose_new" (step E, DEC-021): requirements of an external standard that no IQF item fits
 * are grouped, and a new IQF item is drafted for each group, in the IQF's own wording. A proposal only: a person edits,
 * accepts or dismisses it, and nothing enters the IQF before that.
 */
export const newiqfV1 = [
  'You are helping an institution extend its own internal quality framework (IQF). Below are requirements of an external',
  'accreditation standard that no existing IQF item fits, and an outline of the IQF as it is now (codes and titles, with',
  'the names of its levels, top first).',
  '',
  'Group requirements that ask for the same thing, and for each group propose ONE new IQF item. Return them in "items",',
  'each with:',
  '- parent_code: the code of the existing IQF item it should sit under, exactly as in the outline, or null for a',
  '  top-level item. Prefer the closest existing item; use null only when no existing item is a sensible home.',
  '- level_label: the name of its level, from the level names given.',
  '- code: a short code in the IQF\'s own numbering style, following the numbering of the outline (for example the next',
  '  free number under the parent). It is a suggestion; a person may change it.',
  '- title: a short title, in the IQF\'s own terminology and language (the language of the outline; English when the',
  '  outline is empty).',
  '- description: one or two sentences saying what the institution\'s own framework would ask for. Write it in the IQF\'s',
  '  own words and level of generality. Do NOT copy or translate the accreditor\'s sentences, and do not name the',
  '  accreditor or its codes.',
  '- reason: one short sentence on why no existing item fits.',
  '- covers: the external requirements this item would answer, each with requirement (its code, exactly as given),',
  '  relation ("covers" when the new item would ask for everything the requirement asks, "partly_covers" when only a part,',
  '  "related" otherwise) and a short reason.',
  '',
  'Rules:',
  '1. Propose as few items as are needed; one item may answer several requirements. Every requirement may appear in at',
  '   most one item. A requirement you cannot sensibly place may be left out.',
  '2. The institution\'s framework is its own: keep items general and reusable, not a copy of one accreditor\'s structure.',
  '3. Never say that anything is met, compliant or satisfied. You are drafting what the framework could ask for.',
  '4. Use the requirement codes and the parent codes exactly as given. Never invent either.',
].join('\n');
