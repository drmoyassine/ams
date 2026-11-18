-- Programs import v3 (DEC-043): when a person edits a proposal (picks the program it matches, keeps a field), the target's own checks
-- run again and the proposal's flags say what applying it would now do. The app may therefore set the flags of a proposal it edits.
GRANT UPDATE (flags) ON import_proposal TO ams_app;
