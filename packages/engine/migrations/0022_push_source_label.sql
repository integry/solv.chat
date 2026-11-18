-- Named push sources: `solv push --source <label>` writes to, and prunes, its
-- own push source, so two repositories pushing into one assistant never
-- delete each other's documents. At most one per label per assistant, so two
-- first pushes racing each other converge on one row. The default push source
-- (is_default = 1, used when a push names no source) is unaffected.
--
-- Earlier schemas allowed several non-default push sources with one label.
-- Before the index, the oldest of each such group keeps its label and every
-- later one gets its own id appended ("Docs (src_...)"). An existing label can
-- already read like such a replacement ("Docs (src_b)"), so a row whose label
-- equals a replacement is renamed the same way, and so on until nothing
-- collides. Replacements cannot collide with each other (ids are unique and
-- contain no " ("), and every row that keeps its label has one nothing else
-- has. Rows are renamed, never merged or removed, so source ids and the
-- documents that belong to them are unchanged.
WITH RECURSIVE renamed(id) AS (
  SELECT id FROM sources
  WHERE kind = 'push' AND is_default = 0
    AND EXISTS (
      SELECT 1 FROM sources AS older
      WHERE older.org_id = sources.org_id
        AND older.assistant_id = sources.assistant_id
        AND older.kind = 'push' AND older.is_default = 0
        AND older.label = sources.label
        AND (older.created_at < sources.created_at
          OR (older.created_at = sources.created_at AND older.id < sources.id))
    )
  UNION
  SELECT taken.id
  FROM renamed
  JOIN sources AS moved ON moved.id = renamed.id
  JOIN sources AS taken
    ON taken.org_id = moved.org_id
    AND taken.assistant_id = moved.assistant_id
    AND taken.kind = 'push' AND taken.is_default = 0
    AND taken.label = moved.label || ' (' || moved.id || ')'
)
UPDATE sources
  SET label = label || ' (' || id || ')'
  WHERE id IN (SELECT id FROM renamed);

CREATE UNIQUE INDEX sources_push_label
  ON sources(org_id, assistant_id, label)
  WHERE kind = 'push' AND is_default = 0;
