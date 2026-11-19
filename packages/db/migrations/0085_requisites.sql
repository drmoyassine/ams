-- REQUISITES WITH ALTERNATIVES (DEC-046, step 3): a prerequisite or co-requisite may be one of several courses ("PHYS 101 or PHYS 111").
--   course_requisite.group_no   requisites of a course with the same kind and group number are alternatives (any one satisfies the group);
--                               groups are all required. Null: a group of its own (every row stored before this).
--   course.other_requirements   what is not a course: "Junior standing", "Consent of the instructor" (set when a syllabus is approved).
-- Additive: every row stays valid.
ALTER TABLE course_requisite ADD COLUMN group_no integer;--> statement-breakpoint
ALTER TABLE course ADD COLUMN other_requirements text;
