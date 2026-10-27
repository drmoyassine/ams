-- The AMS moves from the `public` schema to its own `ams` schema (DEC-034 revised, 2026-10-27). In a co-deployment the AMS and the
-- BI share ONE database: the AMS in `ams`, the BI's own tables in `bi`, and `public` reserved for the BI's analytic data. Each
-- product's roles reach only its own schema; the products still talk only through the contract.
--
-- Renaming the schema moves every AMS object at once (tables, sequences, functions, triggers, policies, types): references inside
-- the catalogue are by identity, so they follow. Three things are by NAME and are fixed here:
--  1. the search path of new connections (the database default below; the BI's role overrides it with its own);
--  2. the search path of this session, for the migrations that run after this one in the same run;
--  3. the `SET search_path = public, pg_temp` of the SECURITY DEFINER functions.
ALTER SCHEMA public RENAME TO ams;
--> statement-breakpoint
CREATE SCHEMA public;
--> statement-breakpoint
-- `public` is reserved: nobody but its owner may use it until the BI grants its own role.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
SET search_path = ams, pg_catalog;
--> statement-breakpoint
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET search_path = ams, pg_catalog', current_database()); END $$;
--> statement-breakpoint
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
           WHERE p.pronamespace = 'ams'::regnamespace AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = ams, pg_temp', f.sig);
  END LOOP;
END $$;
--> statement-breakpoint
-- Only the AMS's roles may use its schema (the old `public` let every role look in; a role the BI logs in with must find nothing).
REVOKE ALL ON SCHEMA ams FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA ams TO ams_app, ams_worker;
