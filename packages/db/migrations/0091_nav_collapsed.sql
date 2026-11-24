-- The person's own choice to keep the left navigation collapsed to icons (the owner, 2026-11-23); kept across sessions and devices.
ALTER TABLE app_user ADD COLUMN nav_collapsed boolean DEFAULT false NOT NULL;
