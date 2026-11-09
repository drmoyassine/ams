// Words for the syllabus vocabularies, in one place (the view, the editor and the list share them).
export const LABEL: Record<string, string> = {
  english: 'English', arabic: 'Arabic', bilingual: 'Bilingual',
  didactic: 'Didactic', lab: 'Lab', studio: 'Studio', internship: 'Internship', independent_study: 'Independent study', project: 'Project',
  general_education: 'General education', program_core: 'Program core', program_elective: 'Program elective', free_elective: 'Free elective',
  focused: 'Sustainability-focused', related: 'Sustainability-related', none: 'None',
  textbook: 'Required textbook', recommended: 'Recommended reading', material: 'Material', software: 'Software',
  quiz: 'Quiz', assignment: 'Assignment', midterm: 'Midterm exam', final: 'Final exam', presentation: 'Presentation', participation: 'Participation', other: 'Other',
  remember: 'Remember', understand: 'Understand', apply: 'Apply', analyze: 'Analyze', evaluate: 'Evaluate', create: 'Create',
  draft: 'Draft', in_review: 'In review', endorsed: 'Endorsed', approved: 'Approved', superseded: 'Superseded',
};
export const label = (v: string) => LABEL[v] ?? v;
/** The chip colours of a status. */
export const STATUS_TONE: Record<string, string> = {
  draft: 'bg-muted', in_review: 'bg-sky-50 text-sky-900', endorsed: 'bg-indigo-50 text-indigo-900', approved: 'bg-emerald-50 text-emerald-900', superseded: 'bg-muted text-muted-foreground',
};
export const LEVEL_NAME = (levels: { code: string; name: string }[], code: string) => levels.find((l) => l.code === code)?.name ?? code;
