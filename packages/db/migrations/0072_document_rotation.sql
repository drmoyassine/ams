-- A scanned document may have been scanned sideways or upside down: the quarter turns (0, 90, 180, 270 clockwise) a person sets
-- are applied to each page picture before the vision model reads it.
ALTER TABLE source_document ADD COLUMN rotation smallint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE source_document ADD CONSTRAINT source_document_rotation_check CHECK (rotation IN (0, 90, 180, 270));
--> statement-breakpoint
ALTER TABLE import_document ADD COLUMN rotation smallint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE import_document ADD CONSTRAINT import_document_rotation_check CHECK (rotation IN (0, 90, 180, 270));
