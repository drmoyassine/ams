import { importExtractV1 } from './import-extract.v1.js';

/**
 * Courses from documents (DEC-044), step 1 (one window of pages): every FACT about a course the pages state, one item per fact, each with
 * its own quote. The courses are put together, and matched to the institution's existing courses, in the next step (import_courses_organise).
 */
export const importCoursesFactsV1 = [
  importExtractV1,
  '',
  'What to look for: facts about the courses (modules, subjects) of the institution, as a course catalogue, a study plan, a course',
  'specification or a syllabus states them. Give ONE item per fact: a course\'s code, its title, its student-information-system code, the',
  'college or department that owns it, its credit hours, its lecture and lab hours per week, the year of study it is taken in, each program',
  'it belongs to, its description, its teaching methodology, and each of its course learning outcomes (CLOs).',
  'Never give facts about programs or the institution as a whole, and never about another course a fact only mentions (a prerequisite).',
  'Fields of each item:',
  '- course: the course the fact is about, as these pages name it, with its code when the pages give it ("ECE 420 Digital Signal Processing").',
  '  Use the same name for every fact of the same course on these pages.',
  '- field: one of code, title, sis_code, unit, credits, lecture_hours, lab_hours, year, program, description, methodology, clo.',
  '- value: the fact exactly as written (a number as written: "3"). For unit the college, school or department as written, with its parent',
  '  when the page gives it ("College of Engineering > Department of Electrical Engineering"); for program the program as written (its code',
  '  or name); for clo the outcome statement itself, without its code.',
  '- code: for a clo, its code or number as printed ("CLO1", "1", "a"); otherwise empty.',
  'A table of a study plan gives one fact per cell that states one (the code, the title, the credits, the year of its heading). The program a',
  'study plan belongs to is a program fact for each of its courses.',
  'The quote of each item is the words of the page that state the fact.',
].join('\n');
