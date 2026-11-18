-- Named push sources: `solv push --source <label>` writes to, and prunes, its
-- own push source, so two repositories pushing into one assistant never
-- delete each other's documents. At most one per label per assistant, so two
-- first pushes racing each other converge on one row. The default push source
-- (is_default = 1, used when a push names no source) is unaffected.
--
-- Earlier schemas allowed several non-default push sources with one label.
-- Before the index, the oldest of each such group keeps its label and every
-- later one gets its own id appended ("Docs (src_...)"), which no other row
-- can share. Rows are renamed, never merged or removed, so source ids and the
-- documents that belong to them are unchanged.
UPDATE sources
  SET label = label || ' (' || id || ')'
  WHERE kind = 'push' AND is_default = 0
    AND EXISTS (
      SELECT 1 FROM sources AS older
      WHERE older.org_id = sources.org_id
        AND older.assistant_id = sources.assistant_id
        AND older.kind = 'push' AND older.is_default = 0
        AND older.label = sources.label
        AND (older.created_at < sources.created_at
          OR (older.created_at = sources.created_at AND older.id < sources.id))
    );

CREATE UNIQUE INDEX sources_push_label
  ON sources(org_id, assistant_id, label)
  WHERE kind = 'push' AND is_default = 0;
