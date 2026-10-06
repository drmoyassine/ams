// A generic, high-level starting point for an institution's own quality framework. Accreditors in higher education
// cover broadly the same ground, so external standards map onto these areas readily; institutions rename, remove and
// extend them. Nothing here names or follows any one accreditor (DEC-002).
export const INTERNAL_TEMPLATE: { title: string; children: string[] }[] = [
  { title: 'Mission and governance', children: ['Mission, vision and values', 'Governance and leadership', 'Strategic planning', 'Integrity and ethics'] },
  { title: 'Programs and curriculum', children: ['Program design and approval', 'Learning outcomes', 'Curriculum review'] },
  { title: 'Teaching and learning', children: ['Teaching quality', 'Assessment of learning', 'Learning resources'] },
  { title: 'Students and support', children: ['Admission', 'Advising and support services', 'Student progression and success', 'Student feedback'] },
  { title: 'Faculty and staff', children: ['Recruitment and qualifications', 'Development', 'Evaluation'] },
  { title: 'Research and community engagement', children: ['Research', 'Community engagement'] },
  { title: 'Resources and infrastructure', children: ['Financial resources', 'Facilities and technology', 'Information and library services'] },
  { title: 'Quality assurance and improvement', children: ['Quality system and policies', 'Monitoring and review', 'Improvement actions'] },
];
