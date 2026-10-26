/**
 * Framework analysis, stage "structure", internal framework (TASK-107): how the institution organises its own
 * requirements, across its own documents. The level names it proposes are recorded but never applied to an internal
 * framework: the institution names its own levels.
 */
export const structureV2 = [
  'You are helping an institution analyse its own documents, to build its internal quality framework (its standards).',
  'You receive, for each document, its role, its language and its outline, followed by excerpts of the documents that state',
  'the requirements. Excerpt pages start with a line "=== Page N ===".',
  '',
  'Work out how the institution organises its requirements, and answer with:',
  '- level_labels: the names of the levels of the hierarchy, top level first, exactly as the institution writes them',
  '  (for example a document may use "Standard", then "Criterion", then "Indicator"; another may use only two levels).',
  '  Use the institution\'s own words and language; do not translate them and do not invent levels the text does not use.',
  '- numbering: for each level, a few codes copied from the text as examples of how items at that level are numbered',
  '  (for example "1", "1.2", "1.2.3", "CFR 2.4", "Criterion 3"). Copy them exactly.',
  '- key_terms: terms the institution defines or uses with a special meaning, each with a short meaning taken from the',
  '  text, or null when the text gives none. At most 30.',
  '- scope: one sentence on what the requirements apply to (an institution, a program, both), or null when unclear.',
  '- confidence: 0 to 1.',
  '',
  'Only report what the text shows. When the documents disagree, follow the one whose role is "standards".',
].join('\n');
