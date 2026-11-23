-- THE PROGRAM'S DESCRIPTION IN TWO LANGUAGES, AND ITS COORDINATOR (the owner, 2026-11-23).
--   program.description      the English description (required on the record; the catalog prints it);
--   program.description_ar   the Arabic one (optional);
--   program.coordinator_user_id  the person who coordinates the program (named on the program page; grants nothing by itself).
ALTER TABLE program ADD COLUMN description_ar text;--> statement-breakpoint
ALTER TABLE program ADD COLUMN coordinator_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL;
