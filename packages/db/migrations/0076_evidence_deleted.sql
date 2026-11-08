-- DELETING EVIDENCE (TASK-119): an evidence item can be deleted, which moves it to the Trash. Evidence versions are immutable (a
-- trigger refuses to update or delete one, and the application role may not delete them), so deleting an item is a state, not a
-- removal: its status becomes 'deleted', it disappears from the library, its links go to the Trash with it, and a restore brings
-- both back. The versions and their files stay as they were uploaded.
ALTER TABLE evidence_item DROP CONSTRAINT evidence_item_status_check;--> statement-breakpoint
ALTER TABLE evidence_item ADD CONSTRAINT evidence_item_status_check CHECK (status IN ('active', 'archived', 'deleted'));
--> statement-breakpoint
ALTER TABLE trash_item DROP CONSTRAINT trash_item_kind_check;--> statement-breakpoint
ALTER TABLE trash_item ADD CONSTRAINT trash_item_kind_check CHECK (kind IN ('requirement', 'note', 'source_document', 'source_page', 'report_template', 'framework_version', 'framework', 'mapping', 'evidence_link', 'evidence_item', 'milestone', 'import_document', 'org_unit', 'cycle', 'report'));
