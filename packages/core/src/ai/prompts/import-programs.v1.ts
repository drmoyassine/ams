import { importExtractV1 } from './import-extract.v1.js';

/**
 * Document import for Programs (TASK-076): the general rules of every import plus what a program is. The model is shown a few
 * pages of a catalogue, a program list or a program description and proposes one item per program the pages name.
 */
export const importProgramsV1 = [
  importExtractV1,
  '',
  'What to look for: academic programs (a degree, diploma or certificate that students enrol in) of the institution. One item per program.',
  'Do not propose courses, modules, departments or colleges as programs. A program that is offered in two modes or at two campuses is still one item.',
  'Fields of each item:',
  '- nameEn: the program name in English as written. If the document gives the name only in Arabic, leave nameEn as the Arabic name exactly as written.',
  '- nameAr: the name in Arabic as written, when the document gives one. Never translate one language into the other.',
  '- degreeLevel: one of associate, bachelor, master, doctorate, diploma, certificate, when the text states or clearly implies it (BSc, B.A. -> bachelor; MSc, MBA -> master; PhD -> doctorate). Otherwise leave it empty.',
  '- discipline: the field of study, when the document states one (for example "Nursing", "Mechanical engineering"). Otherwise empty.',
  '- unitName: the name of the college, school or department that owns the program, as written. Otherwise empty.',
  '- unitType: college, school, department, admin_unit or other, only if the document says what kind of unit it is.',
  '- code: the program code, when there is one. durationYears: the length in years as a number, when stated. mode: the mode of study (for example full-time, part-time, online), when stated.',
  'Leave a field empty rather than guessing.',
].join('\n');
