import { importExtractV1 } from './import-extract.v1.js';

/**
 * Drafting the institution's own quality framework from its documents (TASK-111), step 1 (one window of pages): find the HEADINGS
 * that organise the document. The headings are copied exactly as printed (the engine checks the quote on the page); the framework
 * itself is drawn from all documents together in the next step (iqf_organise).
 */
export const iqfOutlineV1 = [
  importExtractV1,
  '',
  'What to look for: the headings that organise this document, so that a framework of standards and sub-standards can be drawn from it later.',
  'Only headings, never sentences of the body. One item per heading.',
  'Fields of each item:',
  '- level: 0 = the title of the whole document (give it once, and only when the first page of the document is in these pages);',
  '  1 = the top level of the document\'s own hierarchy (for example "Article 2: ...", "Standard 3", "Section 4", or a standard row of a table of',
  '  standards, such as "المعيار (٣): ...");',
  '  2 = the level directly below it (for example "2.1 Institutional Learning Outcomes", or a measure row of a table, such as "٣-١ ...").',
  '  Never return anything deeper than level 2: no lettered or numbered sub-items (a., b., 1., 2.), no bullet points, no indicators or other',
  '  sentences that state a requirement, no rows of a table that are whole sentences.',
  '- number: the number or label printed with the heading ("Article 2", "2.1", "المعيار (٣)", "٣-١"), exactly as printed; null when it has none.',
  '- title: the heading text exactly as printed, without its number. Keep its language and script (Arabic stays Arabic); never translate it.',
  '- about: one short sentence (at most 25 words), in the language of the document, saying what the section is about, taken from the text',
  '  under the heading; null when the text under it says nothing.',
  'The quote of each item is the heading line exactly as printed on the page, with its number.',
  'These are NOT headings: running headers and footers, the block repeated at the top of every page (policy number, effective date, approver,',
  '"Page 3 of 16"), page numbers, a table of contents, a definitions list, signatures. In a table, the number cell and the name cell of a row',
  'together are the heading line. Pages that are an outline of a scanned table may have its cells in a different order than printed; use the',
  'order that reads naturally.',
].join('\n');
