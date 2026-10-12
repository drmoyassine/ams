-- An external standard's requirement that shows only its code as the title ("1-1-1") takes the accreditor's statement
-- (its description, official_text) as the title, when the statement fits a title (300 characters or fewer). Longer text
-- stays in the description. Migration 0034 had moved wording the other way; the rule is now placeWording() in the
-- importer (and when a version is copied). Only versions still being edited are corrected: published and retired
-- versions are frozen (PRD 6.9); a new version started from one gets the same correction when it is copied.
UPDATE requirement r
SET title = btrim(r.official_text), official_text = NULL
FROM framework_version fv
JOIN framework f ON f.id = fv.framework_id
WHERE fv.id = r.framework_version_id
  AND fv.status IN ('draft', 'in_review')
  AND NOT f.internal
  AND coalesce(btrim(r.official_text), '') <> ''
  AND char_length(btrim(r.official_text)) <= 300
  AND lower(regexp_replace(r.title, '\s', '', 'g')) = lower(regexp_replace(r.code, '\s', '', 'g'));
