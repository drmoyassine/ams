import { importExtractV1 } from './import-extract.v1.js';

/**
 * Document import for the org chart (TASK-073): the general rules of every import plus what a unit is. The pages are the reading
 * model's outline of a chart picture (ocr v2: one line per box, two spaces of indent per level) or the text of a chart in a PDF.
 * One item per box; the quote is the box's own line.
 */
export const importOrgChartV1 = [
  importExtractV1,
  '',
  'What to look for: the units of the institution\'s organization chart (colleges, schools, departments, offices, committees). One item per box. The pages are an outline of a chart picture: a line indented under another line hangs from it.',
  'Do not propose people, programs or courses as units. A person named in a box is the head of that box\'s unit.',
  'Fields of each item:',
  '- nameEn: the unit name in English as written. If the box gives the name only in Arabic, leave nameEn as the Arabic name exactly as written.',
  '- nameAr: the name in Arabic as written, when the box gives one. Never translate one language into the other.',
  '- type: the kind of unit, only when the box or the levels make it plain: a short lower-case key such as college, school, department, admin_unit, office or committee (the app matches it to the institution\'s own unit types, and uses other when it does not match), otherwise leave it empty.',
  '- parentName: the nameEn of the unit this box hangs from, exactly as you wrote it for that unit. Leave it empty for a box at the top of the chart.',
  '- headName: the name of the person shown in the box or beside it as its head, when there is one.',
  '- boxText: the whole line of the outline for this box, copied exactly.',
  'The quote of every item is its own line of the outline. Give a low confidence (below 0.6) when a box was hard to read, when its place in the tree is unclear (" [parent unclear]") or when a name looks cut off.',
  'Leave a field empty rather than guessing.',
].join('\n');
