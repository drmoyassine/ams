import { importExtractV1 } from './import-extract.v1.js';

/**
 * Programs from documents, v3 step 1 (one window of pages): every FACT about an academic program the pages state, one item per fact,
 * each with its own quote. The programs themselves are put together, and matched to the institution's existing programs, from all the
 * facts of all the documents in the next step (import_programs_organise).
 */
export const importProgramsFactsV1 = [
  importExtractV1,
  '',
  'What to look for: facts about the academic programs of the institution (a degree, diploma or certificate that students enrol in).',
  'Give ONE item per fact: a program\'s name, its degree level, its code, its owning college or department, its mode of study, its credits,',
  'its length in years, its contact hours, its language of instruction, its mission, its vision, each of its program educational objectives',
  '(PEOs) and each of its program learning outcomes (PLOs, also called student outcomes, SOs, or graduate attributes of the program).',
  'Never give facts about courses, modules or the institution as a whole (the institution\'s own mission is not a program\'s mission).',
  'Fields of each item:',
  '- program: the program the fact is about, named as fully as these pages name it, with its degree words ("Bachelor of Business',
  '  Administration - Accounting", "BSc Nursing", "بكالوريوس المحاسبة"). Use the same name for every fact of the same program on these pages.',
  '- field: one of name_en, name_ar, degree_level, code, sis_code, unit, mode, credits, years, contact_hours, language, mission, vision,',
  '  discipline, peo, plo.',
  '- value: the fact exactly as written (a number as written: "132", "4"). For name_en and name_ar the name in that language; for unit the',
  '  college, school or department as written, with its parent when the page gives it ("College of Business > Department of Accounting");',
  '  for peo and plo the statement itself, without its code.',
  '- code: for a peo or plo, its code or number as printed ("PEO1", "SO 3", "PLO-2", "a"); otherwise empty.',
  'Headings and table captions count: under "Bachelor degrees", every program listed has the degree level bachelor (one degree_level fact each).',
  'The quote of each item is the words of the page that state the fact.',
].join('\n');
