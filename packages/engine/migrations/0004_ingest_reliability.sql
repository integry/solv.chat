-- Default push source uniqueness (F4): at most one default push source per
-- assistant, while allowing additional explicitly selected push sources.
ALTER TABLE sources ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));
CREATE UNIQUE INDEX sources_default_push
  ON sources(org_id, assistant_id)
  WHERE kind = 'push' AND is_default = 1;

-- Document revision and push-completion tracking (F1, F3).
ALTER TABLE documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN stored_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN enqueued_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN indexed_revision INTEGER NOT NULL DEFAULT 0;

-- Durable vector lifecycle tracking for consumer retries and cleanup (F2, F3).
CREATE TABLE pending_vectors (
  chunk_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id) ON DELETE CASCADE
);
CREATE INDEX pending_vectors_doc ON pending_vectors(org_id, document_id, revision, ordinal);

CREATE TABLE stale_vectors (
  chunk_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  document_id TEXT NOT NULL,
  FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id) ON DELETE CASCADE
);
CREATE INDEX stale_vectors_doc ON stale_vectors(org_id, document_id);
