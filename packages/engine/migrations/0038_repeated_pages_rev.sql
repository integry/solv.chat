-- Fences the store of a source's repeated blocks against changes to the
-- pages they were counted from (issue #127; see "Repeated blocks" in
-- docs/architecture.md).
--
-- sources.repeated_pages_rev: counts the changes to the source's counted
-- pages: a page committed with its blocks (`documents.repeated_key` is
-- written in the batch that replaces its `document_blocks`) and a page
-- deleted (its `document_blocks` go with it). A reconciliation reads it with
-- the stored set, before it counts, and stores a changed set only if it is
-- still the same, so a set worked out from counts that a commit or a
-- removal changed in between is never stored over that change: the
-- reconciliation counts again. A commit that leaves the set as it is
-- changes only this counter, which the set's own compare-and-set cannot see.
ALTER TABLE sources ADD COLUMN repeated_pages_rev INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER documents_repeated_pages_update AFTER UPDATE OF repeated_key ON documents
BEGIN
  UPDATE sources SET repeated_pages_rev = repeated_pages_rev + 1
   WHERE org_id = NEW.org_id AND id = NEW.source_id;
END;

CREATE TRIGGER documents_repeated_pages_delete AFTER DELETE ON documents
BEGIN
  UPDATE sources SET repeated_pages_rev = repeated_pages_rev + 1
   WHERE org_id = OLD.org_id AND id = OLD.source_id;
END;
