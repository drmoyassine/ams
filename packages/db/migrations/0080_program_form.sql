-- The program record as the owner specified it (2026-11-16): delivery mode is On-campus, Online or Blended (full-time and part-time
-- programs are on-campus), and the program's total contact hours are recorded. Tags and discipline stay in the table (tags decide which
-- accreditor requirements apply) but are no longer on the form.
ALTER TABLE program DROP CONSTRAINT program_mode_check;--> statement-breakpoint
UPDATE program SET mode = 'on_campus' WHERE mode IN ('full_time', 'part_time');--> statement-breakpoint
ALTER TABLE program ADD CONSTRAINT program_mode_check CHECK (mode IS NULL OR mode IN ('on_campus', 'online', 'blended'));--> statement-breakpoint
ALTER TABLE program ADD COLUMN contact_hours integer;--> statement-breakpoint
ALTER TABLE program ADD CONSTRAINT program_contact_hours_check CHECK (contact_hours IS NULL OR contact_hours BETWEEN 1 AND 20000);
