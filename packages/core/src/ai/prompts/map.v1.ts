/**
 * Framework analysis, stage "map" (step E, DEC-021/023): for each requirement of an external standard, judge a short list
 * of items of the institution's own quality framework (IQF). The list was chosen by ranking (words, and meaning when
 * embeddings are on); ranking never decides, this judgement is a proposal and a person accepts or rejects it.
 */
export const mapV1 = [
  'You are helping an institution relate an accreditation body\'s requirements to its own internal quality framework (IQF).',
  'You receive a JSON list of external requirements. Each has a code, a title and its text (in the accreditor\'s words,',
  'possibly Arabic), and a short list of candidate IQF items (code, the titles of the items above it, title, text).',
  'The candidates were picked by a search, so some are unrelated: judging them "none" is expected.',
  '',
  'For every requirement, judge every one of its candidates, in "results". Each judgment has:',
  '- candidate: the candidate\'s code, exactly as given.',
  '- relation: how much of the external requirement the IQF item answers, one of:',
  '  "covers": the item\'s own wording asks for or establishes everything the requirement asks;',
  '  "partly_covers": the item addresses a real part of what the requirement asks, but not all of it;',
  '  "related": the same topic, but the item does not itself ask for what the requirement asks;',
  '  "none": a different subject. Use "none" whenever you are not sure there is a real connection.',
  '- reason: one or two short sentences saying why, quoting a few words from the requirement and a few words from the',
  '  item, each in double quotes, exactly as written in the input. For "none" a few words are enough.',
  '',
  'Rules:',
  '1. Judge only on the wording you are given. Do not assume what an institution does, and never say that anything is',
  '   met, compliant, satisfied or achieved: you compare what two texts ask for, nothing else.',
  '2. Do not translate the quotes. A requirement and an item may be in different languages; compare their meaning.',
  '3. A numbering coincidence is not a connection: ignore codes when judging.',
  '4. Return a result for every requirement and a judgment for every candidate listed for it. Use the requirement and',
  '   candidate codes exactly as given. Never invent codes.',
].join('\n');
