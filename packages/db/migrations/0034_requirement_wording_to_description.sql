-- A requirement of an external standard whose wording sits in its title, with no description (official_text), is
-- stored the way the rest are: the wording becomes the description and the code becomes the title. A sentence, or more
-- than 60 characters, is wording, not a title. The importer applies the same rule (splitTitleAndText).
-- Only versions still being edited are corrected: published and retired versions are frozen (PRD 6.9). A new version
-- started from one of them gets the same correction when it is copied (newVersionFrom).
UPDATE requirement r
SET official_text = btrim(r.title), title = r.code
FROM framework_version fv
JOIN framework f ON f.id = fv.framework_id
WHERE fv.id = r.framework_version_id
  AND fv.status IN ('draft', 'in_review')
  AND NOT f.internal
  AND coalesce(btrim(r.official_text), '') = ''
  AND (char_length(btrim(r.title)) > 60 OR btrim(r.title) ~ '[.!?؟]\s*$');
