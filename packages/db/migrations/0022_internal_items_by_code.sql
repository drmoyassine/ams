-- In the internal framework an item's place follows its code: 1.2 is a sub-standard of standard 1. Items added at the
-- top level with a code like 1.2 before that rule are moved under their standard, in draft versions only (published
-- versions are frozen and stay as they were).
UPDATE requirement r
SET parent_id = p.id,
    level_label = COALESCE(v.level_labels->>1, 'Sub-standard')
FROM requirement p, framework_version v, framework f
WHERE r.framework_version_id = v.id AND v.framework_id = f.id AND f.internal AND v.status = 'draft'
  AND r.parent_id IS NULL AND r.code ~ '^[0-9]+\.[1-9][0-9]*$'
  AND p.framework_version_id = r.framework_version_id AND p.parent_id IS NULL AND p.code = split_part(r.code, '.', 1)
  AND NOT EXISTS (SELECT 1 FROM requirement c WHERE c.parent_id = r.id);
