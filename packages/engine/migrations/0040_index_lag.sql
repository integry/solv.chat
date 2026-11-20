-- Answers while the vector index catches up (issue #131; see "Index lag"
-- in docs/architecture.md).
--
-- retired_chunks: the chunks a re-index or update replaced, kept for a
-- while after the commit that replaced them. Their vectors are deleted
-- after the new ones are written, and the index applies both later, so
-- for a while a search still returns the old vectors; this is the text a
-- hit on one of them finds. Deleted with the document, so a deleted
-- page's text is never read again. Rows older than the window are
-- skipped by every read and cleared by later commits of the same org.
CREATE TABLE retired_chunks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  document_id TEXT NOT NULL,
  text TEXT NOT NULL,
  heading_path TEXT NOT NULL DEFAULT '',
  retired_at INTEGER NOT NULL,
  FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id) ON DELETE CASCADE
);
CREATE INDEX retired_chunks_age ON retired_chunks(org_id, retired_at);
CREATE INDEX retired_chunks_document ON retired_chunks(org_id, document_id);

-- When the assistant's searchable content last changed: chunks committed
-- with new vectors, documents deleted, or a Rebuild queued. The admin's
-- "recent changes can take a few minutes" notice reads it. NULL: never.
ALTER TABLE assistants ADD COLUMN content_changed_at INTEGER;
