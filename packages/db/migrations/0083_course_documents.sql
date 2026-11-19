-- Courses from documents (DEC-044): course catalogues, study plans and specifications are uploaded on the Courses tab's Docs section.
ALTER TABLE "import_document" DROP CONSTRAINT "import_document_scope_kind_check";
--> statement-breakpoint
ALTER TABLE "import_document" ADD CONSTRAINT "import_document_scope_kind_check" CHECK ("import_document"."scope_kind" in ('programs', 'courses', 'org_chart', 'glossary'));
