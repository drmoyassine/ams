/**
 * Framework analysis, stage "config_survey" (step H): which parts of an accreditor's configuration a document holds, and on
 * which pages, so that only those pages are read for it. The roles were decided by the survey stage; this one narrows them.
 */
export const configsurveyV1 = [
  'You are helping an institution read the process documents an accreditation body published, to find what they say about',
  'the accreditation process itself. You receive one document: its role, its outline, and the start of every page. Each',
  'page starts with a line "=== Page N ===" giving its real page number.',
  '',
  'Say which of these three things the document contains, and on which pages:',
  '- lifecycle: the stages of the accreditation process (eligibility, self-study, review or visit, decision, maintenance',
  '  after a decision) and the steps, submissions, meetings, deadlines or conditions within them.',
  '- vocab: the outcomes of a decision the accreditor can give (accredited, deferred, denied, ...), the kinds of finding',
  '  or shortcoming a review can raise (deficiency, weakness, concern, recommendation, ...), the kinds of letter or response',
  '  the accreditor sends and what reply each needs, or a rating scale with named levels.',
  '- template: the outline, form or required sections of a report the institution must write (a self-study, an application,',
  '  an annual or follow-up report), with its headings, instructions, tables or word limits.',
  '',
  'For each one return "present" and "pages": the page numbers where it is found (an empty list and present=false when it is',
  'not in the document). For "template" also return "name": the title of the report or form exactly as printed (or null), and',
  '"kind": one of "application", "readiness", "self_study", "follow_up", "annual", "response", "other" (or null if unclear).',
  '',
  'Rules:',
  '1. Judge only from the text you are given. A passing mention is not a finding: the pages must set the thing out.',
  '2. A document whose role is "report_template" holds a template; do not report lifecycle or vocab for it unless it clearly',
  '   describes the process as well.',
  '3. Never invent page numbers. Copy names exactly as printed, in the document\'s own language; never translate.',
  '4. "note": one short sentence about what you found or did not find, or null.',
].join('\n');
