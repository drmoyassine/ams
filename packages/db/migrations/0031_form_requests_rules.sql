-- Requests may ask for a data item's form (DEC-018, DEC-020): the rules now cover either target.
CREATE OR REPLACE FUNCTION evidence_request_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.internal_framework_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM framework WHERE id = NEW.internal_framework_id AND internal) THEN
    RAISE EXCEPTION 'evidence is requested for items of the internal quality framework' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.data_item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM evidence_item WHERE id = NEW.data_item_id AND type = 'data') THEN
    RAISE EXCEPTION 'a form request asks for data evidence' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.internal_framework_id IS DISTINCT FROM OLD.internal_framework_id OR NEW.internal_code IS DISTINCT FROM OLD.internal_code
       OR NEW.data_item_id IS DISTINCT FROM OLD.data_item_id THEN
      RAISE EXCEPTION 'a request''s target cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'open' AND (NEW.status <> OLD.status OR NEW.token_hash IS NOT NULL) THEN
      RAISE EXCEPTION 'this request is closed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
