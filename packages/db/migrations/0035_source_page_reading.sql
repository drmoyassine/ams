ALTER TABLE "source_document" DROP CONSTRAINT "source_document_text_status_check";--> statement-breakpoint
ALTER TABLE "source_page" DROP CONSTRAINT "source_page_method_check";--> statement-breakpoint
ALTER TABLE "source_page" ADD COLUMN "needs_ocr" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "source_page" ADD COLUMN "from_file" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "source_document" ADD CONSTRAINT "source_document_text_status_check" CHECK ("source_document"."text_status" in ('pending', 'queued', 'extracted', 'ocr_needed', 'ocr_done', 'failed'));--> statement-breakpoint
ALTER TABLE "source_page" ADD CONSTRAINT "source_page_method_check" CHECK ("source_page"."method" in ('pdf_text', 'ocr', 'table', 'slide', 'sheet'));--> statement-breakpoint
-- Reading a file into pages is the worker's job: besides a page's text and method (granted in 0004) it sets the OCR flag
-- and marks the page as written from the file. Pages stored before this point were typed in or imported by a person, so
-- from_file stays false and reading a file never replaces them. The worker still cannot approve anything.
GRANT UPDATE (needs_ocr, from_file) ON source_page TO ams_worker;
