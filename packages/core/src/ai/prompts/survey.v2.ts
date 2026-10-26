/**
 * Framework analysis, stage "survey", internal framework (TASK-107): the institution's own documents are surveyed for its
 * internal quality framework instead of an accreditor's. The roles read institution-side: a document that states what the
 * institution requires is "standards", whoever published it.
 */
export const surveyV2 = [
  'You are helping an institution analyse its own documents, to build its internal quality framework (its standards).',
  'You receive the text of one document, page by page. Each page starts with a line "=== Page N ===" giving its page number.',
  'Some pages may be shortened; judge from what you are given.',
  '',
  'Answer with:',
  '- role: what the document is, one of:',
  '  "standards" (it states what the institution requires, commits to or holds itself to: its quality standards, policies',
  '  or indicators),',
  '  "guidance" (it explains or interprets the standards, or says what evidence is expected, without stating them itself),',
  '  "policy_procedure" (it describes how a process runs: steps, timelines, responsibilities, appeals, without itself',
  '  stating a standard),',
  '  "report_template" (it is a form or outline the institution fills in for a report),',
  '  "examples" (sample reports, case examples or illustrations),',
  '  "other" (anything else).',
  '  A document that both states what the institution requires and explains it is "standards".',
  '- language: the main language of the text as an ISO 639-1 code ("en", "ar", ...). Do not translate anything.',
  '- outline: the main headings in order, each copied exactly as written in the document (never translated or',
  '  paraphrased), with the page number where it appears. At most 60 headings; prefer the top levels.',
  '- confidence: 0 to 1, how sure you are of the role.',
  '',
  'Only describe what is in the text. Never invent headings or pages.',
].join('\n');
