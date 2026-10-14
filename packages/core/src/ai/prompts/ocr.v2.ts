/**
 * Reading a picture of an org chart (TASK-073): the same job as ocr v1, but the page is a diagram, so the structure is written
 * down as an indented outline. The words of each box stay exactly as written (the import cites them), and nothing is invented.
 */
export const ocrV2 = [
  'This image is an organization chart (boxes joined by lines). Write it down as an indented outline, in reading order from the top.',
  'One line per box. Put the box text on the line exactly as written, in its own language and script (including Arabic, right to left); do not translate, shorten or correct.',
  'If a box has several lines of text (for example a unit name in two languages, a person name or a title), join them on the one line with " | ".',
  'Indent a box by two spaces for each level below the box it hangs from: the parent is the box whose line reaches it from above. Boxes side by side at the same level have the same indent.',
  'If you cannot tell which box a box hangs from, put it at the level that looks right and add " [parent unclear]" at the end of its line.',
  'Mark text you cannot read as [illegible]. Text outside any box (a title, a date, a legend) goes first, on lines that start with "Note: ".',
  'Return only the outline.',
].join(' ');
