-- EVIDENCE IS A KPI OR A DOCUMENT (TASK-120): an evidence item of type 'dataset' is a KPI. Its documentation card (symbol, scope, formula,
-- direction, objective, targets, thresholds, custodian, data source: the KPI Institute's documentation form) is one JSON object on the item.
-- The meaning of a KPI lives here; its numbers are the item's versions (entered, imported, or supplied by the BI). Additive only.
ALTER TABLE evidence_item ADD COLUMN kpi jsonb;
--> statement-breakpoint
ALTER TABLE evidence_item ADD CONSTRAINT evidence_item_kpi_check CHECK (kpi IS NULL OR (jsonb_typeof(kpi) = 'object' AND type = 'dataset'));
